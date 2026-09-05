import type { SemanticEvent } from "@mozaik-ai/core"
import { StandingEvent } from "../participants/standing-broker"
import { WorldEvent } from "../events/world-events"

/**
 * What a violation IS.
 *
 * Each of these is a property the architecture claims in prose somewhere. Writing them as
 * checkable predicates is what turns "we believe the airlock is fair" into something a schedule
 * explorer can falsify.
 */
export type Violation = {
	readonly invariant: string
	readonly detail: string
	/** Event seqs implicating the violation, for the shrinker to aim at. */
	readonly witness: readonly number[]
}

export type RunObservation = {
	readonly events: readonly SemanticEvent[]
	/** turnId -> ms of settle actually granted before adjudication. */
	readonly settleGranted: ReadonlyMap<string, number>
	readonly settleRequiredMs: number
	readonly pendingAtEnd: number
}

type Payload = Record<string, unknown>
const seqOf = (e: SemanticEvent) => Number((e.payload as Payload).seq ?? 0)

/**
 * Every bid is answered.
 *
 * The broker announces every grant AND every denial — "whatever a boundary enforces, it must also
 * announce". A bid that produces neither leaves its bidder waiting on a reply that will never come,
 * which in a system where silence is read as consent is the worst possible failure.
 */
export function everyBidIsAnswered(obs: RunObservation): Violation[] {
	const asked = new Map<string, SemanticEvent>()
	const answered = new Set<string>()

	for (const event of obs.events) {
		const p = event.payload as Payload
		const key = `${String(p.controller)}|${String(p.callsign)}|${String(p.objective)}`
		if (event.type === StandingEvent.BID) asked.set(key, event)
		if (event.type === StandingEvent.GRANTED || event.type === StandingEvent.DENIED) answered.add(key)
	}

	const out: Violation[] = []
	for (const [key, event] of asked) {
		if (answered.has(key)) continue
		out.push({
			invariant: "every-bid-is-answered",
			detail: `bid ${key} received neither standing.granted nor standing.denied — the bidder waits forever`,
			witness: [seqOf(event)],
		})
	}
	return out
}

/**
 * Every held commit gets its full settle window.
 *
 * The airlock's promise is that a commit is held long enough for a peer's objection to arrive. A
 * commit adjudicated early got less protection than the design offers — silently, and precisely
 * when the sector is busiest, which is when a peer is most likely to object.
 */
export function everyHoldGetsItsSettle(obs: RunObservation): Violation[] {
	const out: Violation[] = []
	for (const [turnId, granted] of obs.settleGranted) {
		if (granted >= obs.settleRequiredMs) continue
		out.push({
			invariant: "every-hold-gets-its-settle",
			detail: `${turnId} was adjudicated after ${granted}ms of a promised ${obs.settleRequiredMs}ms settle window — ${obs.settleRequiredMs - granted}ms of objection opportunity lost`,
			witness: [],
		})
	}
	return out
}

/** Quiescence: nothing may be left half-committed when the run ends. */
export function pendingSetEmpties(obs: RunObservation): Violation[] {
	if (obs.pendingAtEnd === 0) return []
	return [{
		invariant: "pending-set-empties",
		detail: `${obs.pendingAtEnd} commit(s) still held at end of run — quiescence never reached`,
		witness: [],
	}]
}

/** A rejected CAS must be announced, never silently swallowed. */
export function casRejectionsAreAnnounced(obs: RunObservation): Violation[] {
	const rejections = obs.events.filter((e) => e.type === "cas.rejected")
	const denials = obs.events.filter((e) => e.type === StandingEvent.DENIED)
	if (rejections.length === 0) return []
	if (denials.length >= rejections.length) return []
	return [{
		invariant: "cas-rejections-are-announced",
		detail: `${rejections.length} cas.rejected but only ${denials.length} standing.denied — a losing writer was not told`,
		witness: rejections.map(seqOf),
	}]
}

export const ALL_INVARIANTS = [
	everyBidIsAnswered,
	everyHoldGetsItsSettle,
	pendingSetEmpties,
	casRejectionsAreAnnounced,
] as const

export function checkAll(obs: RunObservation): Violation[] {
	return ALL_INVARIANTS.flatMap((check) => check(obs))
}

export { WorldEvent }
