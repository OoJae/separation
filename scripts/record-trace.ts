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
import { MIMO_MODEL_NAME, mimoFromEnv } from "../src/infrastructure/inference/mimo"
import { WorldEngine } from "../src/infrastructure/simulation/world-engine"
import { TurnScheduler } from "../src/infrastructure/scheduling/turn-scheduler"
import { ControllerEvent, createController, type ObjectionPayload } from "../src/participants/controller"
import { IdentityBook } from "../src/participants/identity-book"
import { InterlockDesk } from "../src/participants/interlock-desk"
import { StandingBroker } from "../src/participants/standing-broker"
import { WorldParticipant } from "../src/participants/world"
import { WorldEvent } from "../src/events/world-events"
import { MASTER_TICK_MS } from "../src/domain/airspace/units"
import { OPENING, controllerBriefing } from "../src/scenarios/briefing"
import { HORIZON_S, INITIAL, WINDOWS, clearanceA, clearanceB, narrowingCandidatesForA } from "../src/scenarios/braid-2"
import { OutboxDispatcher } from "../src/support/outbox"
import { SystemClock } from "../src/support/ports"

class TraceState extends RuntimeState {}

/**
 * NO KEY REQUIRED for a cached replay.
 *
 * This used to exit(2) when the endpoint was unconfigured — above any cache lookup — which made
 * the README's "zero API calls and no key" false for the first command a judge runs. The model
 * object is only needed for a cache MISS: `LiveInferenceRunner.run` consults the cache before the
 * budget and before any provider call, and a genuine miss degrades to a refusal VALUE rather than
 * throwing. So we carry on without it and say which mode we are in.
 */
const mimo = mimoFromEnv()
const modelName = mimo?.specification.name ?? MIMO_MODEL_NAME
if (mimo === null) console.log("No endpoint configured — replaying from the committed cache only.")

const clock = new SystemClock()
const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<TraceState>()
const identity = new IdentityBook()
const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
const tracer = new TraceWriter({ clock, nameOf: (id) => identity.nameOf(id), scenario: "BRAID-2" })
const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })
const intents = new IntentRegistry()

const engine = WorldEngine.init([...INITIAL])
const world = WorldParticipant.init({ engine, outbox })
const SETTLE_MS = 2_500
// Declared here because the desk's worldAtMs closes over it — the world clock must exist before
// anything that reads it.
let tick = 0
const desk = InterlockDesk.init({
	world: () => engine.states(),
	// engine.states() is LIVE — it advances every tick — so the desk must be told which instant its
	// snapshot describes, or a clearance committed now would be flown as though the aircraft were
	// still where they started.
	worldAtMs: () => tick * MASTER_TICK_MS,
	windows: WINDOWS, horizonSec: HORIZON_S, clock, outbox,
	settleMs: SETTLE_MS, intents,
	narrowingCandidates: (s) => (s.callsign === "AAL221" ? narrowingCandidatesForA() : []),
})
const broker = StandingBroker.init({ outbox, clock })

const runner = new LiveInferenceRunner({
	scripted: () => { throw new Error("no synthetic models here") },
	isSynthetic: () => false,
	cache: new InferenceCache("fixtures/live-cache.jsonl"),
	budget: new BudgetGuard(Number(process.argv.find((a) => a.startsWith("--calls="))?.split("=")[1] ?? 0)),
	clock, measure: () => performance.now(), extraModels: mimo ? [mimo] : [],
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

const actuated: string[] = []
const tap: SituationHandler = {
	specification: new (class extends SituationSpecification {
		isSatisfiedBy(_: SituationContext) { return true }
	})(),
	processor: {
		apply({ event }) {
			scheduler.observe(event)
			tracer.observe(event)
			// Did a controller's decision actually reach the metal, or only the transcript?
			if (event.type === WorldEvent.COMMAND_ISSUED) {
				const p = event.payload as { callsign?: string }
				actuated.push(String(p.callsign))
			}
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
const template = { model: modelName, maxOutputTokens: 2_000 }
scheduler.begin(approach, OPENING.APPROACH, { ...template, tools: approach.getTools() }, desk.handler())
scheduler.begin(flow, OPENING.FLOW, { ...template, tools: flow.getTools() }, desk.handler())

await new Promise((r) => setTimeout(r, 400))

/**
 * Fly 380 simulated seconds at roughly 10x real time.
 *
 * This used to run at ~400x, finishing the whole encounter in about one real second — which meant
 * the controllers, thinking on the wall clock for tens of seconds, could never commit anything
 * while the world was still moving. Their clearances were therefore recorded but never flown, and
 * the trace showed a hardcoded BRAID-2 instead of the decisions the models actually made.
 *
 * `WorldParticipant` subscribes to `actuator.command.issued`, so at this pace a committed
 * clearance genuinely reaches the metal. The scripted BRAID-2 pair is still applied — it is the
 * scenario's own traffic, and the hazard has to exist for anyone to catch it — but a controller's
 * commit now lands on top of it, and the report says whether one did.
 */
const applied = new Set<string>()
const clearances = [clearanceA(), clearanceB()]
const TOTAL_TICKS = HORIZON_S * 100
const TARGET_FLIGHT_MS = SETTLE_MS * 4
const TICKS_PER_INTERVAL = Math.max(1, Math.floor(TOTAL_TICKS / TARGET_FLIGHT_MS))
/**
 * Pace derived from the airlock, not chosen.
 *
 * A commit cannot be released before the desk's settle window has elapsed on the wall clock, so if
 * the world finishes flying first the controllers' clearances arrive after the metal has stopped
 * moving and nothing they decided is ever flown. At a fixed 10 ticks per interval that was a RACE
 * — comfortable on one machine, lost on another — and "2 controller commands flown" is a headline,
 * so it must not depend on how fast the host is. Sizing the flight at 4x the settle window makes
 * the margin explicit and derived; if settleMs changes, the pace follows it.
 */
await new Promise<void>((resolve) => {
	const timer = setInterval(() => {
		for (let i = 0; i < TICKS_PER_INTERVAL && tick < TOTAL_TICKS; i++) {
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
console.log(`  actuated  : ${actuated.length === 0
	? "NO controller command reached the metal"
	: `${actuated.length} controller command(s) flown -> ${[...new Set(actuated)].join(", ")}`}`)
console.log(`  OVERLAPPING TURNS: ${overlaps.length}` + (overlaps.length > 0
	? `  ${overlaps.map((o) => `${o.a.participant}+${o.b.participant} for ${Math.round(o.ms)}ms`).join(", ")}`
	: "  — no two agents were ever thinking at once"))
for (const b of trace.beats) console.log(`  beat   : ${b.kind.padEnd(9)} ${b.text}`)
console.log(`\n  wrote fixtures/trace.json (${(JSON.stringify(trace).length / 1024).toFixed(0)} KB)`)
process.exit(overlaps.length > 0 && trace.meta.frames > 0 ? 0 : 1)
