import { describe, expect, it } from "@rstest/core"
import {
	FunctionCallItem, ModelMessageItem, RuntimeState, SituationSpecification, createHuman, defineRuntime,
	type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent,
	type SituationContext, type SituationHandler,
} from "@mozaik-ai/core"
import { TurnScheduler } from "../../src/infrastructure/scheduling/turn-scheduler"
import { ControllerEvent, createController, type ObjectionPayload } from "../../src/participants/controller"
import { IdentityBook } from "../../src/participants/identity-book"
import { InterlockDesk } from "../../src/participants/interlock-desk"
import { StandingBroker } from "../../src/participants/standing-broker"
import { IntentRegistry } from "../../src/domain/interlock/intent-registry"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"
import { HORIZON_S, INITIAL, WINDOWS, narrowingCandidatesForA } from "../../src/scenarios/braid-2"

class S extends RuntimeState {}
const SETTLE_MS = 50

/** Each controller's turn is scripted by call count: propose -> commit -> acknowledge. */
type ScriptedRunner = InferenceRunner & { readonly lastContext: Map<string, InferenceInput> }

function scriptedController(): ScriptedRunner {
	const calls = new Map<string, number>()
	const lastContext = new Map<string, InferenceInput>()
	const script: Record<string, (n: number) => InferenceOutput["items"]> = {
		approach: (n) => n === 0
			? [call("p-A", "propose_clearance", { clearanceId: "A", callsign: "AAL221", targetAltFt: 4_000, plannedMarginNm: 3.0 })]
			: n === 1
				? [call("c-A", "commit_clearance", { clearanceId: "A" })]
				: [ModelMessageItem.rehydrate({ text: "acknowledged" })],
		flow: (n) => n === 0
			? [call("p-B", "propose_clearance", { clearanceId: "B", callsign: "SWA455", targetHeadingDeg: 340, plannedMarginNm: 3.0 })]
			: n === 1
				? [call("c-B", "commit_clearance", { clearanceId: "B" })]
				: [ModelMessageItem.rehydrate({ text: "acknowledged" })],
	}
	return {
		lastContext,
		async run(input: InferenceInput): Promise<InferenceOutput> {
			const n = calls.get(input.model) ?? 0
			calls.set(input.model, n + 1)
			lastContext.set(input.model, input)
			return { items: script[input.model]!(n), tokenUsage: undefined, rowResponse: {} }
		},
		async *stream(): AsyncGenerator<SemanticEvent> {},
	}
}

const call = (id: string, name: string, args: object) =>
	FunctionCallItem.rehydrate({ callId: id, name, args: JSON.stringify(args) })

const settle = () => new Promise((r) => setTimeout(r, 40))

function harness() {
	const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<S>()
	const clock = new VirtualClock(0)
	const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
	const identity = new IdentityBook()
	const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })
	const world = () => [...INITIAL]
	const intents = new IntentRegistry()

	const desk = InterlockDesk.init({
		world, windows: WINDOWS, horizonSec: HORIZON_S, clock, outbox, settleMs: SETTLE_MS, intents,
		narrowingCandidates: (s) => (s.callsign === "AAL221" ? narrowingCandidatesForA() : []),
	})
	const broker = StandingBroker.init({ outbox, clock })

	const common = {
		world, generation: () => 1, nowSec: () => 0, outbox, horizonSec: HORIZON_S, intents,
		holdsStandingOver: (cs: string) => broker.holds("APPROACH", cs) || broker.holds("FLOW", cs),
	}
	const approach = createController({
		...common, position: "APPROACH", instruction: "Sequence arrivals.",
		participantId: () => approach.getId(),
		holdsStandingOver: (cs) => broker.holds("APPROACH", cs),
		objectTo: () => null, // APPROACH does not object in this scenario
	})
	const flow = createController({
		...common, position: "FLOW", instruction: "Meter the fix.",
		participantId: () => flow.getId(),
		holdsStandingOver: (cs) => broker.holds("FLOW", cs),
		// FLOW's policy: a descent through the metering block on a callsign it also holds is
		// an objection, with a counter-proposal it would accept.
		objectTo: (intent) =>
			intent.callsign === "AAL221" && (intent.command.targetAltFt ?? Infinity) <= 6_000
				? { reason: "descent conflicts with the metering interval at CARDL", suggestTargetAltFt: 7_000 }
				: null,
	})

	// The bridge: forward objection.raised into the desk, and snapshot who was in flight when it landed.
	const inflightAtObjection: string[][] = []
	const objections: ObjectionPayload[] = []
	const bridge: SituationHandler = {
		specification: new (class extends SituationSpecification {
			isSatisfiedBy({ event }: SituationContext) { return true }
		})(),
		processor: {
			apply({ event }) {
				scheduler.observe(event)
				if (event.type === ControllerEvent.OBJECTION_RAISED) {
					const p = event.payload as ObjectionPayload
					objections.push(p)
					inflightAtObjection.push([...scheduler.inflight()])
					desk.object({ by: p.by, clearanceId: p.clearanceId, reason: p.reason, suggestTargetAltFt: p.suggestTargetAltFt })
				}
			},
		},
	}
	const observer = createHuman({ name: "observer", capabilities: [], handlers: [bridge] })

	const runner = scriptedController()
	initializeRuntime({ state: new S(), inferenceRunnerConfig: { runner } })
	for (const p of [observer, broker, desk, approach, flow]) { join(p); identity.register(p) }

	// Overlapping standing: both controllers legally hold AAL221 under different objectives.
	broker.bidSync({ controller: "APPROACH", callsign: "AAL221", objective: "runway-sequence", durationMs: 60_000 })
	broker.bidSync({ controller: "FLOW", callsign: "AAL221", objective: "metering-interval", durationMs: 60_000 })
	broker.bidSync({ controller: "FLOW", callsign: "SWA455", objective: "metering-interval", durationMs: 60_000 })

	return { clock, desk, broker, scheduler, approach, flow, runner, objections, inflightAtObjection }
}

/**
 * THE MONEY SHOT.
 *
 * Two language models change each other's minds while both are still thinking.
 */
describe("two controllers change each other's minds mid-turn", () => {
	it("both hold standing over the same aircraft under different objectives", () => {
		const h = harness()
		expect(h.broker.holdersOver("AAL221")).toEqual([
			"standing:AAL221:metering-interval",
			"standing:AAL221:runway-sequence",
		])
	})

	it("the objection lands while BOTH turns are in flight", async () => {
		const h = harness()
		const template = (model: string) => ({ model, tools: model === "approach" ? h.approach.getTools() : h.flow.getTools() })
		h.scheduler.begin(h.approach, "sequence AAL221", template("approach"), h.desk.handler())
		h.scheduler.begin(h.flow, "meter the fix", template("flow"), h.desk.handler())
		await settle()

		// FLOW objected to APPROACH's intent — published from INSIDE propose_clearance, before A existed.
		expect(h.objections).toHaveLength(1)
		expect(h.objections[0]!.by).toBe("FLOW")
		expect(h.objections[0]!.against).toBe("APPROACH")
		expect(h.objections[0]!.clearanceId).toBe("A")

		// And at that instant, BOTH turns were open. Neither had finished thinking.
		expect(h.inflightAtObjection[0]!.length).toBe(2)
		expect(h.inflightAtObjection[0]!.some((t) => t.endsWith(":APPROACH"))).toBe(true)
		expect(h.inflightAtObjection[0]!.some((t) => t.endsWith(":FLOW"))).toBe(true)
	})

	it("APPROACH's held commit resumes with FLOW's counter-proposal, not a refusal", async () => {
		const h = harness()
		const template = (model: string) => ({ model, tools: model === "approach" ? h.approach.getTools() : h.flow.getTools() })
		h.scheduler.begin(h.approach, "sequence AAL221", template("approach"), h.desk.handler())
		h.scheduler.begin(h.flow, "meter the fix", template("flow"), h.desk.handler())
		await settle()
		h.clock.advance(SETTLE_MS + 1)
		await settle()

		const decision = h.desk.log().find((d) => d.committed.callsign === "AAL221")!
		expect(decision.outcome).toBe("narrowed")
		expect(decision.committed.command.targetAltFt).toBe(7_000)     // FLOW's suggestion
		expect(decision.committed.id).toBe("A/peer-7000")                // and it says whose
	})

	it("APPROACH's next inference SEES that it was narrowed — in its own context", async () => {
		const h = harness()
		const template = (model: string) => ({ model, tools: model === "approach" ? h.approach.getTools() : h.flow.getTools() })
		h.scheduler.begin(h.approach, "sequence AAL221", template("approach"), h.desk.handler())
		h.scheduler.begin(h.flow, "meter the fix", template("flow"), h.desk.handler())
		await settle()
		h.clock.advance(SETTLE_MS + 1)
		await settle()

		// The third inference for APPROACH is the one AFTER the narrowed commit executed.
		const last = h.runner.lastContext.get("approach")!
		const items = last.context.getItems()
		const commit = items.find((i) => i.getType() === "function_call" && (i as unknown as { name: string }).name === "commit_clearance")!
		const args = JSON.parse((commit as unknown as { args: string }).args)

		// The COMMIT in APPROACH's memory is the REWRITTEN one — 7000, marked as narrowed from A.
		expect(args.narrowedFrom).toBe("A")
		expect(args.command.targetAltFt).toBe(7_000)

		// The PROPOSAL is still there too, and it says 4000. That is the whole arc in the agent's
		// own memory: "I proposed 4000. My commit was narrowed to 7000." It can reason about that.
		const proposal = items.find((i) => i.getType() === "function_call" && (i as unknown as { name: string }).name === "propose_clearance")!
		expect(JSON.parse((proposal as unknown as { args: string }).args).targetAltFt).toBe(4_000)

		// But no commit_clearance ever carried 4000 — the original was never executed.
		const commits = items.filter((i) => i.getType() === "function_call" && (i as unknown as { name: string }).name === "commit_clearance")
		expect(commits).toHaveLength(1)
		expect((commits[0] as unknown as { args: string }).args).not.toContain("4000")

		// And the tool executed the narrowed version, so the output confirms it.
		const output = items.find((i) => i.getType() === "function_call_output" && (i as unknown as { callId: string }).callId === "c-A")!
		expect((output as unknown as { output: { text: string } }).output.text).toContain('"narrowedFrom":"A"')
	})

	it("quiesces with both turns closed and nothing half-committed", async () => {
		const h = harness()
		const template = (model: string) => ({ model, tools: model === "approach" ? h.approach.getTools() : h.flow.getTools() })
		h.scheduler.begin(h.approach, "go", template("approach"), h.desk.handler())
		h.scheduler.begin(h.flow, "go", template("flow"), h.desk.handler())
		await settle()
		h.clock.advance(SETTLE_MS + 1)
		await settle()

		expect(h.scheduler.isQuiescent()).toBe(true)
		expect(h.desk.isQuiescent()).toBe(true)
		expect(h.desk.log()).toHaveLength(2)
	})
})
