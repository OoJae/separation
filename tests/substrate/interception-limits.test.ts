import { describe, expect, it } from "@rstest/core"
import {
	FunctionCallItem, ModelMessageItem, RuntimeState, createAgent, defineRuntime,
	type ExecutableTransition, type InferenceOutput, type InferenceRunner,
	type InterceptionHandler, type SemanticEvent, type Tool,
} from "@mozaik-ai/core"

class S extends RuntimeState {}
const SYNTH = "test/scripted"

const runner = (count: { n: number }): InferenceRunner => ({
	async run(): Promise<InferenceOutput> {
		count.n++
		return {
			items: [FunctionCallItem.rehydrate({ callId: `c${count.n}`, name: "danger", args: "{}" })],
			tokenUsage: undefined, rowResponse: {},
		}
	},
	async *stream(): AsyncGenerator<SemanticEvent> {},
})

const danger = (hits: { n: number }): Tool => ({
	type: "function", name: "danger", description: "must never run",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	strict: true, invoke: async () => { hits.n++; return { ran: true } },
})

/** Run `fn` with our own unhandledRejection listener, then restore the runner's. */
async function captureUnhandled(fn: () => Promise<void>): Promise<unknown> {
	const existing = process.listeners("unhandledRejection")
	for (const listener of existing) process.off("unhandledRejection", listener)
	let captured: unknown = null
	const handler = (reason: unknown) => { captured = reason }
	process.on("unhandledRejection", handler)
	try {
		await fn()
	} finally {
		process.off("unhandledRejection", handler)
		for (const listener of existing) process.on("unhandledRejection", listener as never)
	}
	return captured
}

function scenario(interception: InterceptionHandler) {
	const { initializeRuntime, join, runLoop } = defineRuntime<S>()
	const count = { n: 0 }
	const hits = { n: 0 }
	const agent = createAgent({
		name: "Subject", capabilities: [], instruction: "x", tools: [danger(hits)], handlers: [],
	})
	initializeRuntime({ state: new S(), inferenceRunnerConfig: { runner: runner(count) } })
	join(agent)
	runLoop(agent.getId(), "go", { model: SYNTH, context: agent.getMemory().getContext(), tools: agent.getTools() }, interception)
	return { count, hits }
}

/**
 * These tests pin the limit that shapes our entire preemption design (docs/API-NOTES.md #1).
 * If a future mozaik release fixes the loop, THIS TEST GOES RED — which is exactly what we
 * want, because the fix would let us stop working around it.
 */
describe("InterceptionHandler limits", () => {
	it("returning {nextStateId:'idle'} suppresses the action but CRASHES the loop", async () => {
		let hits = { n: 0 }
		const crash = await captureUnhandled(async () => {
			const halt: InterceptionHandler = {
				isSatisfiedBy: (t) => t.nextStateId === "function_call",
				handle: async () => ({ nextStateId: "idle", input: undefined } as unknown as ExecutableTransition),
			}
			hits = scenario(halt).hits
			await new Promise((r) => setTimeout(r, 150))
		})

		expect(hits.n).toBe(0) // the action WAS suppressed...
		expect(crash).toBeInstanceOf(TypeError) // ...but at the cost of the process
		expect((crash as Error).message).toContain("stateId")
	})

	it("substitution to model_message suppresses the action AND ends the turn cleanly", async () => {
		let hits = { n: 0 }
		let count = { n: 0 }
		const crash = await captureUnhandled(async () => {
			const substitute: InterceptionHandler = {
				isSatisfiedBy: (t) => t.nextStateId === "function_call",
				handle: async () => ({
					nextStateId: "model_message",
					input: { answer: ModelMessageItem.rehydrate({ text: "premise invalidated — stood down" }) },
				}),
			}
			const s = scenario(substitute)
			hits = s.hits
			count = s.count
			await new Promise((r) => setTimeout(r, 150))
		})

		expect(hits.n).toBe(0)
		expect(count.n).toBe(1)
		expect(crash).toBeNull() // this is the mechanism we ship as `transition.substituted`
	})
})
