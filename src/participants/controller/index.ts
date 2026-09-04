import { SituationSpecification, createAgent } from "@mozaik-ai/core"
import type { Agent, SituationContext, SituationHandler } from "@mozaik-ai/core"
import type { Callsign } from "../../domain/airspace/aircraft-state"
import type { OutboxDispatcher } from "../../support/outbox"
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

	self = createAgent({
		name: deps.position,
		capabilities: ["inference", "standing"],
		instruction: deps.instruction,
		tools: controllerTools(deps),
		handlers: [objectHandler],
	})
	return self
}

export { ControllerEvent }
