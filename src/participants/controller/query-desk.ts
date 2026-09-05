import type { Callsign } from "../../domain/airspace/aircraft-state"
import { PilotEvent, type ReplyPayload } from "../pilot"
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
export class QueryDesk {
	private readonly waiting = new Map<string, (outcome: QueryOutcome) => void>()
	private counter = 0
	private timeouts = 0

	constructor(
		private readonly deps: {
			readonly outbox: OutboxDispatcher
			readonly clock: Clock
			readonly timeoutMs: number
		},
	) {}

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
				resolve(outcome)
			}

			this.waiting.set(queryId, settle)
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

	/** Feed every `pilot.reply` here. Correlates by queryId; an unknown id is ignored. */
	receive(reply: ReplyPayload, atMs: number, startedAtMs = atMs): void {
		const settle = this.waiting.get(reply.queryId)
		if (settle === undefined) return
		settle({ ok: true, text: reply.text, claims: reply.claims, waitedMs: Math.max(0, atMs - startedAtMs) })
	}
}
