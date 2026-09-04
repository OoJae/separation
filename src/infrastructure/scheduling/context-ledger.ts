import { ModelContext, type Agent, type ContextItem } from "@mozaik-ai/core"

/**
 * ContextLedger — an agent's conversation, owned by us rather than by the agent.
 *
 * WHY THIS EXISTS (docs/API-NOTES.md #4, #7): `ModelContext.addContextItems` mutates in
 * place and returns `this`, so two concurrent turns sharing `agent.getMemory().getContext()`
 * interleave a `function_call` with a foreign `function_call_output` and hard-400 both
 * Anthropic and OpenAI. And because `Memory` is not exported and its context has no setter,
 * injecting a synthesized `FunctionCallOutputItem` — required by OrphanRepair and by
 * "you were overruled" feedback — is only possible from outside the agent.
 *
 * So: we seed from the agent's own developer message (which `Agent.create` puts in Memory),
 * and from then on the ledger, not `Memory`, is the source of truth.
 */
export class ContextLedger {
	private items: ContextItem[]

	private constructor(items: ContextItem[]) {
		this.items = items
	}

	/** Seeded from the agent's Memory, which `Agent.create` primes with the DeveloperMessageItem. */
	static forAgent(agent: Agent): ContextLedger {
		return new ContextLedger([...agent.getMemory().getContext().getItems()])
	}

	static fromItems(items: readonly ContextItem[]): ContextLedger {
		return new ContextLedger([...items])
	}

	/** A defensive copy — callers must never hold a reference into the ledger. */
	snapshot(): ContextItem[] {
		return [...this.items]
	}

	/** Build the fresh, unshared context for one turn. Never reuse a ModelContext. */
	freshContext(turnId: string): ModelContext {
		return new ModelContext(turnId, this.snapshot())
	}

	/** Replace the ledger with a harvested (and repaired) turn result. */
	adopt(items: readonly ContextItem[]): void {
		this.items = [...items]
	}

	append(item: ContextItem): void {
		this.items.push(item)
	}

	size(): number {
		return this.items.length
	}
}
