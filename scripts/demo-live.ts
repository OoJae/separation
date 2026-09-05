/**
 * THE MONEY SHOT, LIVE.
 *
 * Two controllers with contested authority over one aircraft, both mid-turn, on a real model.
 * Bounded by --calls so a run costs cents; every answer is cached, so a repeat run costs nothing.
 */
import "dotenv/config"
import { RuntimeState, SituationSpecification, createHuman, defineRuntime } from "@mozaik-ai/core"
import type { SituationContext, SituationHandler } from "@mozaik-ai/core"
import { IntentRegistry } from "../src/domain/interlock/intent-registry"
import { BudgetGuard } from "../src/infrastructure/inference/budget-guard"
import { InferenceCache } from "../src/infrastructure/inference/inference-cache"
import { LiveInferenceRunner } from "../src/infrastructure/inference/live-runner"
import { mimoFromEnv } from "../src/infrastructure/inference/mimo"
import { seatFor } from "../src/infrastructure/inference/model-roster"
import { TurnScheduler } from "../src/infrastructure/scheduling/turn-scheduler"
import { ControllerEvent, createController, type ObjectionPayload } from "../src/participants/controller"
import { IdentityBook } from "../src/participants/identity-book"
import { InterlockDesk } from "../src/participants/interlock-desk"
import { StandingBroker } from "../src/participants/standing-broker"
import { HORIZON_S, INITIAL, WINDOWS, narrowingCandidatesForA } from "../src/scenarios/braid-2"
import { OutboxDispatcher } from "../src/support/outbox"
import { SystemClock } from "../src/support/ports"

class LiveState extends RuntimeState {}

const calls = Number(process.argv.find((a) => a.startsWith("--calls="))?.split("=")[1] ?? 12)
const mimo = mimoFromEnv()
if (mimo === null) {
	console.log("No model configured. Set ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL in .env.")
	process.exit(2)
}

const clock = new SystemClock()
const cache = new InferenceCache("fixtures/live-cache.jsonl")
const budget = new BudgetGuard(calls)
const runner = new LiveInferenceRunner({
	scripted: () => { throw new Error("no synthetic models in the live demo") },
	isSynthetic: () => false,
	cache, budget, clock, measure: () => performance.now(), extraModels: [mimo],
})

const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<LiveState>()
const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
const identity = new IdentityBook()
const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })
const intents = new IntentRegistry()
const world = () => [...INITIAL]

const desk = InterlockDesk.init({
	world, windows: WINDOWS, horizonSec: HORIZON_S, clock, outbox, settleMs: 2_500, intents,
	narrowingCandidates: (s) => (s.callsign === "AAL221" ? narrowingCandidatesForA() : []),
})
const broker = StandingBroker.init({ outbox, clock })

const log: string[] = []
const inflightAtObjection: string[][] = []
const say = (line: string) => { log.push(line); console.log(line) }

const instructionFor = (position: "APPROACH" | "FLOW") => {
	const seat = seatFor(position)
	return `You are the ${position} controller in a busy TRACON sector. Your authority: ${seat.authority}.
Your objective: ${seat.objective}

Traffic: AAL221 is at 9000 ft descending toward the runway. SWA455 is at 6000 ft on a converging
track. Both at 250 knots. You share authority over AAL221 with another controller who has a
DIFFERENT objective, so announce your intent before you commit.

Work in this order, one tool per step:
  1. assess_traffic
  2. probe_feasible for the aircraft you intend to move
  3. propose_clearance  (announce it — peers may object)
  4. commit_clearance   (your commit may be narrowed by a peer before it executes)
Keep your reasoning to one short sentence per step.`
}

const common = {
	world, generation: () => 1, nowSec: () => 0, outbox, horizonSec: HORIZON_S, intents,
}
const approach = createController({
	...common, position: "APPROACH", instruction: instructionFor("APPROACH"),
	participantId: () => approach.getId(),
	holdsStandingOver: (cs) => broker.holds("APPROACH", cs),
	objectTo: () => null,
})
const flow = createController({
	...common, position: "FLOW", instruction: instructionFor("FLOW"),
	participantId: () => flow.getId(),
	holdsStandingOver: (cs) => broker.holds("FLOW", cs),
	objectTo: (intent) =>
		intent.callsign === "AAL221" && (intent.command.targetAltFt ?? Infinity) <= 6_000
			? { reason: "that descent crosses my metering block at CARDL", suggestTargetAltFt: 7_000 }
			: null,
})

const tap: SituationHandler = {
	specification: new (class extends SituationSpecification {
		isSatisfiedBy(_: SituationContext) { return true }
	})(),
	processor: {
		apply({ event }) {
			scheduler.observe(event)
			const name = identity.nameOf(event.producerId)
			if (event.type === ControllerEvent.INTENT_FORMING) {
				const p = event.payload as { controller: string; callsign: string; clearanceId: string }
				say(`  [intent.forming]   ${p.controller} -> ${p.callsign} (${p.clearanceId})   inflight: ${scheduler.inflight().length}`)
			}
			if (event.type === ControllerEvent.OBJECTION_RAISED) {
				const p = event.payload as ObjectionPayload
				inflightAtObjection.push([...scheduler.inflight()])
				say(`  [objection.raised] ${p.by} -> ${p.against}: "${p.reason}"   INFLIGHT AT THIS MOMENT: ${scheduler.inflight().length}`)
				desk.object({ by: p.by, clearanceId: p.clearanceId, reason: p.reason, suggestTargetAltFt: p.suggestTargetAltFt })
			}
			if (event.type === "function_call.started") {
				const p = event.payload as { call?: { name?: string } }
				if (p.call?.name) say(`  [tool]             ${name} -> ${p.call.name}`)
			}
		},
	},
}
const observer = createHuman({ name: "observer", capabilities: [], handlers: [tap] })

initializeRuntime({ state: new LiveState(), inferenceRunnerConfig: { runner } })
for (const p of [observer, broker, desk, approach, flow]) { join(p); identity.register(p) }

broker.bidSync({ controller: "APPROACH", callsign: "AAL221", objective: "runway-sequence", durationMs: 300_000 })
broker.bidSync({ controller: "FLOW", callsign: "AAL221", objective: "metering-interval", durationMs: 300_000 })

console.log(`LIVE — ${mimo.specification.name}, budget ${calls} calls\n`)
console.log(`  standing over AAL221: ${broker.holdersOver("AAL221").join(", ")}\n`)

const template = { model: mimo.specification.name, maxOutputTokens: seatFor("APPROACH").maxOutputTokens }
scheduler.begin(approach, "Sequence AAL221 for the approach.", { ...template, tools: approach.getTools() }, desk.handler())
scheduler.begin(flow, "Protect the metering interval at CARDL.", { ...template, tools: flow.getTools() }, desk.handler())

await new Promise((r) => setTimeout(r, 180_000))

console.log(`\n${"=".repeat(72)}`)
const overlapped = inflightAtObjection.some((s) => s.length >= 2)
console.log(`  objections raised            : ${inflightAtObjection.length}`)
console.log(`  both turns open when it landed: ${overlapped ? "YES" : "no"}`)
for (const d of desk.log()) {
	console.log(`  desk: ${d.turnId} ${d.outcome.padEnd(9)} -> ${d.committed.id} ${JSON.stringify(d.committed.command)}`)
}
const stats = cache.stats()
console.log(`  live calls: ${budget.used()}   cache ${stats.hits} hit / ${stats.misses} miss`)
console.log(`  latencies:  ${runner.log().filter((c) => !c.cached).map((c) => `${c.latencyMs}ms`).join(", ")}`)
process.exit(overlapped ? 0 : 1)
