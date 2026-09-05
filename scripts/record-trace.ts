/**
 * Record the trace the viewer renders.
 *
 * The demo PRINTS the money shot; this RECORDS it, and additionally drives the world so the scope
 * has positions to draw. Both replay from the committed inference cache, so this costs nothing and
 * is reproducible by anyone who clones the repo.
 *
 * The world is stepped faster than real time — 380 simulated seconds in a few real ones — because
 * the aircraft are deterministic and nothing is gained by watching them fly at 1x. The controllers
 * run concurrently on the real bus throughout, so the turn spans are genuine wall-clock overlaps
 * rather than a fast-forward artefact.
 */
import "dotenv/config"
import { RuntimeState, SituationSpecification, createHuman, defineRuntime } from "@mozaik-ai/core"
import type { SituationContext, SituationHandler } from "@mozaik-ai/core"
import { mkdirSync, writeFileSync } from "node:fs"
import { IntentRegistry } from "../src/domain/interlock/intent-registry"
import { TraceWriter } from "../src/instrument/trace-writer"
import { BudgetGuard } from "../src/infrastructure/inference/budget-guard"
import { InferenceCache } from "../src/infrastructure/inference/inference-cache"
import { LiveInferenceRunner } from "../src/infrastructure/inference/live-runner"
import { mimoFromEnv } from "../src/infrastructure/inference/mimo"
import { WorldEngine } from "../src/infrastructure/simulation/world-engine"
import { TurnScheduler } from "../src/infrastructure/scheduling/turn-scheduler"
import { ControllerEvent, createController, type ObjectionPayload } from "../src/participants/controller"
import { IdentityBook } from "../src/participants/identity-book"
import { InterlockDesk } from "../src/participants/interlock-desk"
import { StandingBroker } from "../src/participants/standing-broker"
import { WorldParticipant } from "../src/participants/world"
import { OPENING, controllerBriefing } from "../src/scenarios/briefing"
import { HORIZON_S, INITIAL, WINDOWS, clearanceA, clearanceB, narrowingCandidatesForA } from "../src/scenarios/braid-2"
import { OutboxDispatcher } from "../src/support/outbox"
import { SystemClock } from "../src/support/ports"

class TraceState extends RuntimeState {}

const mimo = mimoFromEnv()
if (mimo === null) { console.log("Set ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL in .env."); process.exit(2) }

const clock = new SystemClock()
const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<TraceState>()
const identity = new IdentityBook()
const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
const tracer = new TraceWriter({ clock, nameOf: (id) => identity.nameOf(id), scenario: "BRAID-2" })
const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })
const intents = new IntentRegistry()

const engine = WorldEngine.init([...INITIAL])
const world = WorldParticipant.init({ engine, outbox })
const desk = InterlockDesk.init({
	world: () => engine.states(), windows: WINDOWS, horizonSec: HORIZON_S, clock, outbox,
	settleMs: 2_500, intents,
	narrowingCandidates: (s) => (s.callsign === "AAL221" ? narrowingCandidatesForA() : []),
})
const broker = StandingBroker.init({ outbox, clock })

const runner = new LiveInferenceRunner({
	scripted: () => { throw new Error("no synthetic models here") },
	isSynthetic: () => false,
	cache: new InferenceCache("fixtures/live-cache.jsonl"),
	budget: new BudgetGuard(Number(process.argv.find((a) => a.startsWith("--calls="))?.split("=")[1] ?? 0)),
	clock, measure: () => performance.now(), extraModels: [mimo],
})

const common = {
	world: () => engine.states(), generation: () => 1, nowSec: () => 0,
	outbox, horizonSec: HORIZON_S, intents,
}
const approach = createController({
	...common, position: "APPROACH", instruction: controllerBriefing("APPROACH"),
	participantId: () => approach.getId(),
	holdsStandingOver: (cs) => broker.holds("APPROACH", cs),
	objectTo: () => null,
})
const flow = createController({
	...common, position: "FLOW", instruction: controllerBriefing("FLOW"),
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
			tracer.observe(event)
			if (event.type === ControllerEvent.OBJECTION_RAISED) {
				const p = event.payload as ObjectionPayload
				desk.object({ by: p.by, clearanceId: p.clearanceId, reason: p.reason, suggestTargetAltFt: p.suggestTargetAltFt })
			}
		},
	},
}
const observer = createHuman({ name: "observer", capabilities: [], handlers: [tap] })

initializeRuntime({ state: new TraceState(), inferenceRunnerConfig: { runner } })
for (const p of [observer, world, broker, desk, approach, flow]) { join(p); identity.register(p) }
broker.bidSync({ controller: "APPROACH", callsign: "AAL221", objective: "runway-sequence", durationMs: 400_000 })
broker.bidSync({ controller: "FLOW", callsign: "AAL221", objective: "metering-interval", durationMs: 400_000 })

console.log("Recording BRAID-2 — world + controllers, replaying from cache\n")

// Start both controllers thinking, then fly the world underneath them.
const template = { model: mimo.specification.name, maxOutputTokens: 2_000 }
scheduler.begin(approach, OPENING.APPROACH, { ...template, tools: approach.getTools() }, desk.handler())
scheduler.begin(flow, OPENING.FLOW, { ...template, tools: flow.getTools() }, desk.handler())

await new Promise((r) => setTimeout(r, 400))

// Fly 380 simulated seconds. The aircraft are deterministic, so there is nothing to learn from
// watching them at 1x; the controllers keep running on the real bus the whole time.
const applied = new Set<string>()
const clearances = [clearanceA(), clearanceB()]
const TOTAL_TICKS = HORIZON_S * 100
let tick = 0
await new Promise<void>((resolve) => {
	const timer = setInterval(() => {
		for (let i = 0; i < 400 && tick < TOTAL_TICKS; i++) {
			tick++
			for (const c of clearances) {
				if (tick >= c.effectiveTick && !applied.has(c.id)) {
					applied.add(c.id)
					engine.command(c.callsign, c.command)
				}
			}
			world.publishTick(engine.step())
		}
		if (tick >= TOTAL_TICKS) { clearInterval(timer); resolve() }
	}, 1)
})

// Let the airlock settle before finishing, so the turns actually close and the narrowing lands.
// The world flew 380 simulated seconds in about one real second; the desk's settle timer runs on
// the real clock, so it has not fired yet.
const SETTLE_CAP_MS = 15_000
const settleStart = performance.now()
while (performance.now() - settleStart < SETTLE_CAP_MS) {
	await new Promise((r) => setTimeout(r, 100))
	if (scheduler.isQuiescent() && desk.isQuiescent()) break
}

const trace = tracer.finish()
const overlaps = TraceWriter.overlaps(trace)
mkdirSync("fixtures", { recursive: true })
writeFileSync("fixtures/trace.json", JSON.stringify(trace))

console.log(`  frames : ${trace.meta.frames}   turns: ${trace.meta.turns}   events: ${trace.meta.events}   beats: ${trace.beats.length}`)
console.log(`  OVERLAPPING TURNS: ${overlaps.length}` + (overlaps.length > 0
	? `  ${overlaps.map((o) => `${o.a.participant}+${o.b.participant} for ${Math.round(o.ms)}ms`).join(", ")}`
	: "  — no two agents were ever thinking at once"))
for (const b of trace.beats) console.log(`  beat   : ${b.kind.padEnd(9)} ${b.text}`)
console.log(`\n  wrote fixtures/trace.json (${(JSON.stringify(trace).length / 1024).toFixed(0)} KB)`)
process.exit(overlaps.length > 0 && trace.meta.frames > 0 ? 0 : 1)
