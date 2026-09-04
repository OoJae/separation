/**
 * SPIKE 03 — preemption via a streaming runner (the highest-risk unknown).
 *
 * InferenceStreamingState does:
 *     for await (const event of runner.stream(input)) { ... if inference.output -> output }
 *     if (!output) throw new Error("Inference output not found")
 *
 * Since mozaik consumes OUR generator, we control termination. The trap is that ending the
 * stream without an `inference.output` throws — uncaught, that kills the process.
 * The fix: on abort, ALWAYS yield a synthesized inference.output, then return.
 */
import {
	FunctionCallItem, FunctionCallOutputItem, ModelMessageItem, RuntimeState,
	SemanticEvent, createAgent, defineRuntime,
	type InferenceInput, type InferenceOutput, type InferenceRunner, type Tool,
} from "@mozaik-ai/core"

class S extends RuntimeState {}
const SYNTH = "spike/streaming-v1"

let crash: unknown = null
process.on("unhandledRejection", (e) => { crash = e })

const answered: string[] = []

/** Streaming runner with a real abort signal. */
class PreemptibleRunner implements InferenceRunner {
	constructor(private readonly opts: { yieldOutputOnAbort: boolean }) {}
	abort = false

	async run(): Promise<InferenceOutput> { throw new Error("not used") }

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		// simulate token-by-token generation
		for (let i = 0; i < 20; i++) {
			if (this.abort) {
				console.log(`      [runner] abort observed at token ${i} — closing stream`)
				if (this.opts.yieldOutputOnAbort) {
					yield new SemanticEvent("inference.output", SYNTH, new Date(), {
						items: [ModelMessageItem.rehydrate({ text: "[preempted: premise invalidated]" })],
						tokenUsage: undefined, rowResponse: { aborted: true },
					} satisfies InferenceOutput)
				}
				return
			}
			yield new SemanticEvent("inference.stream", SYNTH, new Date(), {
				type: "response.output_text.delta", payload: { delta: `tok${i} ` },
			})
			await new Promise(r => setTimeout(r, 10))
		}
		yield new SemanticEvent("inference.output", SYNTH, new Date(), {
			items: [ModelMessageItem.rehydrate({ text: "completed normally" })],
			tokenUsage: undefined, rowResponse: {},
		} satisfies InferenceOutput)
	}
}

async function trial(label: string, yieldOutputOnAbort: boolean) {
	crash = null
	const { initializeRuntime, join, runLoop } = defineRuntime<S>()
	const runner = new PreemptibleRunner({ yieldOutputOnAbort })
	const a = createAgent({ name: "C", capabilities: [], instruction: "x", tools: [], handlers: [
		{
			specification: new (class extends (await import("@mozaik-ai/core")).SituationSpecification {
				isSatisfiedBy(c: any) { return c.event.type === "model.answer" }
			})(),
			processor: { apply(c: any) { answered.push(c.event.payload.answer.content.text) } },
		},
	] })
	initializeRuntime({ state: new S(), inferenceRunnerConfig: { runner } })
	join(a)

	runLoop(a.getId(), "hold", {
		model: SYNTH, streaming: true, context: a.getMemory().getContext(), tools: [],
	})
	await new Promise(r => setTimeout(r, 60))
	runner.abort = true                    // a peer invalidates the premise mid-generation
	await new Promise(r => setTimeout(r, 250))

	const msg = crash instanceof Error ? crash.message : crash === null ? "none" : String(crash)
	console.log(`   ${label}`)
	console.log(`      crash: ${msg}`)
	return msg
}

console.log("SPIKE 03 — aborting a streaming turn mid-generation\n")

console.log("EXPERIMENT A — abort WITHOUT yielding inference.output (the trap)")
const a = await trial("naive abort", false)
const trapConfirmed = a.includes("Inference output not found")
console.log(`      → ${trapConfirmed ? "TRAP CONFIRMED — this would kill the process" : "unexpected: " + a}\n`)

console.log("EXPERIMENT B — abort AND yield a synthesized inference.output (the fix)")
answered.length = 0
const b = await trial("guarded abort", true)
const clean = b === "none" && answered.some(t => t.includes("preempted"))
console.log(`      answers seen: ${JSON.stringify(answered)}`)
console.log(`      → ${clean ? "PASS — turn terminated cleanly, mid-generation, no crash" : "FAIL"}\n`)

// ── Orphan repair: a dangling function_call must never reach a provider ──────────────
const ctxItems = [
	FunctionCallItem.rehydrate({ callId: "orphan_1", name: "commit_clearance", args: "{}" }),
]
const repaired = [...ctxItems, FunctionCallOutputItem.create("orphan_1", "[aborted: premise invalidated by peer]")]
const hasPair = repaired.filter(i => i.getType() === "function_call").length ===
	repaired.filter(i => i.getType() === "function_call_output").length
console.log("EXPERIMENT C — orphan repair")
console.log(`      every function_call has a matching output : ${hasPair ? "PASS" : "FAIL"}`)
console.log(`      (this is also what makes 'being overruled' reasoning material)`)

process.exit(trapConfirmed && clean && hasPair ? 0 : 1)
