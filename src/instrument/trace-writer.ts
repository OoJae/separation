import type { SemanticEvent } from "@mozaik-ai/core"
import type { TrackRecord, WorldSnapshot } from "../domain/airspace/observations"
import { EventType } from "../events/event-types"
import { WorldEvent } from "../events/world-events"
import { ControllerEvent } from "../participants/controller/tools"
import { PilotEvent } from "../participants/pilot"
import { StandingEvent } from "../participants/standing-broker"
import type { Clock } from "../support/ports"

/**
 * Records what a VIEWER needs, which is not what RETRACE needs.
 *
 * The Recorder's tape carries type, producer, seq and loopId and no payloads — deliberately, since
 * its job is a schedule tape and a payload-free tape is cheap to permute and diff. Widening it to
 * carry positions would make it worse at its actual job. So this is a separate instrument with a
 * separate purpose: reconstruct what happened well enough to draw it.
 *
 * The turn spans are the important part. A bar per participant, spanning open to close, is the
 * whole thesis as a picture: WHEN TWO BARS OVERLAP, TWO AGENTS WERE THINKING AT THE SAME TIME.
 * That must be a truthful readout of turn.started / turn.ended rather than a drawing that
 * illustrates the claim — which is why the overlap is asserted in tests, not eyeballed in a canvas.
 */
export type TraceFrame = {
	readonly tSim: number
	readonly generation: number
	readonly tracks: readonly TrackRecord[]
}

export type TraceTurn = {
	readonly participant: string
	readonly turnId: string
	readonly openedS: number
	readonly closedS: number | null
	readonly reason: string | null
}

export type TraceEvent = {
	readonly seq: number
	readonly tSim: number
	readonly type: string
	readonly producer: string
	readonly summary: string
}

/** A narrative moment. These are what the viewer highlights and what a demo pauses on. */
export type TraceBeat = {
	readonly tSim: number
	readonly kind: "intent" | "objection" | "held" | "narrowed" | "refused" | "loss" | "disclosure"
	readonly text: string
	/**
	 * For a narrowing: what was proposed, what actually executed, and why.
	 *
	 * The rewrite IS the claim this project makes, and it cannot be shown from two clearance names.
	 * Carrying the commands means the viewer renders real data rather than a caption.
	 */
	readonly diff?: {
		readonly from: string
		readonly to: string
		readonly because: string
	}
}

export type Trace = {
	readonly meta: {
		readonly scenario: string
		readonly arm: string
		readonly generatedAtTSim: number
		readonly frames: number
		readonly turns: number
		readonly events: number
	}
	readonly frames: readonly TraceFrame[]
	readonly turns: readonly TraceTurn[]
	readonly events: readonly TraceEvent[]
	readonly beats: readonly TraceBeat[]
}

type Payload = Record<string, unknown>
const str = (v: unknown): string => (typeof v === "string" ? v : String(v ?? ""))

export class TraceWriter {
	private readonly frames: TraceFrame[] = []
	private readonly open = new Map<string, { participant: string; openedS: number }>()
	private readonly turns: TraceTurn[] = []
	private readonly events: TraceEvent[] = []
	private readonly beats: TraceBeat[] = []

	/** Sim seconds when the scenario supplies them; elapsed real seconds otherwise. Never epoch. */
	private nowTSim(): number {
		if (this.deps.simSeconds !== undefined) return this.deps.simSeconds()
		return (this.deps.clock.nowMs() - this.originMs) / 1000
	}

	private readonly originMs: number

	constructor(
		private readonly deps: {
			readonly clock: Clock
			/**
			 * Simulation time NOW, in seconds — the same axis `world.snapshot` stamps its frames on.
			 *
			 * Without it every event, beat and turn span was stamped with `clock.nowMs()`, which
			 * under a wall clock is EPOCH milliseconds. The trace then carried frames on 1..380 and
			 * everything else on ~1.79e12, in a field both call `tSim`. The viewer scrubs the frame
			 * axis, so the event log, the narrative beats and the in-flight strip could never line
			 * up with the radar picture — the one thing the strip exists to show.
			 *
			 * Optional so the substrate tests that construct a writer with no world still work; they
			 * fall back to elapsed real seconds, which for them is the same thing.
			 */
			readonly simSeconds?: () => number
			readonly nameOf: (id: string) => string
			readonly scenario: string
			readonly arm?: string
		},
	) {
		this.originMs = deps.clock.nowMs()
	}

	/** Feed every observed event here. Synchronous and never throws (house rule, finding #15). */
	observe(event: SemanticEvent): void {
		const p = (event.payload ?? {}) as Payload
		const tSim = this.nowTSim()
		const producer = this.deps.nameOf(event.producerId)
		const seq = typeof p.seq === "number" ? p.seq : this.events.length + 1

		if (event.type === WorldEvent.SNAPSHOT) {
			const snapshot = p as unknown as WorldSnapshot
			this.frames.push({ tSim: snapshot.tSim, generation: snapshot.generation, tracks: snapshot.tracks })
		}

		if (event.type === EventType.TURN_STARTED) {
			this.open.set(str(p.turnId), { participant: str(p.agentName), openedS: tSim })
		}
		if (event.type === EventType.TURN_ENDED) {
			const turnId = str(p.turnId)
			const opened = this.open.get(turnId)
			if (opened) {
				this.turns.push({
					participant: opened.participant, turnId,
					openedS: opened.openedS, closedS: tSim, reason: str(p.reason) || null,
				})
				this.open.delete(turnId)
			}
		}

		this.events.push({ seq, tSim, type: event.type, producer, summary: summarise(event.type, p) })

		const beat = beatFor(event.type, p, tSim)
		if (beat) this.beats.push(beat)
	}

	/** Close any turn still open, so the strip has no dangling bars. */
	finish(): Trace {
		const tSim = this.nowTSim()
		for (const [turnId, opened] of this.open) {
			this.turns.push({
				participant: opened.participant, turnId,
				openedS: opened.openedS, closedS: null, reason: "still open at end of run",
			})
		}
		this.open.clear()

		return {
			meta: {
				scenario: this.deps.scenario,
				arm: this.deps.arm ?? "full",
				generatedAtTSim: tSim,
				frames: this.frames.length,
				turns: this.turns.length,
				events: this.events.length,
			},
			frames: this.frames,
			turns: [...this.turns].sort((a, b) => a.openedS - b.openedS),
			events: this.events,
			beats: this.beats,
		}
	}

	/**
	 * Turn pairs that were open at the same instant. THE claim, computed rather than drawn.
	 *
	 * A turn still open when the run ended is treated as closing AT the end of the run, never as
	 * open forever — otherwise an unfinished turn would report an infinite overlap and the headline
	 * number would be a measurement artefact rather than a fact about the run.
	 */
	static overlaps(trace: Trace): { readonly a: TraceTurn; readonly b: TraceTurn; readonly seconds: number }[] {
		const out: { a: TraceTurn; b: TraceTurn; seconds: number }[] = []
		const endOfRun = Math.max(
			trace.meta.generatedAtTSim,
			...trace.turns.map((t) => t.closedS ?? t.openedS),
		)
		const closed = (t: TraceTurn) => t.closedS ?? endOfRun
		for (let i = 0; i < trace.turns.length; i++) {
			for (let j = i + 1; j < trace.turns.length; j++) {
				const a = trace.turns[i]!
				const b = trace.turns[j]!
				if (a.participant === b.participant) continue
				const start = Math.max(a.openedS, b.openedS)
				const end = Math.min(closed(a), closed(b))
				if (end > start) out.push({ a, b, seconds: end - start })
			}
		}
		return out
	}
}

function summarise(type: string, p: Payload): string {
	switch (type) {
		case ControllerEvent.INTENT_FORMING:
			return `${str(p.controller)} → ${str(p.callsign)} (${str(p.clearanceId)})`
		case ControllerEvent.OBJECTION_RAISED:
			return `${str(p.by)} objects to ${str(p.against)}: ${str(p.reason)}`
		case PilotEvent.QUERY:
			return `${str(p.fromController)} asks ${str(p.toCallsign)}`
		case PilotEvent.UNABLE:
			return `${str(p.callsign)} unable: ${str(p.reason)}`
		case StandingEvent.GRANTED:
			return `${str(p.controller)} holds ${str(p.callsign)}/${str(p.objective)}`
		case StandingEvent.DENIED:
			return `${str(p.controller)} denied ${str(p.callsign)}: ${str(p.reason)}`
		case WorldEvent.SEPARATION_LOST:
			return `${str(p.a)} / ${str(p.b)} — ${Number(p.rangeNm ?? 0).toFixed(2)} NM`
		default:
			return str(p.turnId ?? p.callsign ?? p.reason ?? "")
	}
}

function beatFor(type: string, p: Payload, tSim: number): TraceBeat | null {
	if (type === ControllerEvent.INTENT_FORMING) {
		return { tSim, kind: "intent", text: `${str(p.controller)} is forming a clearance for ${str(p.callsign)}` }
	}
	if (type === ControllerEvent.OBJECTION_RAISED) {
		return { tSim, kind: "objection", text: `${str(p.by)} objects to ${str(p.against)} — ${str(p.reason)}` }
	}
	if (type === PilotEvent.UNABLE) {
		return { tSim, kind: "refused", text: `${str(p.callsign)} is unable: ${str(p.reason)}` }
	}
	if (type === PilotEvent.REPLY) {
		return { tSim, kind: "disclosure", text: `${str(p.callsign)} discloses: ${str(p.text).slice(0, 90)}` }
	}
	if (type === WorldEvent.SEPARATION_LOST) {
		return { tSim, kind: "loss", text: `separation lost: ${str(p.a)} / ${str(p.b)}` }
	}
	if (type === WorldEvent.COMMAND_ACCEPTED && typeof p.event === "string") {
		const kind = p.event === "interlock.narrowed" ? "narrowed" : "held"
		const text = p.event === "interlock.narrowed"
			? `the desk narrowed ${str(p.from)} → ${str(p.to)}`
			: `the desk is holding ${str(p.clearanceId)} (${str(p.pendingSetSize)} in the airlock)`
		if (kind === "narrowed" && typeof p.fromCommand === "string" && typeof p.toCommand === "string") {
			return { tSim, kind, text, diff: { from: p.fromCommand, to: p.toCommand, because: str(p.because) } }
		}
		return { tSim, kind, text }
	}
	return null
}
