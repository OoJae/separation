import { ModelMessageItem, SemanticEvent } from "@mozaik-ai/core"
import type { InferenceInput, InferenceOutput, InferenceRunner } from "@mozaik-ai/core"
import type { Clock } from "../../support/ports"

export type ScriptedReply = (input: InferenceInput) => InferenceOutput

/**
 * The Phase 2 inference runner. Returns scripted output IMMEDIATELY — it never sleeps.
 *
 * Latency is modelled as data on the VirtualClock (see latency-model.ts), not as real waiting, so
 * a 380-second scenario runs in milliseconds and two runs of the same seed are identical. A
 * runner that actually slept would make the suite slow AND non-deterministic, which is the worst
 * of both.
 *
 * The abort path ALWAYS yields a synthesized `inference.output` before returning. Ending a stream
 * without one makes `InferenceStreamingState` throw "Inference output not found", and since
 * `runLoop` has no `.catch()` that kills the process (docs/API-NOTES.md #2, #5).
 */
export class SyntheticInferenceRunner implements InferenceRunner {
	private aborted = false
	private calls = 0

	constructor(
		private readonly reply: ScriptedReply,
		private readonly clock: Clock,
	) {}

	callCount(): number {
		return this.calls
	}

	abort(): void {
		this.aborted = true
	}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		this.calls += 1
		return this.reply(input)
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		this.calls += 1
		if (this.aborted) {
			yield this.outputEvent(input, {
				items: [ModelMessageItem.rehydrate({ text: "[preempted: premise invalidated]" })],
				tokenUsage: undefined,
				rowResponse: { aborted: true },
			})
			return
		}
		yield this.outputEvent(input, this.reply(input))
	}

	private outputEvent(input: InferenceInput, output: InferenceOutput): SemanticEvent {
		// The public constructor with clock time, never SemanticEvent.create — that stamps
		// `new Date()` internally and would make every tape differ (API-NOTES #9).
		return new SemanticEvent("inference.output", input.model, this.clock.now(), output)
	}
}
