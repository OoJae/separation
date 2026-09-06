import { SWAP } from "../domain/cell/swap"
import { VersionedCell } from "../domain/cell/versioned-cell"
import { EventType, type CasRejectedPayload } from "../events/event-types"
import type { OutboxDispatcher } from "../support/outbox"

export type CasResult =
	| { readonly ok: true; readonly token: number }
	| { readonly ok: false; readonly expected: number; readonly actual: number }

export type CasContext = {
	readonly path: string
	readonly byWhom: string
	readonly turnId?: string | null
}

/**
 * THE single mutation path for shared state. There are no bare assignments to any
 * VersionedCell anywhere else in the repo (tests/substrate/cas-write.test.ts).
 *
 * A stale write is rejected AND ANNOUNCED as `cas.rejected`, never silently retried —
 * "whatever a boundary enforces, it must also announce". Announcing it is what lets the
 * loser be routed into peer negotiation instead of just losing.
 */
export function casWrite<T>(
	cell: VersionedCell<T>,
	expectedToken: number,
	mutator: (current: T) => T,
	context: CasContext,
	outbox: OutboxDispatcher,
): CasResult {
	if (cell.token !== expectedToken) {
		const payload: CasRejectedPayload = {
			path: context.path,
			expected: expectedToken,
			actual: cell.token,
			byWhom: context.byWhom,
			turnId: context.turnId ?? null,
		}
		outbox.publish(EventType.CAS_REJECTED, context.byWhom, payload)
		return { ok: false, expected: expectedToken, actual: cell.token }
	}

	const token = cell[SWAP](mutator(cell.value))
	return { ok: true, token }
}
