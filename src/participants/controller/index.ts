import { SituationSpecification, createAgent } from "@mozaik-ai/core"
import type { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core"
import type { Callsign } from "../../domain/airspace/aircraft-state"
import type { OutboxDispatcher } from "../../support/outbox"
import { EventType } from "../../events/event-types"
import { PilotEvent, type UnablePayload } from "../../events/pilot-events"
import { ControllerEvent, controllerTools, type ControllerToolDeps } from "./tools"

export type ObjectionPayload = {
	readonly by: string
	readonly against: string
	readonly clearanceId: string
	readonly callsign: Callsign
	readonly reason: string
	/** The objector's counter-proposal, if it has one. The desk prefers it when it is safe. */
	readonly suggestTargetAltFt?: number
}

export type ControllerDeps = ControllerToolDeps & {
	readonly instruction: string
	/** Does this controller hold standing over the callsign? Overlap is what enables objection. */
	readonly holdsStandingOver: (callsign: Callsign) => boolean
	/** The objection policy — deterministic in Phase 4's synthetic tests, a live model later. */
	readonly objectTo: (intent: { callsign: Callsign; command: Record<string, number>; plannedMarginNm: number; by: string }) =>
		{ reason: string; suggestTargetAltFt?: number } | null
	/**
	 * Begin a fresh turn for this controller. Supplied by the TurnScheduler.
	 *
	 * Optional so the many synthetic tests that never issue a clearance need not wire it; when it
	 * is absent a refusal is still observed and counted, it just cannot trigger a re-plan.
	 *
	 * Returns whether a turn actually STARTED. The scheduler enforces one in-flight turn per agent,
	 * and a refusal necessarily arrives while the controller's own turn is still open — the desk
	 * issues the clearance before releasing the commit. So the first attempt is always refused, and
	 * a re-plan that is merely ATTEMPTED is a re-plan that never happens.
	 */
	readonly beginTurn?: (agent: Agent, message: string) => boolean
}

/**
 * A controller. Three of these hold OVERLAPPING standing over the same aircraft under different
 * objectives, which is what puts two language models on one callsign at the same time.
 *
 * The situation handler is the other half of the money shot: it reacts to a PEER's
 * `intent.forming` — published from inside the peer's tool, while the peer's turn is still open —
 * and raises an objection that the interlock desk turns into narrowed arguments.
 */
export function createController(deps: ControllerDeps): Agent {
	let self: Agent | null = null
	let pendingReplan: string | null = null
	/**
	 * Clearance ids THIS controller proposed, and how many times a refusal has already made it
	 * re-plan.
	 *
	 * `pilot.unable` carries a callsign and a clearance id but no addressee, and every controller in
	 * these scenarios holds standing over the principal aircraft — so without ownership every
	 * controller was told "UNABLE your clearance" for a clearance it had never issued, and all of
	 * them re-planned. The budget is the other half: a refusal that provokes a re-plan that is
	 * refused again is a livelock, and each iteration actuates the world.
	 */
	const mine = new Set<string>()
	const replansByClearance = new Map<string, number>()
	const REPLAN_BUDGET = 2

	class WhenPeerFormsIntent extends SituationSpecification {
		isSatisfiedBy({ event, participant }: SituationContext): boolean {
			if (event.type !== ControllerEvent.INTENT_FORMING) return false
			if (event.producerId === participant.getId()) return false // never object to yourself
			const payload = event.payload as { callsign?: string }
			return typeof payload.callsign === "string" && deps.holdsStandingOver(payload.callsign)
		}
	}

	const objectHandler: SituationHandler = {
		specification: new WhenPeerFormsIntent(),
		processor: {
			apply({ event }) {
				// Synchronous, never throws — a throwing processor starves the bus (API-NOTES #15).
				const payload = event.payload as {
					controller: string; callsign: Callsign; clearanceId: string;
					command: Record<string, number>; plannedMarginNm: number
				}
				const objection = deps.objectTo({
					callsign: payload.callsign, command: payload.command,
					plannedMarginNm: payload.plannedMarginNm, by: payload.controller,
				})
				if (objection === null || self === null) return
				const out: ObjectionPayload = {
					by: deps.position, against: payload.controller,
					clearanceId: payload.clearanceId, callsign: payload.callsign,
					reason: objection.reason, suggestTargetAltFt: objection.suggestTargetAltFt,
				}
				deps.outbox.publish(ControllerEvent.OBJECTION_RAISED, self.getId(), out)
			},
		},
	}

	/**
	 * A pilot refused a clearance this controller holds standing over.
	 *
	 * THIS IS WHAT MAKES GUESSING EXPENSIVE. `pilot.unable` had exactly two consumers before —
	 * both of them display code — so a crew could refuse a clearance and no controller would ever
	 * learn of it. A refusal was, in the running system, indistinguishable from acceptance.
	 *
	 * Now it costs a whole turn: the controller must plan again, having already spent the window
	 * on a clearance that will not be flown. That is the measured alternative to spending ~13 s
	 * asking first, and it is why `query_pilot` is a judgement rather than a flourish.
	 */
	class WhenPilotRefuses extends SituationSpecification {
		isSatisfiedBy({ event }: SituationContext): boolean {
			if (event.type !== PilotEvent.UNABLE) return false
			const payload = event.payload as { callsign?: string; clearanceId?: string }
			if (typeof payload.callsign !== "string" || !deps.holdsStandingOver(payload.callsign)) return false
			// Only the controller that ISSUED the clearance is the one being refused.
			if (typeof payload.clearanceId !== "string" || !mine.has(payload.clearanceId)) return false
			return (replansByClearance.get(payload.clearanceId) ?? 0) < REPLAN_BUDGET
		}
	}

	const refusalHandler: SituationHandler = {
		specification: new WhenPilotRefuses(),
		processor: {
			// Synchronous and never throws — a throwing processor starves the bus (#15).
			apply({ event }) {
				if (self === null || deps.beginTurn === undefined) return
				const p = event.payload as Partial<UnablePayload>
				if (typeof p.callsign !== "string" || typeof p.reason !== "string") return
				const message = [
					`${p.callsign} is UNABLE your clearance ${p.clearanceId ?? ""}: "${p.reason}".`,
					p.counterProposal ? `They propose instead: ${p.counterProposal}.` : ``,
					``,
					`That clearance will not be flown, and the window you spent on it is gone. Plan`,
					`again. You may query_pilot ${p.callsign} first if their constraint is not obvious.`,
				].filter((l) => l !== ``).join("\n")
				// Almost always refused here: this controller's own turn is still open, because the
				// desk issues the clearance before it releases the commit. Hold it and start the
				// moment that turn closes.
				replansByClearance.set(p.clearanceId ?? "", (replansByClearance.get(p.clearanceId ?? "") ?? 0) + 1)
				if (!deps.beginTurn(self, message)) pendingReplan = message
			},
		},
	}

	/**
	 * A refusal that arrived while this controller was still mid-turn. Started the instant its own
	 * turn closes — that deferral IS the cost of guessing, one whole turn of ~12-17 s.
	 */
	class WhenOwnTurnEnds extends SituationSpecification {
		isSatisfiedBy({ event, participant }: SituationContext): boolean {
			return event.type === EventType.TURN_ENDED
				&& event.producerId === participant.getId()
				&& pendingReplan !== null
		}
	}

	const replanHandler: SituationHandler = {
		specification: new WhenOwnTurnEnds(),
		processor: {
			apply() {
				if (self === null || deps.beginTurn === undefined || pendingReplan === null) return
				const message = pendingReplan
				pendingReplan = null
				deps.beginTurn(self, message)
			},
		},
	}

	/** Remember what this controller announced, so a refusal can be addressed to its author. */
	class WhenIAnnounce extends SituationSpecification {
		isSatisfiedBy({ event, participant }: SituationContext): boolean {
			return event.type === ControllerEvent.INTENT_FORMING
				&& event.producerId === participant.getId()
		}
	}

	const ownershipHandler: SituationHandler = {
		specification: new WhenIAnnounce(),
		processor: {
			apply({ event }) {
				const id = (event.payload as { clearanceId?: string }).clearanceId
				if (typeof id === "string") mine.add(id)
			},
		},
	}

	self = createAgent({
		name: deps.position,
		capabilities: ["inference", "standing"],
		instruction: deps.instruction,
		tools: controllerTools(deps),
		handlers: [objectHandler, ownershipHandler, refusalHandler, replanHandler],
	})
	return self
}

export { ControllerEvent }
