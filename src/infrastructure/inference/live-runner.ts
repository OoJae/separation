import { ModelMessageItem, SemanticEvent, supportedModels } from "@mozaik-ai/core"
import type { InferenceInput, InferenceOutput, InferenceRunner } from "@mozaik-ai/core"
import type { Clock } from "../../support/ports"
import { BudgetGuard } from "./budget-guard"
import { InferenceCache } from "./inference-cache"
import type { ScriptedReply } from "./synthetic-runner"

export type LiveCall = {
	readonly model: string
	readonly latencyMs: number
	readonly cached: boolean
}

/**
 * The runner for a live run. Multiplexes on model id:
 *
 *   synthetic id  -> the scripted reply, immediately, zero tokens
 *   real id       -> cache -> budget guard -> the exported endpoint, latency recorded
 *
 * WHY NOT WRAP DefaultInferenceRunner (docs/API-NOTES.md #19): it is exported, but its required
 * second constructor argument, `InferenceInputValidator`, is NOT — so it cannot be constructed
 * from outside the package. The only way to get one is `initializeRuntime` with no custom runner,
 * which forecloses wrapping it. So this dispatches to `supportedModels[i].endpoint.infer` directly,
 * which is exactly what DefaultInferenceRunner does minus the validation step. Effort validation
 * is done by `resolveEffort` in model-roster.ts instead.
 *
 * Wall-clock latency is measured here, and it is the ONLY wall-clock read outside the clock
 * adapter — permitted by an explicit exemption in invariants.test.ts, because measuring a real
 * provider's response time is the one thing a virtual clock cannot do.
 */
export class LiveInferenceRunner implements InferenceRunner {
	private readonly calls: LiveCall[] = []

	constructor(
		private readonly deps: {
			readonly scripted: ScriptedReply
			readonly isSynthetic: (model: string) => boolean
			readonly cache: InferenceCache
			readonly budget: BudgetGuard
			readonly clock: Clock
			readonly measure: () => number
		},
	) {}

	log(): readonly LiveCall[] {
		return this.calls
	}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		if (this.deps.isSynthetic(input.model)) return this.deps.scripted(input)

		const cached = this.deps.cache.get(input)
		if (cached !== null) {
			this.calls.push({ model: input.model, latencyMs: 0, cached: true })
			return cached
		}

		const verdict = this.deps.budget.authorize()
		if (!verdict.ok) {
			return refusal(`budget exhausted: ${verdict.spent}/${verdict.cap} live calls used`)
		}

		const model = supportedModels.find((m) => m.specification.name === input.model)
		if (!model) return refusal(`unsupported model ${input.model}`)

		const started = this.deps.measure()
		const output = await model.endpoint.infer(input)
		const latencyMs = Math.round(this.deps.measure() - started)

		this.deps.cache.put(input, output, latencyMs)
		this.calls.push({ model: input.model, latencyMs, cached: false })
		return output
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		// Always yields an inference.output before returning — ending without one throws inside
		// InferenceStreamingState and kills the process (API-NOTES #2, #5).
		yield new SemanticEvent("inference.output", input.model, this.deps.clock.now(), await this.run(input))
	}
}

/** A refusal is a VALUE the model can read, never a throw that would kill the loop. */
function refusal(reason: string): InferenceOutput {
	return {
		items: [ModelMessageItem.rehydrate({ text: `[inference refused: ${reason}]` })],
		tokenUsage: undefined,
		rowResponse: { refused: true, reason },
	}
}
