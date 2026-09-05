/**
 * GEOMETRY LOSES TO SOCIALLY-OBTAINED INFORMATION.
 *
 * A controller with a live model faces a real choice: take the widest-margin option the geometry
 * offers, or spend part of its manoeuvre window asking the pilot what it cannot see. Here the
 * right answer is only reachable by asking.
 *
 * Replays free from fixtures/live-cache.jsonl.
 */
import "dotenv/config"
import { RuntimeState, SituationSpecification, createHuman, defineRuntime } from "@mozaik-ai/core"
import type { SituationContext, SituationHandler } from "@mozaik-ai/core"
import { probe } from "../src/domain/feasibility/prober"
import { IntentRegistry } from "../src/domain/interlock/intent-registry"
import { BudgetGuard } from "../src/infrastructure/inference/budget-guard"
import { InferenceCache } from "../src/infrastructure/inference/inference-cache"
import { LiveInferenceRunner } from "../src/infrastructure/inference/live-runner"
import { MIMO_MODEL_NAME, mimoFromEnv } from "../src/infrastructure/inference/mimo"
import { TurnScheduler } from "../src/infrastructure/scheduling/turn-scheduler"
import { QueryDesk } from "../src/participants/controller/query-desk"
import { createController } from "../src/participants/controller"
import { IdentityBook } from "../src/participants/identity-book"
import { PilotEvent, createPilot } from "../src/participants/pilot"
import { HORIZON_S, INITIAL } from "../src/scenarios/braid-2"
import { MEDICAL_AIRCRAFT, MEDICAL_CALLSIGN, PILOT_SHEETS, sheetFor } from "../src/scenarios/pilot-sheets"
import { OutboxDispatcher } from "../src/support/outbox"
import { SystemClock } from "../src/support/ports"

class S extends RuntimeState {}
const calls = Number(process.argv.find((a) => a.startsWith("--calls="))?.split("=")[1] ?? 8)
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
const cache = new InferenceCache("fixtures/live-cache.jsonl")
const budget = new BudgetGuard(calls)
const runner = new LiveInferenceRunner({
	scripted: () => { throw new Error("no synthetic models here") },
	isSynthetic: () => false, cache, budget, clock,
	measure: () => performance.now(), extraModels: mimo ? [mimo] : [],
})

const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<S>()
const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
const identity = new IdentityBook()
const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })
const queryDesk = new QueryDesk({ outbox, clock, timeoutMs: 90_000 })
// AAL77 must actually BE in the sector it is being vectored through — see MEDICAL_AIRCRAFT.
const world = () => [...INITIAL, MEDICAL_AIRCRAFT]

// The geometry, before anyone asks anything.
// The subject is the aircraft the controller is actually being asked to vector. This said
// "AAL221" while the instruction said AAL77, so the printed "geometry cannot choose" preamble
// described a different aircraft from the one under decision.
const set = probe({ subject: MEDICAL_CALLSIGN, world: world(), forGeneration: 1, horizonSec: HORIZON_S, nowSec: 0 })
const widest = [...set.options].sort((a, b) => b.margins.minHorizontalNm - a.margins.minHorizontalNm)[0]!
const shortest = [...set.options].sort((a, b) => a.cost.deltaTrackMilesNm - b.cost.deltaTrackMilesNm)[0]!

console.log(`GEOMETRY LOSES TO SOCIALLY-OBTAINED INFORMATION — ${modelName}\n`)
console.log(`  What geometry alone offers for the subject aircraft:`)
console.log(`    widest margin : ${widest.optionId.padEnd(26)} ${widest.margins.minHorizontalNm.toFixed(2)} NM, ${widest.cost.deltaTrackMilesNm.toFixed(1)} extra track miles`)
console.log(`    shortest track: ${shortest.optionId.padEnd(26)} ${shortest.margins.minHorizontalNm.toFixed(2)} NM, ${shortest.cost.deltaTrackMilesNm.toFixed(1)} extra track miles`)
console.log(`    ordering      : ${set.ordering}`)
console.log(`\n  Both are separation-safe. Geometry cannot choose between them.\n`)

const events: string[] = []
let replyText = ""
let waitedMs = 0

const pilots = PILOT_SHEETS.map((sheet) => {
	const p: ReturnType<typeof createPilot> = createPilot({
		sheet, outbox,
		participantId: () => p.getId(),
		beginTurn: (self, message) => {
			console.log(`  [pilot turn]  ${sheet.callsign} is thinking...`)
			scheduler.begin(self, message, {
				model: modelName, maxOutputTokens: 800, tools: self.getTools(),
			})
		},
	})
	return p
})

const controller = createController({
	position: "APPROACH",
	instruction: [
		`You are the APPROACH controller. ${MEDICAL_CALLSIGN} needs a vector to the runway.`,
		`Two options are separation-safe: a wide vector with more margin, or a tighter track with`,
		`fewer miles. Geometry cannot tell you which is right.`,
		``,
		`Before you decide, you may query_pilot ${MEDICAL_CALLSIGN} — but that WAITS for their`,
		`reply and spends part of your manoeuvre window. Decide whether it is worth it.`,
		`Then propose_clearance with the heading you choose.`,
	].join("\n"),
	world, generation: () => 1, nowSec: () => 0, outbox, horizonSec: HORIZON_S,
	intents: new IntentRegistry(),
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
			if (event.type === PilotEvent.QUERY) {
				const q = event.payload as { toCallsign: string; question: string }
				console.log(`  [query]       APPROACH -> ${q.toCallsign}: "${q.question}"`)
				console.log(`  [parked]      the controller is now WAITING — its turn is open and blocked`)
			}
			if (event.type === "function_call.completed") {
				const p = event.payload as { callId?: string; output?: { text?: string } }
				const text = p.output?.text ?? ""
				if (text.includes("detail") || text.includes("reported")) {
					replyText = text
					waitedMs = clock.nowMs()
					queryDesk.receive({
						queryId: "q1", callsign: MEDICAL_CALLSIGN, toController: "APPROACH",
						text, claims: [],
					}, clock.nowMs(), clock.nowMs())
				}
			}
			if (event.type === "function_call.started") {
				const p = event.payload as { call?: { name?: string; args?: string } }
				if (p.call?.name) events.push(`${identity.nameOf(event.producerId)} -> ${p.call.name}`)
			}
		},
	},
}
const observer = createHuman({ name: "observer", capabilities: [], handlers: [tap] })

initializeRuntime({ state: new S(), inferenceRunnerConfig: { runner } })
for (const p of [observer, controller, ...pilots]) { join(p); identity.register(p) }

const started = performance.now()
scheduler.begin(controller, `Vector ${MEDICAL_CALLSIGN} to the runway.`, {
	// 1_200 truncated the turn mid-sentence once AAL77 joined the traffic picture: the model was
	// still writing its options table when the budget ran out, so it emitted a partial message and
	// no tool call, and the run read as "the controller chose not to ask". A truncated turn is not
	// a decision. Sized for a three-aircraft picture with room to still call a tool afterwards.
	model: modelName, maxOutputTokens: 3_000, tools: controller.getTools(),
})
/**
 * Exit on SETTLEMENT, not on a fixed sleep.
 *
 * This was `setTimeout(r, 150_000)` — the same anti-pattern Phase 7 removed from demo-live.ts and
 * for the same reason: a fixed sleep sitting in the evidence path is indistinguishable from staging
 * at a glance, and it also capped a cache-warming run at whatever fitted in the window. Arm only
 * once a turn is actually open, since nothing is in flight at t=0, and keep the cap so a hung
 * provider cannot hang the script.
 */
const CAP_MS = 150_000
const startedWaiting = performance.now()
let armed = false
let exitReason = "cap reached"
while (performance.now() - startedWaiting < CAP_MS) {
	await new Promise((r) => setTimeout(r, 250))
	if (!armed) {
		// Arm on EITHER an open turn or evidence that one already ran. A fully-warm cache replays a
		// whole turn in well under the 250 ms poll interval, so watching inflight() alone can miss
		// the turn entirely and then wait out the cap on a run that finished immediately.
		if (scheduler.inflight().length > 0 || events.length > 0) armed = true
		continue
	}
	if (scheduler.isQuiescent()) {
		exitReason = "settled"
		break
	}
}

console.log(`\n${"=".repeat(72)}`)
console.log(`  tool sequence : ${events.join("  ->  ")}`)
const asked = events.some((e) => e.includes("query_pilot"))
console.log(`  asked the pilot: ${asked ? "YES" : "no"}`)
if (replyText) {
	const detail = (() => { try { return JSON.parse(JSON.parse(replyText).reply ?? "{}").detail } catch { return null } })()
	console.log(`  disclosed     : ${detail ?? replyText.slice(0, 100)}`)
}
console.log(`  exit          : ${exitReason} after ${Math.round(performance.now() - started)} ms`)
const stats = cache.stats()
console.log(`  live calls    : ${budget.used()}   cache ${stats.hits} hit / ${stats.misses} miss`)
// Report what happened, in both branches. This printed the PASS sentence either way, so a run
// where the controller never asked still read as "the controller spent window to obtain what
// geometry could not give it" — asserting the very thing that did not occur.
if (asked) {
	console.log(`\n  PASS — the controller spent window to obtain what geometry could not give it.`)
} else {
	console.log(`\n  FAIL — the controller did NOT query the pilot. It committed a clearance from`)
	console.log(`  geometry alone, so the decisive private fact never entered the decision.`)
	console.log(`  The mechanism is intact and proven in tests/pilot/social-information.test.ts;`)
	console.log(`  what this run reports is a MODEL choice, recorded rather than retried.`)
}
process.exit(asked ? 0 : 1)
