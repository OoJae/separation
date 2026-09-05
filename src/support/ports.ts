/**
 * Clock — the injectable time port.
 *
 * WHY THIS EXISTS (docs/API-NOTES.md #9): `SemanticEvent.create` stamps `new Date()`
 * internally, so any system wanting deterministic replay must avoid the static factory
 * and construct events with an injected time. Nothing under `src/` may call `Date.now()`,
 * `new Date()` or `SemanticEvent.create` — enforced by tests/substrate/no-wall-clock.test.ts.
 */

import { currentPolicy } from "../retrace/schedule"

export type TimerHandle = number

export interface Clock {
	nowMs(): number
	now(): Date
	/** Schedule `fn` to run at absolute time `atMs`. */
	at(atMs: number, fn: () => void): TimerHandle
	/** Schedule `fn` to run `afterMs` from now. */
	after(afterMs: number, fn: () => void): TimerHandle
	cancel(handle: TimerHandle): void
}

type Timer = {
	readonly handle: TimerHandle
	readonly dueMs: number
	readonly seq: number
	readonly fn: () => void
}

/**
 * Deterministic clock. Timers fire ordered by (dueMs, insertionSeq), so ties break by
 * insertion order and two identical runs produce byte-identical traces.
 *
 * Not a heap: a sorted array is O(n) per insert but n is tiny (a few hundred timers) and
 * the ordering is easier to audit, which matters more here than the constant factor.
 */
export class VirtualClock implements Clock {
	private currentMs: number
	private timers: Timer[] = []
	private nextHandle = 1
	private insertions = 0

	constructor(startMs = 0) {
		this.currentMs = startMs
	}

	nowMs(): number {
		return this.currentMs
	}

	now(): Date {
		return new Date(this.currentMs)
	}

	at(atMs: number, fn: () => void): TimerHandle {
		const timer: Timer = { handle: this.nextHandle++, dueMs: atMs, seq: this.insertions++, fn }
		const index = this.timers.findIndex(
			(t) => t.dueMs > timer.dueMs || (t.dueMs === timer.dueMs && t.seq > timer.seq),
		)
		if (index === -1) this.timers.push(timer)
		else this.timers.splice(index, 0, timer)
		return timer.handle
	}

	after(afterMs: number, fn: () => void): TimerHandle {
		return this.at(this.currentMs + afterMs, fn)
	}

	cancel(handle: TimerHandle): void {
		const index = this.timers.findIndex((t) => t.handle === handle)
		if (index !== -1) this.timers.splice(index, 1)
	}

	/**
	 * Advance time by `deltaMs`, firing every timer that comes due in (dueMs, seq) order.
	 * A timer scheduled by a firing callback runs within this same advance if it is due.
	 */
	advance(deltaMs: number): void {
		this.runUntil(this.currentMs + deltaMs)
	}

	runUntil(targetMs: number): void {
		while (this.timers.length > 0 && this.timers[0]!.dueMs <= targetMs) {
			// THE SCHEDULING SEAM. Eligible = every timer already due at the earliest due time.
			// The default policy picks index 0, reproducing the previous `shift()` exactly.
			// Only timers sharing the earliest due time are eligible, so causality holds: a timer
			// can never fire before it is due.
			const earliest = this.timers[0]!.dueMs
			let eligible = 0
			while (eligible < this.timers.length && this.timers[eligible]!.dueMs === earliest) eligible++

			const index = eligible === 1
				? 0
				: currentPolicy().choose({ kind: "timer", options: eligible, label: `timer@${earliest}x${eligible}` })

			const timer = this.timers.splice(index, 1)[0]!
			this.currentMs = timer.dueMs
			timer.fn()
		}
		this.currentMs = targetMs
	}

	pendingCount(): number {
		return this.timers.length
	}
}

/** Wall-clock adapter, used only for the live demo. */
export class SystemClock implements Clock {
	private readonly origin = performance.timeOrigin
	private readonly handles = new Map<TimerHandle, NodeJS.Timeout>()
	private nextHandle = 1

	nowMs(): number {
		return this.origin + performance.now()
	}

	now(): Date {
		return new Date(this.nowMs())
	}

	at(atMs: number, fn: () => void): TimerHandle {
		return this.after(Math.max(0, atMs - this.nowMs()), fn)
	}

	after(afterMs: number, fn: () => void): TimerHandle {
		const handle = this.nextHandle++
		this.handles.set(handle, setTimeout(() => {
			this.handles.delete(handle)
			fn()
		}, afterMs))
		return handle
	}

	cancel(handle: TimerHandle): void {
		const timeout = this.handles.get(handle)
		if (timeout !== undefined) {
			clearTimeout(timeout)
			this.handles.delete(handle)
		}
	}
}
