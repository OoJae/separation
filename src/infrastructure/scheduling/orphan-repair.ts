import { FunctionCallOutputItem, type ContextItem } from "@mozaik-ai/core"

/**
 * OrphanRepair — make a harvested context safe to send to a provider again.
 *
 * WHY THIS EXISTS (docs/API-NOTES.md #2, #5): when we preempt a turn mid-flight, the
 * context can contain a `function_call` whose `function_call_output` never arrived. Every
 * provider rejects that pairing, and because `runLoop` has no `.catch()` the resulting 400
 * lands as an unhandled rejection ONE TURN LATER — the hardest class of bug to attribute on
 * a nondeterministic bus.
 *
 * It is also the mechanism that makes being overruled *reasoning material*: the synthesized
 * output carries the reason, so the agent's next inference sees why it was stopped instead
 * of silently failing.
 *
 * Reasoning items are stripped: mozaik's own loop never stores them, and Anthropic
 * re-serializes a `ReasoningItem` as a `thinking` block whose signature may be empty, which
 * 400s. Keeping them would introduce a fault the framework does not have.
 */
export function repairContextItems(items: readonly ContextItem[], reason: string): ContextItem[] {
	const withoutReasoning = items.filter((item) => item.getType() !== "reasoning")

	const satisfied = new Set(
		withoutReasoning
			.filter((item) => item.getType() === "function_call_output")
			.map((item) => (item as unknown as { callId: string }).callId),
	)

	const repaired: ContextItem[] = []
	for (const item of withoutReasoning) {
		repaired.push(item)
		if (item.getType() !== "function_call") continue

		const callId = (item as unknown as { callId: string }).callId
		if (satisfied.has(callId)) continue

		// Insert the synthesized output immediately after its call so tool pairing stays adjacent.
		repaired.push(FunctionCallOutputItem.create(callId, reason))
		satisfied.add(callId)
	}
	return repaired
}

/**
 * True when the item order is safe to send to a provider.
 *
 * Counting calls and outputs is NOT enough: two concurrent turns writing into one context
 * produce [callA, callB, outputA, outputB], which has equal counts and is still rejected by
 * every provider. The real contract is adjacency — each `function_call` must be followed by
 * its OWN `function_call_output` before any other call or output appears.
 */
export function isWellPaired(items: readonly ContextItem[]): boolean {
	let openCallId: string | null = null

	for (const item of items) {
		const type = item.getType()
		if (type === "function_call") {
			if (openCallId !== null) return false // a second call opened while one was pending
			openCallId = (item as unknown as { callId: string }).callId
			continue
		}
		if (type === "function_call_output") {
			const callId = (item as unknown as { callId: string }).callId
			if (openCallId !== callId) return false // output for the wrong call, or none open
			openCallId = null
		}
	}
	return openCallId === null
}
