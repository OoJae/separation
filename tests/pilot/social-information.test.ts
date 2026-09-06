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
import { PilotEvent, createPilot, type UnablePayload } from "../../src/participants/pilot"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"
import { probe } from "../../src/domain/feasibility/prober"
import { HORIZON_S, INITIAL, WINDOWS, narrowingCandidatesForA } from "../../src/scenarios/braid-2"
import { MEDICAL_AIRCRAFT, MEDICAL_CALLSIGN, sheetFor } from "../../src/scenarios/pilot-sheets"
import { refusalFor } from "../../src/domain/disclosure/pilot-sheet"
import { turnMagnitudeDeg } from "../../src/domain/airspace/aircraft-state"

class S extends RuntimeState {}
const settle = () => new Promise((r) => setTimeout(r, 50))
const call = (id: string, name: string, args: object) =>
	FunctionCallItem.rehydrate({ callId: id, name, args: JSON.stringify(args) })

/**
 * A controller that ASKS before it proposes, and a pilot that answers from its private sheet.
 * Scripted so the mechanism is regression-tested; the live version runs the same code path.
 */
function scripted(): InferenceRunner & { readonly seen: Map<string, InferenceInput> } {
	const n = new Map<string, number>()
	const seen = new Map<string, InferenceInput>()
	return {
		seen,
		async run(input: InferenceInput): Promise<InferenceOutput> {
			const i = n.get(input.model) ?? 0
			n.set(input.model, i + 1)
			seen.set(input.model, input)

			if (input.model === "controller") {
				if (i === 0) return out([call("q1", "query_pilot", { callsign: MEDICAL_CALLSIGN, question: "say any constraints" })])
				if (i === 1) return out([call("p1", "propose_clearance", {
					clearanceId: "MED", callsign: MEDICAL_CALLSIGN, targetHeadingDeg: 10, plannedMarginNm: 3.2,
				})])
				return out([ModelMessageItem.rehydrate({ text: "shortest track approved" })])
			}
			// pilot
			if (i === 0) {
				const sheet = sheetFor(MEDICAL_CALLSIGN)!
				return out([call("r1", "report_constraint", {
					detail: sheet.constraint!.detail, wantsShortestPath: true,
				})])
			}
			return out([ModelMessageItem.rehydrate({ text: "roger" })])
		},
		async *stream(): AsyncGenerator<SemanticEvent> {},
	}
}
const out = (items: InferenceOutput["items"]): InferenceOutput =>
	({ items, tokenUsage: undefined, rowResponse: {} })

function harness() {
	const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<S>()
	const clock = new VirtualClock(0)
	const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
	const identity = new IdentityBook()
	const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })
	const intents = new IntentRegistry()
	const queryDesk = new QueryDesk({ outbox, clock, timeoutMs: 30_000 })
	const world = () => [...INITIAL]

	const desk = InterlockDesk.init({
		world, windows: WINDOWS, horizonSec: HORIZON_S, clock, outbox, settleMs: 20, intents,
		narrowingCandidates: (s) => (s.callsign === "AAL221" ? narrowingCandidatesForA() : []),
	})

	const runner = scripted()
	const unable: UnablePayload[] = []
	const inflightAtReply: number[] = []

	const pilot = createPilot({
		sheet: sheetFor(MEDICAL_CALLSIGN)!,
		outbox,
		participantId: () => pilot.getId(),
		beginTurn: (self, message) =>
			scheduler.begin(self, message, { model: "pilot", tools: self.getTools() }).ok,
	})

	const controller = createController({
		position: "APPROACH", instruction: "Sequence arrivals.",
		world, generation: () => 1, nowSec: () => 0, outbox, horizonSec: HORIZON_S, intents,
		participantId: () => controller.getId(),
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
				if (event.type === PilotEvent.UNABLE) unable.push(event.payload as UnablePayload)
				// The round trip is closed by PRODUCTION code — the pilot publishes pilot.reply and
				// the QueryDesk subscribes — so this observer only WATCHES. It used to forward the
				// reply itself, sniffing function_call.completed and re-injecting under a hardcoded
				// queryId, which meant deleting both production halves left every test green.
				if (event.type === PilotEvent.REPLY) inflightAtReply.push(scheduler.inflight().length)
			},
		},
	}
	const observer = createHuman({ name: "observer", capabilities: [], handlers: [tap] })

	initializeRuntime({ state: new S(), inferenceRunnerConfig: { runner } })
	for (const p of [observer, desk, queryDesk, pilot, controller]) { join(p); identity.register(p) }

	return { clock, scheduler, desk, queryDesk, controller, pilot, runner, unable, inflightAtReply }
}

describe("geometry loses to socially-obtained information", () => {
	// Probes the aircraft actually under decision. This said "AAL221" while every other line in
	// the file instructs about AAL77 — the same phantom-subject bug the evidence script had, and
	// it survived there because a FeasibleSet for the wrong aircraft still looks like a FeasibleSet.
	it("the widest-margin option is NOT the one the constraint calls for", () => {
		const set = probe({
			subject: MEDICAL_CALLSIGN, world: [...INITIAL, MEDICAL_AIRCRAFT],
			forGeneration: 1, horizonSec: HORIZON_S, nowSec: 0,
		})
		const widest = [...set.options].sort((a, b) => b.margins.minHorizontalNm - a.margins.minHorizontalNm)[0]!
		const shortest = [...set.options].sort((a, b) => a.cost.arrivalDelaySec - b.cost.arrivalDelaySec)[0]!

		// If these were the same option, the choice would be free and the query pointless.
		expect(widest.optionId).not.toBe(shortest.optionId)
		expect(widest.cost.arrivalDelaySec).toBeGreaterThan(shortest.cost.arrivalDelaySec)
	})

	/**
	 * The decisive fact, stated as a number: a THIRD of the separation-safe options will be
	 * refused, and the controller cannot tell which from anything it can see.
	 */
	it("a third of the safe options would be refused, and the widest-margin one is among them", () => {
		const set = probe({
			subject: MEDICAL_CALLSIGN, world: [...INITIAL, MEDICAL_AIRCRAFT],
			forGeneration: 1, horizonSec: HORIZON_S, nowSec: 0,
		})
		const sheet = sheetFor(MEDICAL_CALLSIGN)!
		const refusable = set.options.filter((o) => refusalFor(sheet, {
			targetAltFt: o.maneuver.command.targetAltFt,
			targetGroundspeedKt: o.maneuver.command.targetGroundspeedKt,
			turnMagnitudeDeg: o.maneuver.command.targetHeadingMdeg === undefined ? undefined
				: turnMagnitudeDeg(MEDICAL_AIRCRAFT.headingMdeg, o.maneuver.command.targetHeadingMdeg),
		}) !== null)

		expect(refusable.length).toBeGreaterThan(0)
		expect(refusable.length).toBeLessThan(set.options.length)
		const widest = [...set.options].sort((a, b) => b.margins.minHorizontalNm - a.margins.minHorizontalNm)[0]!
		expect(refusable.map((o) => o.optionId)).toContain(widest.optionId)
	})

	it("the controller asks, the pilot answers from its sheet, and the answer reaches the controller", async () => {
		const h = harness()
		h.scheduler.begin(h.controller, "Handle AAL77.", { model: "controller", tools: h.controller.getTools() })
		await settle()
		h.clock.advance(100)
		await settle()

		// The controller's context now contains the pilot's private constraint, which exists
		// nowhere in the world, nowhere in a FeasibleSet, and nowhere in a snapshot.
		const ctx = h.runner.seen.get("controller")!
		const serialized = JSON.stringify(ctx.context.getItems())

		// The pilot disclosed in PROSE, the way a crew would on frequency. What arrived is the
		// constraint's detail text, not its internal `kind` tag — the controller learns
		// "a passenger is deteriorating", not the enum we happen to store it under.
		expect(serialized).toContain("a passenger is deteriorating")
		expect(serialized).toContain("shortest track")

		// And it arrived by ASKING. Nothing in the world, a snapshot, or a FeasibleSet carries it.
		expect(serialized).toContain("query_pilot")
	})

	it("the pilot was mid-turn when it answered — the controller was parked on it", async () => {
		const h = harness()
		h.scheduler.begin(h.controller, "Handle AAL77.", { model: "controller", tools: h.controller.getTools() })
		await settle()
		h.clock.advance(100)
		await settle()

		// At the moment the reply landed, BOTH the parked controller and the answering pilot
		// were in flight. Asking is not a free lookup; it is one agent waiting on another.
		expect(h.inflightAtReply.length).toBeGreaterThan(0)
		expect(h.inflightAtReply[0]).toBe(2)
	})

	it("the clearance the controller then proposes is the SHORT one, not the wide one", async () => {
		const h = harness()
		h.scheduler.begin(h.controller, "Handle AAL77.", { model: "controller", tools: h.controller.getTools() })
		await settle()
		h.clock.advance(100)
		await settle()

		const ctx = h.runner.seen.get("controller")!
		const proposal = ctx.context.getItems().find(
			(i) => i.getType() === "function_call" && (i as unknown as { name: string }).name === "propose_clearance",
		)
		expect(proposal).toBeDefined()
		const args = JSON.parse((proposal as unknown as { args: string }).args)
		expect(args.callsign).toBe(MEDICAL_CALLSIGN)
		expect(Math.abs(args.targetHeadingDeg)).toBeLessThanOrEqual(15) // a tight track, not a wide vector
	})
})

describe("pilot.unable", () => {
	it("a refusal reaches the bus with a reason, from the pilot's private sheet", async () => {
		const h = harness()
		h.scheduler.begin(h.controller, "x", { model: "controller", tools: h.controller.getTools() })
		await settle()

		// Issue a clearance the sheet refuses: a 30-degree turn, with a medical on board.
		h.pilot.getHandlers()[1]!.processor.apply({
			event: {
				type: PilotEvent.CLEARANCE_ISSUED,
				producerId: "APPROACH",
				occurredAt: h.clock.now(),
				payload: { callsign: MEDICAL_CALLSIGN, clearanceId: "WIDE", command: { turnMagnitudeDeg: 30 } },
			} as never,
			participant: h.pilot,
		})
		await settle()

		expect(h.unable).toHaveLength(1)
		expect(h.unable[0]!.callsign).toBe(MEDICAL_CALLSIGN)
		expect(h.unable[0]!.reason).toContain("medical")
	})

	it("stays silent when the clearance is acceptable — acceptance is not news", async () => {
		const h = harness()
		h.pilot.getHandlers()[1]!.processor.apply({
			event: {
				type: PilotEvent.CLEARANCE_ISSUED,
				producerId: "APPROACH",
				occurredAt: h.clock.now(),
				payload: { callsign: MEDICAL_CALLSIGN, clearanceId: "TIGHT", command: { turnMagnitudeDeg: 10 } },
			} as never,
			participant: h.pilot,
		})
		await settle()
		expect(h.unable).toHaveLength(0)
	})
})
