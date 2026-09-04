import { EventType, type ParticipantHaltedPayload } from "../../events/event-types"
import type { IdentityBook } from "../../participants/identity-book"
import type { OutboxDispatcher } from "../../support/outbox"
import type { TurnScheduler } from "../scheduling/turn-scheduler"

/**
 * SupervisingDriver — because a dead agent is otherwise indistinguishable from a quiet one.
 *
 * WHY THIS EXISTS (docs/API-NOTES.md #5): `createRunLoop` calls `agentLoop.run(...)` with no
 * `await` and no `.catch()`, and `runLoop` returns `void`. Every failure inside a turn —
 * a provider 400, `No transition rule found after "inference"` on a truncated or refused
 * response, a thrown situation processor — becomes an unhandled rejection, which is fatal by
 * default on Node 26.
 *
 * That matters more here than in a normal app: in a system where participants infer consent
 * from silence, an agent that dies publishing nothing is read by its peers as AGREEMENT.
 * So a death must become an announcement.
 */
export class SupervisingDriver {
	private installed = false
	private readonly onRejection = (reason: unknown) => this.handleFailure(reason, "unhandledRejection")
	private readonly onException = (error: unknown) => this.handleFailure(error, "uncaughtException")

	constructor(
		private readonly deps: {
			readonly outbox: OutboxDispatcher
			readonly scheduler: TurnScheduler
			readonly identity: IdentityBook
			/** Rethrow after announcing. Off in tests, on in production runs. */
			readonly fatal?: boolean
		},
	) {}

	install(): void {
		if (this.installed) return
		process.on("unhandledRejection", this.onRejection)
		process.on("uncaughtException", this.onException)
		this.installed = true
	}

	dispose(): void {
		if (!this.installed) return
		process.off("unhandledRejection", this.onRejection)
		process.off("uncaughtException", this.onException)
		this.installed = false
	}

	/**
	 * Attribution is best-effort and says so. An unhandled rejection carries no agent
	 * identity, so when exactly one turn is in flight we attribute to it; otherwise the
	 * halt is announced against every in-flight turn rather than guessed at, because
	 * silently picking one would be worse than naming several.
	 */
	handleFailure(reason: unknown, cause: string): void {
		const message = reason instanceof Error ? reason.message : String(reason)
		const inflight = this.deps.scheduler.inflight()

		if (inflight.length === 0) {
			this.announce("<no-turn-in-flight>", `${cause}: ${message}`, null)
		} else {
			for (const turnId of inflight) {
				const agentName = turnId.split(":").slice(1).join(":") || turnId
				this.announce(agentName, `${cause}: ${message}`, turnId)
				this.deps.scheduler.abort(turnId, cause)
			}
		}

		if (this.deps.fatal) throw reason
	}

	private announce(agentName: string, cause: string, lastTurnId: string | null): void {
		const payload: ParticipantHaltedPayload = { agentName, cause, lastTurnId }
		this.deps.outbox.publish(EventType.PARTICIPANT_HALTED, "supervisor", payload)
	}
}

export type RetryOptions = {
	readonly attempts?: number
	readonly baseDelayMs?: number
	readonly sleep?: (ms: number) => Promise<void>
}

/** Per-provider retry with exponential backoff. Deterministic: no jitter. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
	const attempts = options.attempts ?? 3
	const base = options.baseDelayMs ?? 50
	const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

	let lastError: unknown
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await fn()
		} catch (error) {
			lastError = error
			// `1 << attempt` rather than `2 ** attempt`: the ** operator shares Math.pow's
			// implementation-defined semantics and is banned repo-wide (see invariants.test.ts).
			if (attempt < attempts - 1) await sleep(base * (1 << attempt))
		}
	}
	throw lastError
}
