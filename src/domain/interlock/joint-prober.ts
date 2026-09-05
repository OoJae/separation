import type { AircraftState, Callsign } from "../airspace/aircraft-state"
import { flyEncounter, type Interval, type PendingClearance } from "../airspace/encounter"
import { madeIt, missedByMs, type ManeuverWindow } from "../airspace/maneuver-window"
import { secondsToTick, tickToSeconds } from "../airspace/units"

export type JointHazard = {
	/** The clearances that are JOINTLY responsible — none of them causes it alone. */
	readonly clearanceIds: readonly string[]
	readonly callsigns: readonly [Callsign, Callsign]
	readonly minHorizontalNm: number
	readonly verticalAtMinFt: number
	readonly loss: Interval
	readonly lossSeconds: number
}

export type ExcludedClearance = {
	readonly clearanceId: string
	readonly reason: "window-closed"
	readonly missedByMs: number
}

export type JointVerdict = {
	readonly evaluatedAtMs: number
	readonly considered: readonly string[]
	readonly hazards: readonly JointHazard[]
	readonly excluded: readonly ExcludedClearance[]
}

export type JointProbeRequest = {
	readonly world: readonly AircraftState[]
	/** Clearances FORMED but not necessarily committed — the whole point of this prober. */
	readonly pending: readonly PendingClearance[]
	/** clearanceId -> the window it must be committed inside. */
	readonly windows: ReadonlyMap<string, ManeuverWindow>
	/**
	 * Sim-time at which this evaluation happens. Stamped on the verdict, and nothing else.
	 *
	 * It deliberately does NOT decide which windows are open: each clearance already carries the
	 * instant it was committed, and that is what its window is tested against. See the note on
	 * evaluateJoint.
	 */
	readonly atMs: number
	/**
	 * Sim-time that the `world` snapshot describes. Defaults to 0 (the scenario start).
	 *
	 * flyEncounter always integrates from tick 0 using the states it is handed, so a clearance's
	 * absolute committedTick/effectiveTick only mean anything relative to this instant. Passing a
	 * world advanced to `now` together with ticks measured from scenario start is a clock mismatch,
	 * so the origin is named here rather than assumed.
	 */
	readonly worldAtMs?: number
	readonly horizonSec: number
}

/**
 * The JointProber.
 *
 * It takes a `pending` parameter, and the FeasibilityProber structurally does not (grep-enforced
 * in `tests/substrate/invariants.test.ts`). That difference is the point: one asks "is this
 * manoeuvre safe against the world as flown", the other asks "are these half-formed intentions
 * safe TOGETHER". Keeping the signatures distinct is what stops the second quietly becoming a
 * flag on the first.
 *
 * A clearance whose window had already shut when it was committed is EXCLUDED rather than
 * evaluated. That is not bookkeeping — it is the theorem. A serialized system reaches its second
 * decision after the other aircraft's window has closed, so it has no candidate left to find a
 * hazard against. It does not fail to see the hazard; it arrives too late for the hazard to be
 * actionable.
 *
 * ONE CLOCK. Both halves of that argument — "is this window still open" and "do these clearances
 * collide" — are evaluated at the same instant, and the instant comes from the clearances
 * themselves. An earlier version spent a caller-supplied `atMs` against the windows and then flew
 * the geometry from clearances baked at t=0, so it could report a hazard at a commit time where
 * the aircraft are in fact legally separated. The fix is not to thread `atMs` into the geometry
 * but to delete the second clock: a clearance carries when it was committed, and that single fact
 * drives both tests. The mismatch is now unrepresentable rather than merely absent.
 */
export function evaluateJoint(request: JointProbeRequest): JointVerdict {
	const excluded: ExcludedClearance[] = []
	const live: PendingClearance[] = []

	const worldAtMs = request.worldAtMs ?? 0

	for (const clearance of request.pending) {
		const window = request.windows.get(clearance.id)
		const committedAtMs = tickToSeconds(clearance.committedTick) * 1000
		if (window !== undefined && !madeIt(window, committedAtMs)) {
			excluded.push({
				clearanceId: clearance.id,
				reason: "window-closed",
				missedByMs: missedByMs(window, committedAtMs),
			})
			continue
		}
		live.push(clearance)
	}

	return {
		evaluatedAtMs: request.atMs,
		considered: live.map((c) => c.id).sort(),
		hazards: findJointHazards(request.world, live.map((c) => rebaseOnto(c, worldAtMs)), request.horizonSec),
		excluded: excluded.sort((a, b) => (a.clearanceId < b.clearanceId ? -1 : 1)),
	}
}

/**
 * Re-express a clearance's absolute ticks relative to the instant the world snapshot describes.
 *
 * A clearance committed 5 s before the snapshot is already 5 s into its command lag, so it bites
 * sooner; one committed at the snapshot instant still owes the full lag. Clamping at zero means a
 * clearance already in effect is flown from the first tick, which is what "already in effect" means.
 */
function rebaseOnto(clearance: PendingClearance, worldAtMs: number): PendingClearance {
	if (worldAtMs === 0) return clearance
	const shift = secondsToTick(worldAtMs / 1000)
	return {
		...clearance,
		committedTick: Math.max(0, clearance.committedTick - shift),
		effectiveTick: Math.max(0, clearance.effectiveTick - shift),
	}
}

/**
 * A hazard is JOINT when the whole set loses separation but no proper subset does.
 *
 * That test is what makes "joint" mean something. Reporting any loss found while several
 * clearances are pending would also flag a clearance that is simply unsafe on its own, and the
 * distinction between "this one is bad" and "these two are bad together" is the entire thesis.
 */
export function findJointHazards(
	world: readonly AircraftState[],
	pending: readonly PendingClearance[],
	horizonSec: number,
): JointHazard[] {
	if (pending.length < 2) return []

	const hazards: JointHazard[] = []
	for (let i = 0; i < world.length; i++) {
		for (let j = i + 1; j < world.length; j++) {
			const pair = [world[i]!, world[j]!] as const
			const relevant = pending.filter((c) => c.callsign === pair[0].callsign || c.callsign === pair[1].callsign)
			if (relevant.length < 2) continue

			const together = flyEncounter(pair, relevant, horizonSec)
			if (together.loss === null) continue

			// Does any proper subset already lose separation? If so this is not a JOINT hazard —
			// one of these clearances is simply unsafe, which is a different finding.
			const anySubsetUnsafe = relevant.some((dropped) => {
				const subset = relevant.filter((c) => c.id !== dropped.id)
				return flyEncounter(pair, subset, horizonSec).loss !== null
			})
			if (anySubsetUnsafe) continue

			hazards.push({
				clearanceIds: relevant.map((c) => c.id).sort(),
				callsigns: [pair[0].callsign, pair[1].callsign],
				minHorizontalNm: together.minHorizontalNm,
				verticalAtMinFt: together.verticalAtMinFt,
				loss: together.loss,
				lossSeconds: together.lossSeconds,
			})
		}
	}
	return hazards
}

/**
 * The narrowing the InterlockDesk applies: the least restrictive alternative that clears the
 * joint hazard while keeping the clearance useful.
 *
 * Returning "denied" would make the airlock a veto with extra steps. It searches the candidates
 * in order of decreasing usefulness and takes the first that is safe, so the aircraft still gets
 * a real clearance rather than a refusal.
 */
export function narrowToSafe(params: {
	readonly world: readonly AircraftState[]
	readonly others: readonly PendingClearance[]
	readonly subject: PendingClearance
	readonly candidates: readonly PendingClearance[]
	readonly horizonSec: number
}): PendingClearance | null {
	for (const candidate of params.candidates) {
		const hazards = findJointHazards(params.world, [...params.others, candidate], params.horizonSec)
		if (hazards.length === 0) return candidate
	}
	return null
}
