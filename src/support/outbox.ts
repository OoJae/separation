import { SemanticEvent } from "@mozaik-ai/core"
import type { Clock } from "./ports"

/** The narrow slice of the runtime the outbox needs. Keeps it testable without a runtime. */
export type SendEvent = (event: SemanticEvent, senderId: string) => void

/**
 * OutboxDispatcher — deferred, totally-ordered event dispatch.
 *
 * WHY THIS EXISTS (docs/API-NOTES.md #6): `RuntimeService.publish` is a synchronous,
 * re-entrant, uncaught for-loop over participants. If a situation processor calls
 * `sendEvent`, publish re-enters depth-first, so participant A can observe event 2 before
 * event 1 while participant B observes the reverse. There is no queue and no try/catch.
 *
 * The fix: domain code never calls `sendEvent` directly. It calls `publish()` here, which
 * appends to a FIFO and drains one event at a time. Because a drain in progress never
 * recurses, each event's full fan-out completes before the next begins, so EVERY
 * participant observes one identical monotonic `seq` order.
 *
 * HONEST SCOPE: this totally orders OUR domain events. Framework loop events
 * (`inference.*`, `function_call.*`, `model.answer`) are published by mozaik's
 * EventPublisherLoopVisitor directly and do NOT route through here; the Recorder stamps
 * those with a separate observation seq. We claim ordering only for what we actually order.
 */
export class OutboxDispatcher {
	private readonly queue: { event: SemanticEvent; senderId: string }[] = []
	private draining = false
	private seq = 0

	constructor(
		private readonly send: SendEvent,
		private readonly clock: Clock,
	) {}

	/**
	 * Enqueue a domain event. Returns the `seq` stamped into its payload.
	 * Uses `new SemanticEvent(...)` with clock time, never `SemanticEvent.create`,
	 * which stamps `new Date()` internally (API-NOTES #9).
	 */
	publish<TPayload extends object>(
		type: string,
		producerId: string,
		payload: TPayload,
		senderId: string = producerId,
	): number {
		const seq = ++this.seq
		const event = new SemanticEvent(type, producerId, this.clock.now(), { ...payload, seq })
		this.queue.push({ event, senderId })
		this.drain()
		return seq
	}

	private drain(): void {
		if (this.draining) return // re-entrant publish: queue it, do not recurse
		this.draining = true
		try {
			while (this.queue.length > 0) {
				const next = this.queue.shift()!
				this.send(next.event, next.senderId)
			}
		} finally {
			this.draining = false
		}
	}

	lastSeq(): number {
		return this.seq
	}

	depth(): number {
		return this.queue.length
	}
}
