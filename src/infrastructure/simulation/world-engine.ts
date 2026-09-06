import {
	horizontalRangeSq, integrate, verticalSeparationFt,
	type AircraftState, type Callsign, type Command,
} from "../../domain/airspace/aircraft-state"
import { unitVector } from "../../domain/airspace/heading-table"
import { toTrackRecord, type PairClosure, type WorldSnapshot } from "../../domain/airspace/observations"
import { isSeparationLost } from "../../domain/airspace/separation-standard"
import {
	CLOSURE_EVERY, INTEGRATE_EVERY, KT_TO_NM_PER_S, SNAPSHOT_EVERY, tickToSeconds, type Tick, isAdmissibleTurnRate } from "../../domain/airspace/units"

/**
 * The phases, in the ONE order they ever run. An ordered constant rather than a set, because on
 * a tick where several fall due the order decides what each of them sees.
 */
export const PHASE_ORDER = ["integrate", "closure", "reflex", "snapshot", "invariant"] as const
export type WorldPhase = (typeof PHASE_ORDER)[number]

export type SeparationLoss = {
	readonly a: Callsign
	readonly b: Callsign
	readonly rangeNm: number
	readonly verticalFt: number
	readonly tSim: number
}

export type TickOutput = {
	readonly tick: Tick
	readonly tSim: number
	readonly phases: readonly WorldPhase[]
	readonly closures: readonly PairClosure[]
	readonly snapshot: WorldSnapshot | null
	readonly losses: readonly SeparationLoss[]
}

export type CommandResult = { readonly ok: true } | { readonly ok: false; readonly reason: string }

/**
 * The mutable truth and the phase pipeline over it. No framework imports — a participant wraps
 * this and publishes whatever it returns.
 *
 * ONE master timer drives it. 20 Hz is not a subharmonic of 50 Hz, so three independent repeating
 * timers would collide every 100 ms and their firing order would depend on re-registration
 * insertion sequence. Integer modulus on a 10 ms tick removes the question entirely.
 */
export class WorldEngine {
	private readonly aircraft = new Map<Callsign, AircraftState>()
	private readonly commands = new Map<Callsign, Command>()
	private tick: Tick = 0
	private generation = 0
	/** Pairs currently in loss, so `losses` reports an EDGE rather than a level every tick. */
	private readonly inLoss = new Set<string>()

	private constructor(initial: readonly AircraftState[]) {
		for (const state of initial) this.aircraft.set(state.callsign, state)
	}

	static init(initial: readonly AircraftState[]): WorldEngine {
		return new WorldEngine(initial)
	}

	currentTick(): Tick {
		return this.tick
	}

	/** Sorted by callsign, so every derived list — closures, snapshots, traces — is order-stable. */
	states(): readonly AircraftState[] {
		return [...this.aircraft.values()].sort((a, b) => (a.callsign < b.callsign ? -1 : 1))
	}

	stateOf(callsign: Callsign): AircraftState | undefined {
		return this.aircraft.get(callsign)
	}

	/**
	 * Apply a command. Returns a rejection REASON rather than throwing: a situation processor may
	 * never throw (docs/API-NOTES.md #15 — it escapes into the publisher and starves every
	 * participant after it), so an invalid command must be a value the caller can announce.
	 */
	command(callsign: Callsign, command: Command): CommandResult {
		if (!this.aircraft.has(callsign)) return { ok: false, reason: `unknown callsign ${callsign}` }
		if (command.targetHeadingMdeg !== undefined && command.targetHeadingMdeg % 20 !== 0) {
			return { ok: false, reason: `heading ${command.targetHeadingMdeg} mdeg is off the 20 mdeg grid` }
		}
		if (command.targetAltFt !== undefined && !Number.isFinite(command.targetAltFt)) {
			return { ok: false, reason: "target altitude is not finite" }
		}
		// Speed was the one axis with no gate, and it is the dangerous one: a non-finite speed makes
		// x and y NaN, every comparison against NaN is false, and loss of separation stops being
		// detectable at all. A non-positive speed flies the aircraft backwards or freezes it.
		if (command.targetGroundspeedKt !== undefined
			&& (!Number.isFinite(command.targetGroundspeedKt) || command.targetGroundspeedKt <= 0)) {
			return { ok: false, reason: `groundspeed ${command.targetGroundspeedKt} kt is not a flyable speed` }
		}
		if (command.turnRateMdegPerS !== undefined && !isAdmissibleTurnRate(command.turnRateMdegPerS)) {
			return { ok: false, reason: `turn rate ${command.turnRateMdegPerS} mdeg/s does not divide the integration step` }
		}
		this.commands.set(callsign, { ...this.commands.get(callsign), ...command })
		return { ok: true }
	}

	commandOf(callsign: Callsign): Command | undefined {
		return this.commands.get(callsign)
	}

	/** Advance exactly one 10 ms master tick, running whichever phases fall due, in PHASE_ORDER. */
	step(): TickOutput {
		this.tick += 1
		const tick = this.tick
		const tSim = tickToSeconds(tick)
		const phases: WorldPhase[] = []
		let closures: readonly PairClosure[] = []
		let snapshot: WorldSnapshot | null = null
		const losses: SeparationLoss[] = []

		for (const phase of PHASE_ORDER) {
			if (!isDue(phase, tick)) continue
			phases.push(phase)

			if (phase === "integrate") {
				for (const [callsign, state] of this.aircraft) {
					this.aircraft.set(callsign, integrate(state, this.commands.get(callsign)))
				}
			} else if (phase === "closure") {
				closures = this.computeClosures(tSim)
			} else if (phase === "snapshot") {
				this.generation += 1
				snapshot = { generation: this.generation, tSim, tracks: this.states().map(toTrackRecord) }
			} else if (phase === "invariant") {
				losses.push(...this.detectLosses(tSim))
			}
			// "reflex" is a CONSUMER of `closures`, never a mutator of the world. It acts the way
			// everyone else does: take an actuator lease, then issue a command.
		}

		return { tick, tSim, phases, closures, snapshot, losses }
	}

	private computeClosures(tSim: number): PairClosure[] {
		const states = this.states()
		const out: PairClosure[] = []
		for (let i = 0; i < states.length; i++) {
			for (let j = i + 1; j < states.length; j++) {
				const a = states[i]!
				const b = states[j]!
				out.push({
					a: a.callsign,
					b: b.callsign,
					rangeSqNm2: horizontalRangeSq(a, b),
					closureRateNmPerSec: closureRate(a, b),
					verticalSeparationFt: verticalSeparationFt(a, b),
					verticalRateFtPerSec: verticalRate(a, b),
					tSim,
				})
			}
		}
		return out
	}

	private detectLosses(tSim: number): SeparationLoss[] {
		const states = this.states()
		const out: SeparationLoss[] = []
		for (let i = 0; i < states.length; i++) {
			for (let j = i + 1; j < states.length; j++) {
				const a = states[i]!
				const b = states[j]!
				const key = `${a.callsign}|${b.callsign}`
				const rangeSq = horizontalRangeSq(a, b)
				const vertical = verticalSeparationFt(a, b)
				if (isSeparationLost(rangeSq, vertical)) {
					if (!this.inLoss.has(key)) {
						this.inLoss.add(key)
						out.push({ a: a.callsign, b: b.callsign, rangeNm: Math.sqrt(rangeSq), verticalFt: vertical, tSim })
					}
				} else {
					this.inLoss.delete(key)
				}
			}
		}
		return out
	}
}

export function isDue(phase: WorldPhase, tick: Tick): boolean {
	if (phase === "integrate" || phase === "invariant") return tick % INTEGRATE_EVERY === 0
	if (phase === "closure" || phase === "reflex") return tick % CLOSURE_EVERY === 0
	return tick % SNAPSHOT_EVERY === 0
}

/** Signed range rate, NM/s. Negative is closing. Analytic — never finite-differenced. */
export function closureRate(a: AircraftState, b: AircraftState): number {
	const dx = a.x - b.x
	const dy = a.y - b.y
	const range = Math.sqrt(dx * dx + dy * dy)
	if (range === 0) return 0
	const va = unitVector(a.headingMdeg)
	const vb = unitVector(b.headingMdeg)
	const sa = a.groundspeedKt * KT_TO_NM_PER_S
	const sb = b.groundspeedKt * KT_TO_NM_PER_S
	const dvx = va.east * sa - vb.east * sb
	const dvy = va.north * sa - vb.north * sb
	return (dx * dvx + dy * dvy) / range
}

/** Signed rate of change of |Δaltitude|, ft/s. Negative means the gap is shrinking. */
export function verticalRate(a: AircraftState, b: AircraftState): number {
	const gap = a.altFt - b.altFt
	const rate = (a.verticalSpeedFpm - b.verticalSpeedFpm) / 60
	return gap === 0 ? -Math.abs(rate) : Math.sign(gap) * rate
}
