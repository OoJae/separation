/**
 * SPIKE 01 — the marquee mechanism, proven with ZERO tokens.
 *
 * Unknown (a): a custom InferenceRunner can synthesize inference for a fake model id.
 * Unknown (b): an InterceptionHandler can rewrite a pending function_call's args via
 *              FunctionCallItem.rehydrate, the REWRITTEN call is what executes, AND the
 *              rewritten call lands in the agent's context so it reasons about being narrowed.
 */
import {
	DefaultInferenceRunner, FunctionCallItem, FunctionCallOutputItem, ModelMessageItem,
	RuntimeState, createAgent, defineRuntime, supportedModels,
	type ExecutableTransition, type InferenceInput, type InferenceOutput,
	type InferenceRunner, type InterceptionHandler, type SemanticEvent, type Tool,
} from "@mozaik-ai/core"

class SpikeState extends RuntimeState {}
const { initializeRuntime, join, runLoop } = defineRuntime<SpikeState>()

const SYNTHETIC = "spike/scripted-v1"
const ORIGINAL_ARGS = JSON.stringify({ callsign: "UAL231", maneuver: "DESCEND 6000" })

/** What the tool actually executed with — filled by invoke(). */
let executedArgs: string | null = null
/** The context items the model saw on its SECOND inference. */
let secondInferenceContext: string[] = [] as string[]

let inferenceCount = 0

class ScriptedRunner implements InferenceRunner {
	constructor(private readonly delegate: InferenceRunner) {}

	async run(input: InferenceInput): Promise<InferenceOutput> {
		// Unknown (a): multiplex on model id, delegate anything real.
		if (input.model !== SYNTHETIC) return this.delegate.run(input)

		inferenceCount++
		if (inferenceCount === 1) {
			return {
				items: [FunctionCallItem.rehydrate({
					callId: "call_spike_1", name: "commit_clearance", args: ORIGINAL_ARGS,
				})],
				tokenUsage: undefined,
				rowResponse: { synthetic: true, turn: 1 },
			}
		}
		// Second inference: record exactly what is in context now.
		secondInferenceContext = input.context.getItems().map((i: any) => {
			const t = i.getType()
			if (t === "function_call") return `function_call args=${i.args}`
			if (t === "function_call_output") return `function_call_output ${i.output.text}`
			if (t === "message") return `message(${i.role}) ${i.content.text.slice(0, 60)}`
			return t
		})
		return {
			items: [ModelMessageItem.rehydrate({ text: "acknowledged" })],
			tokenUsage: undefined,
			rowResponse: { synthetic: true, turn: 2 },
		}
	}

	async *stream(input: InferenceInput): AsyncGenerator<SemanticEvent> {
		yield* this.delegate.stream(input)
	}
}

const commitClearance: Tool = {
	type: "function",
	name: "commit_clearance",
	description: "Commit a clearance for an aircraft.",
	parameters: {
		type: "object",
		properties: { callsign: { type: "string" }, maneuver: { type: "string" } },
		required: ["callsign", "maneuver"], additionalProperties: false,
	},
	strict: true,
	invoke: async (args: any) => {
		executedArgs = JSON.stringify(args)
		return { ok: true, committed: args.maneuver }
	},
}

/** A peer's objection, landing as narrowed arguments inside a still-open turn. */
class ObjectionInterception implements InterceptionHandler {
	isSatisfiedBy(t: ExecutableTransition): boolean {
		if (t.nextStateId !== "function_call") return false
		const { call } = t.input as { call: FunctionCallItem }
		return call.name === "commit_clearance"
	}
	async handle(t: ExecutableTransition): Promise<ExecutableTransition> {
		const { call, inferenceInput } = t.input as { call: FunctionCallItem; inferenceInput: InferenceInput }
		const args = JSON.parse(call.args)
		const narrowed = JSON.stringify({ ...args, maneuver: `${args.maneuver}, TURN 20L` })
		console.log(`  [interception] FLOW objects — narrowing args`)
		console.log(`      from: ${call.args}`)
		console.log(`      to:   ${narrowed}`)
		return {
			nextStateId: "function_call",
			input: {
				call: FunctionCallItem.rehydrate({ callId: call.callId, name: call.name, args: narrowed }),
				inferenceInput,
			},
		}
	}
}

const agent = createAgent({
	name: "APPROACH", capabilities: ["inference"],
	instruction: "You sequence arrivals.", tools: [commitClearance], handlers: [],
})

initializeRuntime({
	state: new SpikeState(),
	inferenceRunnerConfig: {
		runner: new ScriptedRunner(new DefaultInferenceRunner(supportedModels as any, undefined as any)),
	},
})
join(agent)

const input: InferenceInput = {
	model: SYNTHETIC,
	context: agent.getMemory().getContext(),
	tools: agent.getTools(),
}

console.log("SPIKE 01 — interception rewrite read-back\n")
runLoop(agent.getId(), "UAL231 needs descent.", input, new ObjectionInterception())

await new Promise(r => setTimeout(r, 400))

console.log("\n  context at 2nd inference:")
for (const line of secondInferenceContext) console.log("     ", line)

const rewritten = (executedArgs as string | null)?.includes("TURN 20L") ?? false
const inContext = secondInferenceContext.some(l => l.startsWith("function_call args=") && l.includes("TURN 20L"))
const originalGone = !secondInferenceContext.some(l => l === `function_call args=${ORIGINAL_ARGS}`)

console.log("\n  RESULTS")
console.log(`   (a) custom runner synthesized inference for a fake model id : ${inferenceCount >= 2 ? "PASS" : "FAIL"}`)
console.log(`   (b1) the REWRITTEN args are what actually executed          : ${rewritten ? "PASS" : "FAIL"}  (${executedArgs})`)
console.log(`   (b2) the REWRITTEN call is in the agent's own context       : ${inContext ? "PASS" : "FAIL"}`)
console.log(`   (b3) the ORIGINAL args are structurally absent              : ${originalGone ? "PASS (as predicted)" : "FAIL"}`)

process.exit(rewritten && inContext ? 0 : 1)
