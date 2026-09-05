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
import { mimoFromEnv } from "../src/infrastructure/inference/mimo"
import { TurnScheduler } from "../src/infrastructure/scheduling/turn-scheduler"
import { QueryDesk } from "../src/participants/controller/query-desk"
import { createController } from "../src/participants/controller"
import { IdentityBook } from "../src/participants/identity-book"
import { PilotEvent, createPilot } from "../src/participants/pilot"
import { HORIZON_S, INITIAL } from "../src/scenarios/braid-2"
import { MEDICAL_CALLSIGN, PILOT_SHEETS, sheetFor } from "../src/scenarios/pilot-sheets"
import { OutboxDispatcher } from "../src/support/outbox"
import { SystemClock } from "../src/support/ports"

class S extends RuntimeState {}
const calls = Number(process.argv.find((a) => a.startsWith("--calls="))?.split("=")[1] ?? 8)
const mimo = mimoFromEnv()
if (mimo === null) { console.log("Set ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL in .env."); process.exit(2) }

const clock = new SystemClock()
const cache = new InferenceCache("fixtures/live-cache.jsonl")
const budget = new BudgetGuard(calls)
const runner = new LiveInferenceRunner({
	scripted: () => { throw new Error("no synthetic models here") },
	isSynthetic: () => false, cache, budget, clock,
	measure: () => performance.now(), extraModels: [mimo],
})

const { initializeRuntime, join, runLoop, sendEvent } = defineRuntime<S>()
const outbox = new OutboxDispatcher((e, s) => sendEvent(e, s), clock)
const identity = new IdentityBook()
const scheduler = new TurnScheduler({ runLoop, outbox, clock, identity })
const queryDesk = new QueryDesk({ outbox, clock, timeoutMs: 90_000 })
const world = () => [...INITIAL]

// The geometry, before anyone asks anything.
const set = probe({ subject: "AAL221", world: world(), forGeneration: 1, horizonSec: HORIZON_S, nowSec: 0 })
const widest = [...set.options].sort((a, b) => b.margins.minHorizontalNm - a.margins.minHorizontalNm)[0]!
const shortest = [...set.options].sort((a, b) => a.cost.deltaTrackMilesNm - b.cost.deltaTrackMilesNm)[0]!

console.log(`GEOMETRY LOSES TO SOCIALLY-OBTAINED INFORMATION — ${mimo.specification.name}\n`)
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
				model: mimo.specification.name, maxOutputTokens: 800, tools: self.getTools(),
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
	model: mimo.specification.name, maxOutputTokens: 1_200, tools: controller.getTools(),
})
await new Promise((r) => setTimeout(r, 150_000))

console.log(`\n${"=".repeat(72)}`)
console.log(`  tool sequence : ${events.join("  ->  ")}`)
const asked = events.some((e) => e.includes("query_pilot"))
console.log(`  asked the pilot: ${asked ? "YES" : "no"}`)
if (replyText) {
	const detail = (() => { try { return JSON.parse(JSON.parse(replyText).reply ?? "{}").detail } catch { return null } })()
	console.log(`  disclosed     : ${detail ?? replyText.slice(0, 100)}`)
}
console.log(`  wall clock    : ${Math.round(performance.now() - started)} ms`)
const stats = cache.stats()
console.log(`  live calls    : ${budget.used()}   cache ${stats.hits} hit / ${stats.misses} miss`)
console.log(`\n  ${asked ? "PASS" : "FAIL"} — the controller spent window to obtain what geometry could not give it.`)
process.exit(asked ? 0 : 1)
