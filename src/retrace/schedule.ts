/**
 * The scheduling seam.
 *
 * The system is single-threaded JavaScript, so RETRACE does NOT explore V8's microtask scheduler
 * and will not pretend to. What it explores is the scheduling surface this architecture actually
 * exposes, which is exactly three things:
 *
 *   1. outbox delivery order   — which queued event is dispatched next
 *   2. timer order             — which due timer fires next
 *   3. yield seams             — points inside a read-compute-write where an await could exist
 *
 * The claim is "exhaustive over the scheduling surface this architecture exposes", never
 * "exhaustive over all interleavings". The difference matters and is stated in the README.
 *
 * NON-INVASIVENESS IS THE FIRST REQUIREMENT. `FifoPolicy` reproduces today's behaviour exactly, so
 * every existing test must stay green with the seam installed and unchanged. If introducing this
 * changes any existing test, the seam is wrong, not the test.
 */

export type Choice = {
	/** What kind of decision this is — used by the shrinker to describe a minimal repro. */
	readonly kind: "outbox" | "timer" | "yield"
	/** How many options were available. 1 means there was no real choice. */
	readonly options: number
	/** A stable label for the decision point, so repros read as prose. */
	readonly label: string
}

export interface SchedulePolicy {
	/**
	 * Pick the next item from `options.length` eligible candidates. Returning 0 always reproduces
	 * the default order.
	 */
	choose(choice: Choice): number

	/** Should we yield at this seam? A yield turns a synchronous section into an interleaving point. */
	shouldYield(label: string): boolean

	/** Every decision this policy made, in order. This IS the schedule. */
	decisions(): readonly ScheduleDecision[]
}

export type ScheduleDecision = {
	readonly index: number
	readonly kind: Choice["kind"]
	readonly label: string
	readonly options: number
	readonly picked: number
}

/** Today's behaviour, exactly: first eligible item, never yield. */
export class FifoPolicy implements SchedulePolicy {
	private readonly log: ScheduleDecision[] = []

	choose(choice: Choice): number {
		this.log.push({ index: this.log.length, kind: choice.kind, label: choice.label, options: choice.options, picked: 0 })
		return 0
	}

	shouldYield(): boolean {
		return false
	}

	decisions(): readonly ScheduleDecision[] {
		return this.log
	}
}

/**
 * Replays a recorded list of picks, then falls back to the default.
 *
 * This is what makes a violation REPRODUCIBLE: a schedule is just a list of integers, so a repro
 * is data rather than a description, and the shrinker can operate on it directly.
 */
export class ScriptedPolicy implements SchedulePolicy {
	private readonly log: ScheduleDecision[] = []
	private cursor = 0

	constructor(
		private readonly picks: readonly number[],
		private readonly yieldAt: ReadonlySet<string> = new Set(),
	) {}

	choose(choice: Choice): number {
		const raw = this.picks[this.cursor] ?? 0
		this.cursor += 1
		// Clamp rather than throw: a shrunk schedule may be shorter or hit narrower choice points.
		const picked = choice.options <= 1 ? 0 : ((raw % choice.options) + choice.options) % choice.options
		this.log.push({ index: this.log.length, kind: choice.kind, label: choice.label, options: choice.options, picked })
		return picked
	}

	shouldYield(label: string): boolean {
		return this.yieldAt.has(label)
	}

	decisions(): readonly ScheduleDecision[] {
		return this.log
	}

	yieldLabels(): ReadonlySet<string> {
		return this.yieldAt
	}
}

/** The ambient policy. Default is FIFO, so nothing changes unless a run opts in. */
let current: SchedulePolicy = new FifoPolicy()

export function currentPolicy(): SchedulePolicy {
	return current
}

/** Install a policy for the duration of `fn`, always restoring — even on throw. */
export async function withPolicy<T>(policy: SchedulePolicy, fn: () => Promise<T>): Promise<T> {
	const previous = current
	current = policy
	try {
		return await fn()
	} finally {
		current = previous
	}
}

export function setPolicy(policy: SchedulePolicy): void {
	current = policy
}

export function resetPolicy(): void {
	current = new FifoPolicy()
}

/**
 * A yield seam. In the default schedule this is a no-op and the section stays synchronous; under
 * exploration it becomes a real interleaving point.
 *
 * Seams go ONLY at genuine read-compute-write boundaries — places where an `await` could
 * plausibly be added by a future maintainer. Putting one where no await could go would manufacture
 * a bug rather than find one, which would make the whole exercise theatre.
 */
export async function seam(label: string): Promise<void> {
	if (!current.shouldYield(label)) return
	await Promise.resolve()
}
