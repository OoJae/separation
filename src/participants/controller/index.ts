import { SituationSpecification, createAgent } from "@mozaik-ai/core"
import type { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core"
import type { Callsign } from "../../domain/airspace/aircraft-state"
import type { OutboxDispatcher } from "../../support/outbox"
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
	 */
	readonly beginTurn?: (agent: Agent, message: string) => void
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
			const payload = event.payload as { callsign?: string }
			return typeof payload.callsign === "string" && deps.holdsStandingOver(payload.callsign)
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
				deps.beginTurn(self, [
					`${p.callsign} is UNABLE your clearance ${p.clearanceId ?? ""}: "${p.reason}".`,
					p.counterProposal ? `They propose instead: ${p.counterProposal}.` : ``,
					``,
					`That clearance will not be flown, and the window you spent on it is gone. Plan`,
					`again. You may query_pilot ${p.callsign} first if their constraint is not obvious.`,
				].filter((l) => l !== ``).join("\n"))
			},
		},
	}

	self = createAgent({
		name: deps.position,
		capabilities: ["inference", "standing"],
		instruction: deps.instruction,
		tools: controllerTools(deps),
		handlers: [objectHandler, refusalHandler],
	})
	return self
}

export { ControllerEvent }
