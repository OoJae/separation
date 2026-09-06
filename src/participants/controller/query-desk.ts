import { Participant, SituationSpecification } from "@mozaik-ai/core"
import type { SituationContext, SituationHandler } from "@mozaik-ai/core"
import type { Callsign } from "../../domain/airspace/aircraft-state"
import { PilotEvent, type ReplyPayload } from "../../events/pilot-events"
import type { OutboxDispatcher } from "../../support/outbox"
import type { Clock } from "../../support/ports"

export type QueryOutcome =
	| { readonly ok: true; readonly text: string; readonly claims: ReplyPayload["claims"]; readonly waitedMs: number }
	| { readonly ok: false; readonly reason: "timeout"; readonly waitedMs: number }

/**
 * The ask-and-wait desk.
 *
 * A controller's `query_pilot` tool calls `ask()` and AWAITS it. Because
 * `FunctionCallState.run` awaits the tool (docs/API-NOTES.md #7), the controller's whole turn is
 * parked for the length of a pilot's turn — roughly 13 s of measured latency against a manoeuvre
 * window of about 44 s.
 *
 * That is not an implementation accident to be engineered away. It is the trade-off the project
 * is about: THE INFORMATION THAT DECIDES THE ANSWER COSTS THE WINDOW YOU NEEDED TO ACT INSIDE.
 * A controller must judge whether it can afford to find out, and the value of the unknown is
 * exactly the thing it does not know. No solver resolves that.
 *
 * A timeout is reported as an outcome, never thrown. If it fires, that is a finding about a
 * controller parked forever on a peer — worth writing up, not worth silently lengthening.
 */
export class QueryDesk extends Participant {
	private static instances = 0
	private readonly waiting = new Map<string, (outcome: QueryOutcome) => void>()
	private readonly startedAt = new Map<string, number>()
	private counter = 0
	private timeouts = 0

	constructor(
		private readonly deps: {
			readonly outbox: OutboxDispatcher
			readonly clock: Clock
			readonly timeoutMs: number
		},
	) {
		// Unique per instance. mozaik's RuntimeState.addParticipant is a no-op when the id already
		// exists, so a hardcoded id meant a second desk joined nothing, subscribed to nothing, and
		// left every query it brokered parked until timeout — silently, with no error anywhere.
		const seq = ++QueryDesk.instances
		super({ id: `query-desk-${seq}`, name: `query-desk-${seq}`, role: "agent", capabilities: ["query.correlate"] }, [])
		this.setHandlers([this.replyHandler()])
	}

	/**
	 * Subscribe to `pilot.reply` and settle the matching parked turn.
	 *
	 * This closes the round trip IN PRODUCTION. It used to be closed by the evidence scripts
	 * themselves: a tap sniffed the framework's `function_call.completed`, guessed a reply by
	 * substring (`text.includes("detail")`), and re-injected it with a HARDCODED `queryId: "q1"`
	 * — so only the first query of a run could ever be answered, `waitedMs` was always 0, and the
	 * mechanism the demo was demonstrating lived in the demo rather than the system.
	 */
	private replyHandler(): SituationHandler {
		const desk = this
		class WhenPilotReplies extends SituationSpecification {
			isSatisfiedBy({ event }: SituationContext): boolean {
				return event.type === PilotEvent.REPLY
			}
		}
		return {
			specification: new WhenPilotReplies(),
			processor: {
				// Synchronous and never throws — a throwing processor starves the bus (#15).
				apply({ event }) {
					const reply = event.payload as Partial<ReplyPayload>
					if (typeof reply.queryId !== "string" || typeof reply.text !== "string") return
					desk.receive({
						queryId: reply.queryId,
						callsign: reply.callsign ?? "",
						toController: reply.toController ?? "",
						text: reply.text,
						claims: reply.claims ?? [],
					}, desk.deps.clock.nowMs())
				},
			},
		}
	}

	timeoutsSeen(): number {
		return this.timeouts
	}

	pendingQueries(): number {
		return this.waiting.size
	}

	ask(params: {
		readonly askerId: string
		readonly fromController: string
		readonly toCallsign: Callsign
		readonly question: string
	}): Promise<QueryOutcome> {
		const queryId = `q${++this.counter}`
		const startedAt = this.deps.clock.nowMs()

		return new Promise<QueryOutcome>((resolve) => {
			let settled = false
			const settle = (outcome: QueryOutcome) => {
				if (settled) return
				settled = true
				this.waiting.delete(queryId)
				this.startedAt.delete(queryId)
				resolve(outcome)
			}

			this.waiting.set(queryId, settle)
			this.startedAt.set(queryId, startedAt)
			this.deps.clock.after(this.deps.timeoutMs, () => {
				if (settled) return
				this.timeouts += 1
				settle({ ok: false, reason: "timeout", waitedMs: this.deps.clock.nowMs() - startedAt })
			})

			this.deps.outbox.publish(PilotEvent.QUERY, params.askerId, {
				queryId,
				toCallsign: params.toCallsign,
				fromController: params.fromController,
				question: params.question,
			})
		})
	}

	/**
	 * Correlates by queryId; an unknown id is ignored.
	 *
	 * `startedAtMs` now defaults to the instant the query was actually ASKED, remembered here,
	 * rather than to `atMs` — which made `waitedMs` identically zero and silently erased the very
	 * cost this desk exists to measure.
	 */
	receive(reply: ReplyPayload, atMs: number, startedAtMs = this.startedAt.get(reply.queryId) ?? atMs): void {
		const settle = this.waiting.get(reply.queryId)
		if (settle === undefined) return
		settle({ ok: true, text: reply.text, claims: reply.claims, waitedMs: Math.max(0, atMs - startedAtMs) })
	}
}
