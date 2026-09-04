import { describe, expect, it } from "@rstest/core"
import {
	FunctionCallItem, ModelMessageItem, RuntimeState, createAgent, defineRuntime,
	type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent, type Tool,
} from "@mozaik-ai/core"
import { COMMIT_TOOL, InterlockDesk } from "../../src/participants/interlock-desk"
import { IntentRegistry } from "../../src/domain/interlock/intent-registry"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"
import {
	HORIZON_S, INITIAL, WINDOWS, clearanceA, clearanceB, narrowingCandidatesForA,
} from "../../src/scenarios/braid-2"
import type { PendingClearance } from "../../src/domain/airspace/encounter"

class DeskState extends RuntimeState {}
const SETTLE_MS = 50

const argsFor = (c: PendingClearance) =>
	JSON.stringify({ clearanceId: c.id, callsign: c.callsign, command: c.command })

/** Emits one commit_clearance for the given clearance, then acknowledges. */
function runnerFor(byModel: ReadonlyMap<string, PendingClearance>, executed: string[]): InferenceRunner {
	return {
		async run(input: InferenceInput): Promise<InferenceOutput> {
			const clearance = byModel.get(input.model)!
			const already = input.context.getItems().some((i) => i.getType() === "function_call")
			return {
				items: already
					? [ModelMessageItem.rehydrate({ text: "acknowledged" })]
					: [FunctionCallItem.rehydrate({
							callId: `call-${clearance.id}`, name: COMMIT_TOOL, args: argsFor(clearance),
						})],
				tokenUsage: undefined,
				rowResponse: {},
			}
		},
		async *stream(): AsyncGenerator<SemanticEvent> {},
	}
}

const commitTool = (executed: string[]): Tool => ({
	type: "function", name: COMMIT_TOOL, description: "Commit a clearance.",
	parameters: { type: "object", properties: {}, additionalProperties: true },
	strict: false,
	invoke: async (args: { clearanceId?: string }) => {
		executed.push(String(args.clearanceId))
		return { committed: args.clearanceId }
	},
})

function harness() {
	const clock = new VirtualClock(0)
	const executed: string[] = []
	const published: { type: string; payload: unknown }[] = []
	const outbox = new OutboxDispatcher((event) => published.push({ type: event.type, payload: event.payload }), clock)

	const desk = InterlockDesk.init({
		world: () => [...INITIAL],
		windows: WINDOWS,
		horizonSec: HORIZON_S,
		clock,
		outbox,
		settleMs: SETTLE_MS,
		intents: new IntentRegistry(),
		narrowingCandidates: (subject) =>
			subject.callsign === "AAL221" ? narrowingCandidatesForA() : [],
	})

	const byModel = new Map<string, PendingClearance>([
		["approach", clearanceA()],
		["flow", clearanceB()],
	])

	const { initializeRuntime, join, runLoop } = defineRuntime<DeskState>()
	const approach = createAgent({
		name: "APPROACH", capabilities: [], instruction: "Sequence arrivals.",
		tools: [commitTool(executed)], handlers: [],
	})
	const flow = createAgent({
		name: "FLOW", capabilities: [], instruction: "Meter the fix.",
		tools: [commitTool(executed)], handlers: [],
	})
	initializeRuntime({ state: new DeskState(), inferenceRunnerConfig: { runner: runnerFor(byModel, executed) } })
	join(approach)
	join(flow)

	return { clock, desk, executed, published, approach, flow, runLoop }
}

const settle = () => new Promise((r) => setTimeout(r, 60))

/**
 * The airlock, end to end, on the real Mozaik loop.
 *
 * Both controllers are mid-turn. Their commits are held TOGETHER, inspected as a set, and one is
 * resumed with narrowed arguments — while neither has finished thinking.
 */
describe("interlock desk", () => {
	it("holds two commits at once — a set of one would be a no-op", async () => {
		const h = harness()
		h.runLoop(h.approach.getId(), "sequence AAL221", {
			model: "approach", context: h.approach.getMemory().getContext(), tools: h.approach.getTools(),
		}, h.desk.handler())
		h.runLoop(h.flow.getId(), "meter SWA455", {
			model: "flow", context: h.flow.getMemory().getContext(), tools: h.flow.getTools(),
		}, h.desk.handler())

		await settle()
		// Both are suspended INSIDE the airlock, simultaneously, before either has acted.
		expect(h.desk.pendingSize()).toBe(2)
		expect(h.executed).toEqual([])
	})

	it("resumes one commit with NARROWED arguments rather than refusing it", async () => {
		const h = harness()
		for (const [agent, model, message] of [
			[h.approach, "approach", "sequence AAL221"],
			[h.flow, "flow", "meter SWA455"],
		] as const) {
			h.runLoop(agent.getId(), message, {
				model, context: agent.getMemory().getContext(), tools: agent.getTools(),
			}, h.desk.handler())
		}
		await settle()
		h.clock.advance(SETTLE_MS + 1)
		await settle()

		expect(h.desk.pendingSize()).toBe(0)
		expect(h.desk.isQuiescent()).toBe(true)

		const decisions = h.desk.log()
		expect(decisions).toHaveLength(2)
		const narrowed = decisions.filter((d) => d.outcome === "narrowed")
		expect(narrowed).toHaveLength(1)

		// A NARROWING, not a veto: the aircraft still gets a real descent clearance.
		const outcome = narrowed[0]!.committed
		expect(outcome.callsign).toBe("AAL221")
		expect(outcome.command.targetAltFt).toBeDefined()
		expect(outcome.command.targetAltFt).toBeGreaterThan(4_000)
		expect(outcome.id).not.toBe("A")
	})

	it("executes the REWRITTEN clearance, never the original", async () => {
		const h = harness()
		for (const [agent, model] of [[h.approach, "approach"], [h.flow, "flow"]] as const) {
			h.runLoop(agent.getId(), "go", {
				model, context: agent.getMemory().getContext(), tools: agent.getTools(),
			}, h.desk.handler())
		}
		await settle()
		h.clock.advance(SETTLE_MS + 1)
		await settle()

		// The narrowed id reached the tool; the original descend-to-4000 never did.
		expect(h.executed).toHaveLength(2)
		expect(h.executed).not.toContain("A")
		expect(h.executed.some((id) => id.startsWith("A/descend-"))).toBe(true)
		expect(h.executed).toContain("B")
	})

	it("announces what it did — a boundary must announce what it enforces", async () => {
		const h = harness()
		for (const [agent, model] of [[h.approach, "approach"], [h.flow, "flow"]] as const) {
			h.runLoop(agent.getId(), "go", {
				model, context: agent.getMemory().getContext(), tools: agent.getTools(),
			}, h.desk.handler())
		}
		await settle()
		h.clock.advance(SETTLE_MS + 1)
		await settle()

		const events = h.published.map((p) => (p.payload as { event?: string }).event)
		expect(events).toContain("interlock.held")
		expect(events).toContain("interlock.narrowed")
	})

	it("leaves a single commit untouched — one pending clearance is no hazard", async () => {
		const h = harness()
		h.runLoop(h.approach.getId(), "sequence AAL221", {
			model: "approach", context: h.approach.getMemory().getContext(), tools: h.approach.getTools(),
		}, h.desk.handler())
		await settle()
		h.clock.advance(SETTLE_MS + 1)
		await settle()

		expect(h.desk.log()).toHaveLength(1)
		expect(h.desk.log()[0]!.outcome).toBe("clean")
		expect(h.executed).toEqual(["A"])
	})
})
