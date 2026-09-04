import { SWAP } from "./swap"

/**
 * A single compare-and-swap cell.
 *
 * WHY THIS EXISTS: mozaik ships `RuntimeState` with no lock, no mutex and no change
 * notification, and `runLoop` is fire-and-forget, so concurrent writes to shared state are
 * the consumer's problem. Rather than bolt on a mutex (which would serialize decisions —
 * the exact thing this project argues against), every shared cell carries a token and a
 * stale write is REJECTED AND ANNOUNCED. Decisions stay concurrent; only the commit is
 * ordered.
 */
export class VersionedCell<T> {
	private currentValue: T
	private currentToken: number

	private constructor(value: T, token: number) {
		this.currentValue = value
		this.currentToken = token
	}

	get value(): T {
		return this.currentValue
	}

	get token(): number {
		return this.currentToken
	}

	/** Mutation is gated on the SWAP symbol, which only `cas-write.ts` may import. */
	[SWAP](next: T): number {
		this.currentValue = next
		this.currentToken += 1
		return this.currentToken
	}

	static init<T>(value: T): VersionedCell<T> {
		return new VersionedCell(value, 0)
	}

	static rehydrate<T>(data: { value: T; token: number }): VersionedCell<T> {
		return new VersionedCell(data.value, data.token)
	}
}
