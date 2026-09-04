/**
 * LoopAlias — makes the Recorder's tape reproducible.
 *
 * PHASE 1 GAP, found while designing Phase 2. `AgentLoop.create` mints a `crypto.randomUUID()`
 * for every loop, and `Recorder.observe` was writing that raw id straight into the tape. So the
 * tape differed on every run even when the run itself was deterministic — which would have
 * quietly falsified the replay guarantee the moment we tried to assert it.
 *
 * Fix: map each loopId to a per-run monotonic alias (`L1`, `L2`, …) in first-observation order.
 * Deterministic given a deterministic event order, which the OutboxDispatcher already provides.
 */
export class LoopAlias {
	private readonly aliases = new Map<string, string>()

	aliasFor(loopId: string): string {
		let alias = this.aliases.get(loopId)
		if (alias === undefined) {
			alias = `L${this.aliases.size + 1}`
			this.aliases.set(loopId, alias)
		}
		return alias
	}

	size(): number {
		return this.aliases.size
	}
}
