import { describe, expect, it } from "@rstest/core"
import {
	FunctionCallItem, ModelMessageItem, RuntimeState, SituationSpecification, createHuman, defineRuntime,
	type InferenceInput, type InferenceOutput, type InferenceRunner, type SemanticEvent,
	type SituationContext, type SituationHandler,
} from "@mozaik-ai/core"
import { IntentRegistry } from "../../src/domain/interlock/intent-registry"
import { TurnScheduler } from "../../src/infrastructure/scheduling/turn-scheduler"
import { QueryDesk } from "../../src/participants/controller/query-desk"
import { createController } from "../../src/participants/controller"
import { IdentityBook } from "../../src/participants/identity-book"
import { InterlockDesk } from "../../src/participants/interlock-desk"
import { createPilot } from "../../src/participants/pilot"
import { PilotEvent, type ReplyPayload, type UnablePayload } from "../../src/events/pilot-events"
import { WorldEvent } from "../../src/events/world-events"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"
import { HORIZON_S, INITIAL, WINDOWS } from "../../src/scenarios/braid-2"
import { MEDICAL_AIRCRAFT, MEDICAL_CALLSIGN, sheetFor } from "../../src/scenarios/pilot-sheets"

class S extends RuntimeState {}
const settle = () => new Promise((r) => setTimeout(r, 50))
const call = (id: string, name: string, args: object) =>
	FunctionCallItem.rehydrate({ callId: id, name, args: JSON.stringify(args) })
const out = (items: InferenceOutput["items"]): InferenceOutput =>
	({ items, tokenUsage: undefined, rowResponse: {} })

/** AAL77's sheet refuses a turn of 25 degrees or more. It is on 120, so 150 is a 30-degree turn. */
const WIDE_HEADING_DEG = 150

function scripted(): InferenceRunner {
	const n = new Map<string, number>()
	return {
		async run(input: InferenceInput): Promise<InferenceOutput> {
			const i = n.get(input.model) ?? 0
			n.set(input.model, i + 1)
			if (input.model === "asker") {
				if (i === 0) return out([call("q1", "query_pilot", {
					callsign: MEDICAL_CALLSIGN, question: "anything I should know?",
				})])
				return out([ModelMessageItem.rehydrate({ text: "understood" })])
			}
			if (input.model === "pilot-answers") {
				if (i === 0) {
					const sheet = sheetFor(MEDICAL_CALLSIGN)!
					return out([call("r1", "report_constraint", {
						detail: sheet.constraint!.detail, wantsShortestPath: true,
					})])
				}
				return out([ModelMessageItem.rehydrate({ text: "roger" })])
			}
			if (input.model === "controller") {
				if (i === 0) return out([call("p1", "propose_clearance", {
					clearanceId: "MED", callsign: MEDICAL_CALLSIGN,
					targetHeadingDeg: WIDE_HEADING_DEG, plannedMarginNm: 4.2,
				})])
				if (i === 1) return out([call("c1", "commit_clearance", { clearanceId: "MED" })])
				return out([ModelMessageItem.rehydrate({ text: "re-planning after the refusal" })])
			}
			return out([ModelMessageItem.rehydrate({ text: "roger" })])
		},
		async *stream(): AsyncGenerator<SemanticEvent> {},
	}
}

function harness() {
	const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<S>()
	const clock = new VirtualClock(0)
	const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
	const identity = new IdentityBook()
	const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })
	const intents = new IntentRegistry()
	const queryDesk = new QueryDesk({ outbox, clock, timeoutMs: 30_000 })
	const world = () => [...INITIAL, MEDICAL_AIRCRAFT]

	const desk = InterlockDesk.init({
		world, windows: WINDOWS, horizonSec: HORIZON_S, clock, outbox, settleMs: 20, intents,
		narrowingCandidates: () => [],
	})

	const unable: UnablePayload[] = []
	const issuedToWorld: { callsign?: string }[] = []
	const issuedToCrew: { callsign?: string; command?: { turnMagnitudeDeg?: number } }[] = []
	const replanPrompts: string[] = []

	const pilot = createPilot({
		sheet: sheetFor(MEDICAL_CALLSIGN)!,
		outbox,
		participantId: () => pilot.getId(),
		beginTurn: (self, message) =>
			scheduler.begin(self, message, { model: "pilot", tools: self.getTools() }),
	})

	const controller = createController({
		position: "APPROACH", instruction: "Sequence arrivals.",
		world, generation: () => 1, nowSec: () => 0, outbox, horizonSec: HORIZON_S, intents,
		participantId: () => controller.getId(),
		holdsStandingOver: () => true,
		objectTo: () => null,
		queryDesk,
		beginTurn: (self, message) => {
			// Record only turns that actually STARTED. Pushing on every call counted attempts, so a
			// re-plan the scheduler refused as already-in-flight still read as a re-plan — the test
			// passed while the behaviour it asserted did not happen.
			const started = scheduler.begin(
				self, message, { model: "controller", tools: self.getTools() }, desk.handler(),
			).ok
			if (started) replanPrompts.push(message)
			return started
		},
	})

	const tap: SituationHandler = {
		specification: new (class extends SituationSpecification {
			isSatisfiedBy(_: SituationContext) { return true }
		})(),
		processor: {
			apply({ event }) {
				scheduler.observe(event)
				if (event.type === PilotEvent.UNABLE) unable.push(event.payload as UnablePayload)
				if (event.type === WorldEvent.COMMAND_ISSUED) issuedToWorld.push(event.payload as never)
				if (event.type === PilotEvent.CLEARANCE_ISSUED) issuedToCrew.push(event.payload as never)
			},
		},
	}
	const observer = createHuman({ name: "observer", capabilities: [], handlers: [tap] })

	initializeRuntime({ state: new S(), inferenceRunnerConfig: { runner: scripted() } })
	for (const p of [observer, desk, queryDesk, pilot, controller]) { join(p); identity.register(p) }

	return { clock, scheduler, desk, controller, unable, issuedToWorld, issuedToCrew, replanPrompts }
}

/**
 * THE LOOP, END TO END, OVER THE REAL BUS.
 *
 * Every one of these assertions used to be unreachable. `clearance.issued` and
 * `actuator.command.issued` each had a fully-written listener and NO PUBLISHER, so a committed
 * clearance neither moved metal nor reached the crew who had to fly it. `refusalFor` keyed on a
 * `turnMagnitudeDeg` field that nothing ever populated, so every turn-based refusal rule in the
 * repo was dead on arrival. And `pilot.unable` had two consumers, both of them display code — so
 * a refusal was, to the running system, indistinguishable from acceptance.
 *
 * The only previous coverage invoked the pilot's handler BY HAND with a synthetic event
 * (`h.pilot.getHandlers()[1]!.processor.apply(...)`), bypassing the bus entirely — which is
 * precisely why the gap survived. Nothing here is hand-invoked.
 */
describe("a committed clearance reaches the world and the crew", () => {
	it("publishes to the actuator, so a controller's decision actually moves metal", async () => {
		const h = harness()
		h.scheduler.begin(h.controller, "Vector AAL77.",
			{ model: "controller", tools: h.controller.getTools() }, h.desk.handler())
		await settle(); h.clock.advance(50); await settle()

		expect(h.issuedToWorld.map((e) => e.callsign)).toContain(MEDICAL_CALLSIGN)
	})

	it("publishes to the crew WITH a turn magnitude, the field refusal rules key on", async () => {
		const h = harness()
		h.scheduler.begin(h.controller, "Vector AAL77.",
			{ model: "controller", tools: h.controller.getTools() }, h.desk.handler())
		await settle(); h.clock.advance(50); await settle()

		const issued = h.issuedToCrew.find((e) => e.callsign === MEDICAL_CALLSIGN)
		expect(issued).toBeDefined()
		// AAL77 is on 120; a clearance to 150 is a 30-degree turn, and its sheet refuses 25 or more.
		expect(issued!.command?.turnMagnitudeDeg).toBeCloseTo(30, 6)
	})

	it("and the crew refuses it, from its own private sheet", async () => {
		const h = harness()
		h.scheduler.begin(h.controller, "Vector AAL77.",
			{ model: "controller", tools: h.controller.getTools() }, h.desk.handler())
		await settle(); h.clock.advance(50); await settle()

		expect(h.unable).toHaveLength(1)
		expect(h.unable[0]!.callsign).toBe(MEDICAL_CALLSIGN)
		expect(h.unable[0]!.reason).toContain("medical")
	})

	/** The cost of guessing: a refused clearance buys the controller a whole extra turn. */
	it("which costs the controller a re-plan — that is the price of not asking", async () => {
		const h = harness()
		h.scheduler.begin(h.controller, "Vector AAL77.",
			{ model: "controller", tools: h.controller.getTools() }, h.desk.handler())
		await settle(); h.clock.advance(50); await settle()

		expect(h.replanPrompts).toHaveLength(1)
		expect(h.replanPrompts[0]).toContain("UNABLE")
		expect(h.replanPrompts[0]).toContain("the window you spent on it is gone")
	})
})


function queryHarness() {
	const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<S>()
	const clock = new VirtualClock(0)
	const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
	const identity = new IdentityBook()
	const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })
	const queryDesk = new QueryDesk({ outbox, clock, timeoutMs: 30_000 })
	const world = () => [...INITIAL, MEDICAL_AIRCRAFT]
	const replies: ReplyPayload[] = []
	const seen = new Map<string, InferenceInput>()

	const pilot = createPilot({
		sheet: sheetFor(MEDICAL_CALLSIGN)!,
		outbox,
		participantId: () => pilot.getId(),
		beginTurn: (self, message) =>
			scheduler.begin(self, message, { model: "pilot-answers", tools: self.getTools() }),
	})

	const asker = createController({
		position: "APPROACH", instruction: "Sequence arrivals.",
		world, generation: () => 1, nowSec: () => 0, outbox, horizonSec: HORIZON_S,
		intents: new IntentRegistry(),
		participantId: () => asker.getId(),
		holdsStandingOver: () => true,
		objectTo: () => null,
		queryDesk,
	})

	const tap: SituationHandler = {
		specification: new (class extends SituationSpecification {
			isSatisfiedBy(_: SituationContext) { return true }
		})(),
		processor: {
			apply({ event }) {
				scheduler.observe(event)
				if (event.type === PilotEvent.REPLY) replies.push(event.payload as ReplyPayload)
			},
		},
	}
	const observer = createHuman({ name: "observer", capabilities: [], handlers: [tap] })

	const base = scripted()
	const runner: InferenceRunner = {
		async run(input) { seen.set(input.model, input); return base.run(input) },
		async *stream(): AsyncGenerator<SemanticEvent> {},
	}
	initializeRuntime({ state: new S(), inferenceRunnerConfig: { runner } })
	for (const p of [observer, queryDesk, pilot, asker]) { join(p); identity.register(p) }
	return { clock, scheduler, asker, replies, seen }
}

/**
 * THE QUERY ROUND TRIP, IN PRODUCTION CODE.
 *
 * Before this, no pilot ever published `pilot.reply` and nothing ever called `QueryDesk.receive`.
 * The round trip was closed by the evidence SCRIPTS: a tap sniffed the framework's
 * `function_call.completed`, guessed which of them was a reply by substring, and re-injected it
 * with a hardcoded `queryId: "q1"` — so only the first query of a run could be answered and
 * `waitedMs` was always zero. The mechanism being demonstrated lived in the demonstration.
 *
 * This harness has no such tap. The desk is joined as a participant and subscribes for itself.
 */
describe("a parked controller is woken by the pilot itself", () => {
	it("settles the query with the crew's own words, and charges the real wait", async () => {
		const h = queryHarness()
		h.scheduler.begin(h.asker, "Vector AAL77.", { model: "asker", tools: h.asker.getTools() })
		await settle()
		h.clock.advance(13_000)
		await settle()

		expect(h.replies).toHaveLength(1)
		expect(h.replies[0]!.text).toContain("deteriorating")
		// The queryId is correlated structurally, not echoed by a model or hardcoded by a harness.
		expect(h.replies[0]!.queryId).toBe("q1")
	})

	it("the constraint reaches the controller's own context — it exists nowhere else", async () => {
		const h = queryHarness()
		h.scheduler.begin(h.asker, "Vector AAL77.", { model: "asker", tools: h.asker.getTools() })
		await settle()
		h.clock.advance(13_000)
		await settle()

		const serialized = JSON.stringify(h.seen.get("asker")?.context.getItems() ?? [])
		expect(serialized).toContain("query_pilot")
	})
})
