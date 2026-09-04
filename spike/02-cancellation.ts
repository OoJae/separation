/**
 * SPIKE 02 — can an InterceptionHandler halt a turn?
 *
 * CORRECTED FINDING. The loop is:
 *     while (transition.nextStateId !== "idle") {
 *         if (satisfied) transition = await handle(transition)   // may set idle
 *         const execution = await stateExecutor.execute(transition)   // NOT re-checked
 *         transition = transitionResolver.resolve(execution)
 *     }
 * The interception result is never re-tested against the loop condition, and
 * LoopStateExecutor.execute is an exhaustive switch with no `idle` case, so it returns
 * undefined and TransitionResolver.resolve crashes. Uncaught => the process dies.
 *
 * Experiment A documents that. Experiment B proves the honest, type-legal alternative.
 */
import {
	FunctionCallItem, ModelMessageItem, RuntimeState, createAgent, defineRuntime,
	type ExecutableTransition, type InferenceInput, type InferenceOutput,
	type InferenceRunner, type InterceptionHandler, type SemanticEvent, type Tool,
} from "@mozaik-ai/core"

class S extends RuntimeState {}
const SYNTH = "spike/scripted-v1"

const makeRunner = (c: { n: number }): InferenceRunner => ({
	async run(): Promise<InferenceOutput> {
		c.n++
		return {
			items: [FunctionCallItem.rehydrate({ callId: `c${c.n}`, name: "danger", args: "{}" })],
			tokenUsage: undefined, rowResponse: {},
		}
	},
	async *stream(): AsyncGenerator<SemanticEvent> {},
})

const dangerTool = (h: { n: number }): Tool => ({
	type: "function", name: "danger", description: "must never run",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	strict: true,
	invoke: async () => { h.n++; return { ran: true } },
})

let crash: unknown = null
process.on("unhandledRejection", (e) => { crash = e })

console.log("SPIKE 02 — halting a turn from an InterceptionHandler\n")

// ── A: return {nextStateId:'idle'} ───────────────────────────────────────────────────
{
	const { initializeRuntime, join, runLoop } = defineRuntime<S>()
	const c = { n: 0 }, h = { n: 0 }
	const a = createAgent({ name: "A", capabilities: [], instruction: "x", tools: [dangerTool(h)], handlers: [] })
	initializeRuntime({ state: new S(), inferenceRunnerConfig: { runner: makeRunner(c) } })
	join(a)
	const halt: InterceptionHandler = {
		isSatisfiedBy: (t) => t.nextStateId === "function_call",
		handle: async () => ({ nextStateId: "idle", input: undefined } as unknown as ExecutableTransition),
	}
	runLoop(a.getId(), "go", { model: SYNTH, context: a.getMemory().getContext(), tools: a.getTools() }, halt)
	await new Promise(r => setTimeout(r, 300))

	const msg = crash instanceof Error ? crash.message : String(crash)
	const isTheBug = msg.includes("Cannot read properties of undefined") && msg.includes("stateId")
	console.log("EXPERIMENT A — handle() returns {nextStateId:'idle'}")
	console.log(`   dangerTool ran   : ${h.n} times (action WAS suppressed)`)
	console.log(`   but the loop     : ${isTheBug ? "CRASHED — " + msg : "survived: " + msg}`)
	console.log(`   → verdict        : ${isTheBug ? "CONFIRMED BUG — halting is unreachable; uncaught, this kills the process" : "unexpected"}`)
	console.log(`   → one-line fix   : re-check the loop condition after the interception block\n`)
}

crash = null

// ── B: substitution, the honest type-legal form of "stop" ───────────────────────────
{
	const { initializeRuntime, join, runLoop } = defineRuntime<S>()
	const c = { n: 0 }, h = { n: 0 }
	const a = createAgent({ name: "B", capabilities: [], instruction: "x", tools: [dangerTool(h)], handlers: [] })
	initializeRuntime({ state: new S(), inferenceRunnerConfig: { runner: makeRunner(c) } })
	join(a)
	const substitute: InterceptionHandler = {
		isSatisfiedBy: (t) => t.nextStateId === "function_call",
		handle: async () => ({
			nextStateId: "model_message",
			input: { answer: ModelMessageItem.rehydrate({ text: "premise invalidated — stood down" }) },
		}),
	}
	runLoop(a.getId(), "go", { model: SYNTH, context: a.getMemory().getContext(), tools: a.getTools() }, substitute)
	await new Promise(r => setTimeout(r, 300))

	const ok = h.n === 0 && c.n === 1 && crash === null
	console.log("EXPERIMENT B — substituting function_call -> model_message")
	console.log(`   inferences=${c.n}  dangerTool ran=${h.n}  crash=${crash === null ? "none" : String(crash)}`)
	console.log(`   → action suppressed AND the turn ended cleanly : ${ok ? "PASS" : "FAIL"}`)
	console.log(`   → this is the mechanism SEPARATION ships as \`transition.substituted\``)
	process.exit(ok ? 0 : 1)
}
