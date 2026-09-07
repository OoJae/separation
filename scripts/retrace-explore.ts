/**
 * RETRACE, pointed at ourselves.
 *
 * Two candidates were found by READING the code before this tool existed, and written into the
 * plan so "RETRACE found a real bug" could not be redefined afterwards:
 *
 *   1. StandingBroker's casWrite passes `cell.token` as the expected token — a tautology that
 *      can never fail, so the CAS cannot detect a lost update.
 *   2. InterlockDesk schedules a settle timer per turn but adjudicates the WHOLE set, so a late
 *      commit gets a shortened settle window.
 *
 * The tool's job is to reach them independently — and to find anything I missed. If it misses
 * them, that is a finding about the tool.
 */
import { RuntimeState, SituationSpecification, createHuman, defineRuntime } from "@mozaik-ai/core"
import type { SemanticEvent, SituationContext, SituationHandler } from "@mozaik-ai/core"
import { IntentRegistry } from "../src/domain/interlock/intent-registry"
import { InterlockDesk } from "../src/participants/interlock-desk"
import { StandingBroker } from "../src/participants/standing-broker"
import { explore, replaySchedule, type Scenario } from "../src/retrace/explorer"
import type { RunObservation } from "../src/retrace/invariants"
import { describe as describeSchedule, shrink } from "../src/retrace/shrink"
import { HORIZON_S, INITIAL, WINDOWS, clearanceA, clearanceB, narrowingCandidatesForA } from "../src/scenarios/braid-2"
import { OutboxDispatcher } from "../src/support/outbox"
import { VirtualClock } from "../src/support/ports"

class S extends RuntimeState {}
const SETTLE_MS = 50


/**
 * Two controllers contend for standing over one aircraft, and two commits are held in the airlock
 * with the second arriving late. Exactly the shape the architecture claims to handle.
 */
const scenario: Scenario = async (): Promise<RunObservation> => {
	const { initializeRuntime, join, sendEvent } = defineRuntime<S>()
	const clock = new VirtualClock(0)
	const seen: SemanticEvent[] = []
	const outbox = new OutboxDispatcher((e, s) => { seen.push(e); sendEvent(e, s) }, clock)

	const desk = InterlockDesk.init({
		world: () => [...INITIAL], windows: WINDOWS, horizonSec: HORIZON_S, clock, outbox,
		settleMs: SETTLE_MS, intents: new IntentRegistry(),
		narrowingCandidates: (s) => (s.callsign === "AAL221" ? narrowingCandidatesForA() : []),
	})
	const broker = StandingBroker.init({ outbox, clock })

	const tap: SituationHandler = {
		specification: new (class extends SituationSpecification {
			isSatisfiedBy(_: SituationContext) { return true }
		})(),
		processor: { apply() { /* observation only */ } },
	}
	const observer = createHuman({ name: "observer", capabilities: [], handlers: [tap] })

	initializeRuntime({ state: new S() })
	for (const p of [observer, broker, desk]) join(p)

	// Two controllers bid for the SAME key. One must win and one must be told it lost.
	await Promise.all([
		broker.bid({ controller: "APPROACH", callsign: "AAL221", objective: "sequence", durationMs: 60_000 }),
		broker.bid({ controller: "FLOW", callsign: "AAL221", objective: "sequence", durationMs: 60_000 }),
	])

	// Two commits held in the airlock, the second arriving 30ms after the first.
	const held: Promise<unknown>[] = []
	const handler = desk.handler()
	const commit = (id: string, clearance: ReturnType<typeof clearanceA>) =>
		handler.handle({
			nextStateId: "function_call",
			input: {
				call: { callId: id, name: "commit_clearance", args: JSON.stringify({
					clearanceId: clearance.id, callsign: clearance.callsign, command: clearance.command,
				}), getType: () => "function_call", type: "function_call" },
				inferenceInput: { model: "x", context: { getItems: () => [], addContextItems: () => {}, id: "c", items: [] } },
			},
		} as never)

	// SAME INSTANT, deliberately. Two commits arriving in one millisecond make their settle timers
	// co-due, and a co-due pair is the only thing that offers the scheduler a choice — which is the
	// whole surface this tool explores. This used to stagger them by 30 ms, because 30 ms was the
	// historical bug's repro; once that bug was fixed the stagger left the clock with no two
	// eligible timers, the policy was never consulted, and 200 schedules all drove one execution.
	held.push(commit("c1", clearanceA()))
	held.push(commit("c2", clearanceB()))
	clock.advance(SETTLE_MS + 60)
	await Promise.all(held.map((p) => Promise.race([p, Promise.resolve()])))
	await new Promise((r) => setTimeout(r, 0))
	clock.advance(200)
	await new Promise((r) => setTimeout(r, 0))

	return {
		events: seen,
		settleGranted: desk.settleWindows(),
		settleRequiredMs: desk.settleMs(),
		pendingAtEnd: desk.pendingSize(),
	}
}

console.log("RETRACE — exploring the scheduling surface this architecture exposes\n")

const result = await explore({
	scenario,
	runs: 200,
	seed: "retrace-phase-6",
	yieldLabels: ["broker:bid:before-read"],
})

console.log(`  baseline (default FIFO schedule): ${result.baseline.violations.length} violation(s)`)
for (const v of result.baseline.violations) console.log(`     ${v.invariant}: ${v.detail}`)
console.log(`     decision points offered: ${result.baseline.decisions.length}`)
for (const d of result.baseline.decisions) console.log(`       ${d.label} (${d.options} options)`)

console.log(`\n  generated ${result.generated} schedules`)
console.log(`  BEHAVIOURALLY DISTINCT executions: ${result.distinct}`)
console.log(`  violating: ${result.violations.length}\n`)

/**
 * A scenario with no decision points has no scheduling surface, so exploring it is vacuous — and
 * saying "explored 200 distinct schedules" about it is the exact overclaim this tool exists to
 * disclaim. Failing loudly is better than a reassuring zero.
 */
if (result.baseline.decisions.length === 0) {
	console.log("  FAIL — this scenario exposes NO scheduling surface. Every generated schedule drove")
	console.log("  the identical execution, so the exploration proved nothing. Fix the scenario, not")
	console.log("  the counter.\n")
	process.exit(1)
}

const byInvariant = new Map<string, typeof result.violations[number]>()
for (const r of result.violations) {
	for (const v of r.violations) if (!byInvariant.has(v.invariant)) byInvariant.set(v.invariant, r)
}

if (byInvariant.size === 0) {
	console.log("  RETRACE found nothing beyond the baseline.")
	process.exit(0)
}

for (const [invariant, r] of byInvariant) {
	console.log(`  ── ${invariant} ──`)
	console.log(`     ${r.violations.find((v) => v.invariant === invariant)!.detail}`)
	console.log(`     raw schedule: ${describeSchedule(r.schedule)}`)
	const minimal = await shrink({ scenario, schedule: r.schedule, invariant })
	console.log(`     shrunk to   : ${describeSchedule(minimal)}`)
	const confirm = await replaySchedule(scenario, minimal)
	console.log(`     replays     : ${confirm.some((v) => v.invariant === invariant) ? "REPRODUCES" : "does not reproduce"}`)
	console.log()
}
