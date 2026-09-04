import type { PendingClearance } from "../../domain/airspace/encounter"

export type HeldTurn = {
	readonly turnId: string
	readonly clearance: PendingClearance
	readonly heldAtMs: number
	/** Resolved when the desk releases this turn, with the clearance it may actually commit. */
	readonly release: (outcome: PendingClearance) => void
}

/**
 * The airlock.
 *
 * THE ONLY genuinely multi-writer, capacity-constrained cell in the system — and a set of one is
 * a no-op. Its whole interest is in holding more than one half-formed clearance at a time, which
 * is the only moment a hazard living in the INTERSECTION of two pending decisions is visible to
 * anyone.
 *
 * The desk serializes INSPECTION of the set, exactly as an exchange serializes its order book. It
 * never serializes anyone's DECISION: both controllers are still mid-turn while their commits sit
 * here together.
 */
export class PendingSet {
	private readonly held = new Map<string, HeldTurn>()

	add(turn: HeldTurn): void {
		this.held.set(turn.turnId, turn)
	}

	remove(turnId: string): HeldTurn | undefined {
		const turn = this.held.get(turnId)
		this.held.delete(turnId)
		return turn
	}

	/** Sorted by turnId, so any verdict computed over the set is order-stable. */
	entries(): readonly HeldTurn[] {
		return [...this.held.values()].sort((a, b) => (a.turnId < b.turnId ? -1 : 1))
	}

	clearances(): readonly PendingClearance[] {
		return this.entries().map((t) => t.clearance)
	}

	size(): number {
		return this.held.size
	}

	isEmpty(): boolean {
		return this.held.size === 0
	}
}
