import { describe, expect, it } from "@rstest/core"
import {
	FunctionCallItem, ModelMessageItem, RuntimeState, SituationSpecification, createAgent,
	createHuman, defineRuntime,
	type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent,
	type SituationContext, type SituationHandler, type Tool,
} from "@mozaik-ai/core"
import { TurnScheduler } from "../../src/infrastructure/scheduling/turn-scheduler"
import { IdentityBook } from "../../src/participants/identity-book"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"
import { isWellPaired } from "../../src/infrastructure/scheduling/orphan-repair"

class TestState extends RuntimeState {}
const SYNTH = "test/scripted"

/** Emits one function_call, then a final message. Per-turn delay drives interleaving. */
function scriptedRunner(delayByCall: number[]): InferenceRunner {
	let call = 0
	return {
		async run(input: InferenceInput): Promise<InferenceOutput> {
			const index = call++
			await new Promise((r) => setTimeout(r, delayByCall[index] ?? 0))
			const alreadyCalled = input.context.getItems().some((i) => i.getType() === "function_call")
			return {
				items: alreadyCalled
					? [ModelMessageItem.rehydrate({ text: "done" })]
					: [FunctionCallItem.rehydrate({ callId: `c${index}`, name: "noop", args: "{}" })],
				tokenUsage: undefined,
				rowResponse: {},
			}
		},
		async *stream(): AsyncGenerator<SemanticEvent> {},
	}
}

const noop: Tool = {
	type: "function", name: "noop", description: "no-op",
	parameters: { type: "object", properties: {}, additionalProperties: false },
	strict: true,
	invoke: async () => ({ ok: true }),
}

const settle = () => new Promise((r) => setTimeout(r, 250))

const roleOf = (item: { getType(): string }) => (item as unknown as { role?: string }).role

describe("context ownership", () => {
	/**
	 * The hazard, demonstrated: `ModelContext.addContextItems` mutates in place and returns
	 * `this`, so two concurrent turns handed `agent.getMemory().getContext()` write into the
	 * SAME array and corrupt tool-call pairing.
	 */
	it("CONTROL: two concurrent turns sharing Memory's context corrupt tool pairing", async () => {
		const { initializeRuntime, join, runLoop } = defineRuntime<TestState>()
		const agent = createAgent({
			name: "Shared", capabilities: [], instruction: "x", tools: [noop], handlers: [],
		})
		initializeRuntime({ state: new TestState(), inferenceRunnerConfig: { runner: scriptedRunner([40, 5]) } })
		join(agent)

		const shared = agent.getMemory().getContext()
		runLoop(agent.getId(), "turn one", { model: SYNTH, context: shared, tools: [noop] })
		runLoop(agent.getId(), "turn two", { model: SYNTH, context: shared, tools: [noop] })
		await settle()

		const items = shared.getItems()
		const roleAt = (n: number) => (items[n] as unknown as { role?: string }).role

		// 1. Both turns wrote into ONE array. The aliasing is real.
		const userMessages = items.filter(
			(i) => i.getType() === "message" && (i as unknown as { role?: string }).role === "user",
		)
		expect(userMessages.length).toBe(2)

		// 2. Two user messages land back-to-back with no assistant turn between them —
		//    a malformed conversation that no provider would have produced.
		expect(roleAt(1)).toBe("user")
		expect(roleAt(2)).toBe("user")

		// 3. The damning part: TWO turns produced only ONE function_call, because the slower
		//    turn observed the faster turn's call sitting in the shared context and treated it
		//    as its own already-completed work. One turn silently consumed the other's.
		expect(items.filter((i) => i.getType() === "function_call")).toHaveLength(1)
		expect(items.filter((i) => i.getType() === "message" && roleOf(i) === "assistant")).toHaveLength(2)
	})

	it("a fresh ModelContext per turn is a distinct object, never aliased", () => {
		const agent = createAgent({
			name: "Fresh", capabilities: [], instruction: "x", tools: [noop], handlers: [],
		})
		const clock = new VirtualClock(0)
		const scheduler = new TurnScheduler({
			runLoop: () => {}, outbox: new OutboxDispatcher(() => {}, clock), clock, identity: new IdentityBook(),
		})
		const ledger = scheduler.ledgerFor(agent)
		const a = ledger.freshContext("t1")
		const b = ledger.freshContext("t2")

		expect(a).not.toBe(b)
		expect(a.getItems()).not.toBe(b.getItems())
		a.addContextItems([ModelMessageItem.rehydrate({ text: "only in a" })])
		expect(b.getItems()).toHaveLength(1) // still just the developer message
		expect(ledger.size()).toBe(1) // and the ledger itself is untouched
	})

	it("the ledger is seeded from the agent's own developer message", () => {
		const agent = createAgent({
			name: "Seeded", capabilities: [], instruction: "you sequence arrivals", tools: [], handlers: [],
		})
		const clock = new VirtualClock(0)
		const scheduler = new TurnScheduler({
			runLoop: () => {}, outbox: new OutboxDispatcher(() => {}, clock), clock, identity: new IdentityBook(),
		})
		const items = scheduler.ledgerFor(agent).snapshot()
		expect(items).toHaveLength(1)
		expect((items[0] as unknown as { role: string }).role).toBe("developer")
	})

	describe("TurnScheduler", () => {
		function harness() {
			const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<TestState>()
			const clock = new VirtualClock(0)
			const identity = new IdentityBook()
			const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
			const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })

			const relay: SituationHandler = {
				specification: new (class extends SituationSpecification {
					isSatisfiedBy(_: SituationContext) { return true }
				})(),
				processor: { apply({ event }) { scheduler.observe(event) } },
			}
			const agent = createAgent({
				name: "Scheduled", capabilities: [], instruction: "x", tools: [noop], handlers: [relay],
			})
			const sink = createHuman({ name: "Sink", capabilities: [], handlers: [relay] })

			initializeRuntime({ state: new TestState(), inferenceRunnerConfig: { runner: scriptedRunner([30, 5]) } })
			join(agent)
			join(sink)
			identity.register(agent)
			identity.register(sink)
			return { scheduler, agent }
		}

		it("refuses a second concurrent turn for the same agent", () => {
			const { scheduler, agent } = harness()
			const first = scheduler.begin(agent, "turn one", { model: SYNTH, tools: [noop] })
			const second = scheduler.begin(agent, "turn two", { model: SYNTH, tools: [noop] })

			expect(first.ok).toBe(true)
			expect(second).toEqual({ ok: false, reason: "already-in-flight" })
			expect(scheduler.inflight()).toHaveLength(1)
			expect(scheduler.isQuiescent()).toBe(false)
		})

		it("binds turnId to loopId and closes the turn on model.answer", async () => {
			const { scheduler, agent } = harness()
			scheduler.begin(agent, "turn one", { model: SYNTH, tools: [noop] })
			await settle()

			// Quiescence is PROVED over an empty in-flight set, not declared.
			expect(scheduler.inflight()).toEqual([])
			expect(scheduler.isQuiescent()).toBe(true)
			expect(scheduler.ledgerWellPaired(agent)).toBe(true)
		})

		it("keeps sequential turns well-paired and lets the second one run", async () => {
			const { scheduler, agent } = harness()
			scheduler.begin(agent, "turn one", { model: SYNTH, tools: [noop] })
			await settle()
			const second = scheduler.begin(agent, "turn two", { model: SYNTH, tools: [noop] })
			await settle()

			expect(second.ok).toBe(true)
			expect(scheduler.isQuiescent()).toBe(true)
			expect(scheduler.ledgerWellPaired(agent)).toBe(true)
		})

		it("repairs orphans when a turn is aborted mid-flight", async () => {
			const { scheduler, agent } = harness()
			const begun = scheduler.begin(agent, "turn one", { model: SYNTH, tools: [noop] })
			expect(begun.ok).toBe(true)
			if (!begun.ok) return

			await new Promise((r) => setTimeout(r, 45)) // let the function_call land, then preempt
			scheduler.abort(begun.turnId, "premise invalidated")

			expect(scheduler.isQuiescent()).toBe(true)
			expect(scheduler.ledgerWellPaired(agent)).toBe(true)
		})
	})
})
