import { SituationSpecification, createAgent } from "@mozaik-ai/core"
import type { Agent, SituationContext, SituationHandler, Tool } from "@mozaik-ai/core"
import type { Callsign } from "../../domain/airspace/aircraft-state"
import { refusalFor, type PilotSheet } from "../../domain/disclosure/pilot-sheet"
import type { OutboxDispatcher } from "../../support/outbox"
import { PilotEvent, type QueryPayload, type ReplyPayload, type UnablePayload } from "../../events/pilot-events"

export { PilotEvent }
export type { QueryPayload, ReplyPayload, UnablePayload }





export type PilotDeps = {
	readonly sheet: PilotSheet
	readonly outbox: OutboxDispatcher
	readonly participantId: () => string
	/** Starts this pilot's turn. Reactive — a pilot only thinks when spoken to. */
	readonly beginTurn: (pilot: Agent, message: string) => void
}

/**
 * A pilot.
 *
 * REACTIVE, never polled: it runs a turn only when a controller queries it or issues it a
 * clearance. That is what makes ten live pilots affordable — a typical run wakes two or three of
 * them, and the rest cost nothing.
 *
 * It holds its `PilotSheet` in this closure and nowhere else. The prober cannot import the type,
 * the world snapshot does not carry the values, and no `FeasibleSet` contains them. The only route
 * to this information is asking — and asking parks the controller for the length of a pilot's
 * turn, because `FunctionCallState.run` awaits the tool (docs/API-NOTES.md #7).
 *
 * So the cost of finding out is the window you needed to act inside. That trade-off is the point:
 * no solver resolves it, because the value of the unknown is exactly what is unknown.
 */
export function createPilot(deps: PilotDeps): Agent {
	let self: Agent | null = null
	const sheet = deps.sheet

	const tools: Tool[] = [
		{
			type: "function",
			name: "report_fuel_state",
			description: "Report your fuel state to the controller who asked.",
			parameters: {
				type: "object",
				properties: { fuelKg: { type: "number" }, remark: { type: "string" } },
				required: ["fuelKg"], additionalProperties: false,
			},
			strict: false,
			invoke: async (args: { fuelKg: number; remark?: string }) => {
				replyWith(
					`${sheet.callsign} reports ${args.fuelKg} kg${args.remark ? `. ${args.remark}` : ""}`,
					[{ field: "fuelMg", value: Math.round(args.fuelKg * 1_000_000) }],
				)
				return ({
				reported: true, fuelKg: args.fuelKg, remark: args.remark ?? null,
			})
			},
		},
		{
			type: "function",
			name: "report_constraint",
			description: "Tell the controller about an operational constraint they cannot see from the ground.",
			parameters: {
				type: "object",
				properties: { detail: { type: "string" }, wantsShortestPath: { type: "boolean" } },
				required: ["detail"], additionalProperties: false,
			},
			strict: false,
			invoke: async (args: { detail: string; wantsShortestPath?: boolean }) => {
				replyWith(args.detail, [])
				return {
					reported: true, detail: args.detail, wantsShortestPath: args.wantsShortestPath ?? false,
				}
			},
		},
		{
			type: "function",
			name: "decline_clearance",
			description: "Decline a clearance you cannot accept, with the reason and any counter-proposal.",
			parameters: {
				type: "object",
				properties: {
					clearanceId: { type: "string" }, reason: { type: "string" }, counterProposal: { type: "string" },
				},
				required: ["clearanceId", "reason"], additionalProperties: false,
			},
			strict: false,
			invoke: async (args: { clearanceId: string; reason: string; counterProposal?: string }) => {
				if (self === null) return { declined: false }
				const payload: UnablePayload = {
					callsign: sheet.callsign, clearanceId: args.clearanceId,
					reason: args.reason, counterProposal: args.counterProposal ?? null,
				}
				deps.outbox.publish(PilotEvent.UNABLE, self.getId(), payload)
				return { declined: true, ...payload }
			},
		},
	]

	/**
	 * The query this crew is currently answering.
	 *
	 * Held in the closure rather than asked of the model. The prompt does tell the crew its query
	 * id, but correlating a parked controller turn to a reply is bookkeeping, not judgement — and
	 * relying on a model to echo an identifier back verbatim is exactly the kind of thing that
	 * works in a demo and fails in a run.
	 */
	let answering: { readonly queryId: string; readonly toController: string } | null = null

	/** Publish the reply that settles the controller's parked turn. */
	const replyWith = (text: string, claims: ReplyPayload["claims"]): void => {
		if (self === null || answering === null) return
		const payload: ReplyPayload = {
			queryId: answering.queryId, callsign: sheet.callsign,
			toController: answering.toController, text, claims,
		}
		deps.outbox.publish(PilotEvent.REPLY, self.getId(), payload)
		answering = null
	}

	/** Answer a controller's question. The sheet is in scope here and only here. */
	class WhenQueried extends SituationSpecification {
		isSatisfiedBy({ event }: SituationContext): boolean {
			if (event.type !== PilotEvent.QUERY) return false
			return (event.payload as Partial<QueryPayload>).toCallsign === sheet.callsign
		}
	}

	const answerHandler: SituationHandler = {
		specification: new WhenQueried(),
		processor: {
			apply({ event }) {
				// Synchronous and never throws — a throwing processor starves the bus (#15).
				if (self === null) return
				const q = event.payload as QueryPayload
				answering = { queryId: q.queryId, toController: q.fromController }
				deps.beginTurn(self, [
					`${q.fromController} asks: "${q.question}"`,
					``,
					`Your aircraft is ${sheet.callsign}. Your private situation, which the controller`,
					`cannot see from the ground:`,
					`  fuel on board: ${(sheet.reportedFuelMg / 1_000_000).toFixed(0)} kg`,
					sheet.constraint ? `  note: ${sheet.constraint.detail}` : `  no special constraints`,
					``,
					`Answer honestly and briefly. Use report_fuel_state if fuel is asked about, and`,
					`report_constraint if you have something operationally relevant to disclose.`,
					`Query id ${q.queryId}.`,
				].join("\n"))
			},
		},
	}

	/** Accept or decline a clearance addressed to this aircraft. */
	class WhenClearanceIssued extends SituationSpecification {
		isSatisfiedBy({ event }: SituationContext): boolean {
			if (event.type !== PilotEvent.CLEARANCE_ISSUED) return false
			return (event.payload as { callsign?: string }).callsign === sheet.callsign
		}
	}

	const clearanceHandler: SituationHandler = {
		specification: new WhenClearanceIssued(),
		processor: {
			apply({ event }) {
				if (self === null) return
				const p = event.payload as {
					clearanceId: string
					command?: { targetAltFt?: number; turnMagnitudeDeg?: number }
				}
				const refusal = refusalFor(sheet, p.command ?? {})
				if (refusal === null) return // acceptance is silence; only a refusal is news

				// Published directly rather than through a turn: a refusal is a fact about the
				// aircraft, not a judgement, and it must reach the controller while its turn is
				// still open. Routing it through inference would be slower than the window allows.
				const payload: UnablePayload = {
					callsign: sheet.callsign, clearanceId: p.clearanceId,
					reason: refusal.reason, counterProposal: null,
				}
				deps.outbox.publish(PilotEvent.UNABLE, self.getId(), payload)
			},
		},
	}

	self = createAgent({
		name: sheet.callsign,
		capabilities: ["inference", "airborne"],
		instruction: [
			`You are the flight crew of ${sheet.callsign} on approach.`,
			`Answer the controller briefly and honestly, the way a real crew would on frequency.`,
			`Report only what you are asked about, plus anything operationally important.`,
			`Never invent traffic, weather or instructions you were not given.`,
		].join("\n"),
		tools,
		handlers: [answerHandler, clearanceHandler],
	})
	return self
}
