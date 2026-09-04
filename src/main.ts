import { RuntimeState, SituationSpecification, defineRuntime } from "@mozaik-ai/core"
import type { SituationContext, SituationHandler } from "@mozaik-ai/core"
import { StateHash, quantise } from "./domain/airspace/canonical"
import { WorldEngine } from "./infrastructure/simulation/world-engine"
import { WorldDriver } from "./infrastructure/simulation/world-driver"
import { WorldParticipant } from "./participants/world"
import { IdentityBook } from "./participants/identity-book"
import { Recorder } from "./participants/recorder"
import { OutboxDispatcher } from "./support/outbox"
import { VirtualClock } from "./support/ports"
import { INITIAL, HORIZON_S, clearanceA, clearanceB } from "./scenarios/braid-2"
import { secondsToTick } from "./domain/airspace/units"
import type { PendingClearance } from "./domain/airspace/encounter"

export class TraconState extends RuntimeState {}

export type RunResult = {
	readonly trace: readonly string[]
	readonly stateHash: string
	readonly ticks: number
	readonly events: number
}

/**
 * Headless BRAID-2 on the real Mozaik bus. Zero tokens: every participant is loop-less, so
 * nothing can reach a model even by accident.
 */
export function runScenario(options: { readonly clearances: readonly PendingClearance[]; readonly horizonSec?: number }): RunResult {
	// API-NOTES #18: a non-Agent participant taking a turn dies once telemetry is on. Nothing here
	// takes a turn, but assert the invariant rather than relying on it.
	if (process.env.MOZAIK_API_KEY) {
		throw new Error("MOZAIK_API_KEY must be unset: telemetry breaks loop-less participants (API-NOTES #18)")
	}

	const { initializeRuntime, join, sendEvent } = defineRuntime<TraconState>()
	const clock = new VirtualClock(0)
	const outbox = new OutboxDispatcher((event, senderId) => sendEvent(event, senderId), clock)
	const identity = new IdentityBook()
	const recorder = new Recorder({ clock, identity })

	const engine = WorldEngine.init([...INITIAL])
	const world = WorldParticipant.init({ engine, outbox })

	// A catch-all observer, so the tape records everything the bus carried.
	const tap: SituationHandler = {
		specification: new (class extends SituationSpecification {
			isSatisfiedBy(_: SituationContext) { return true }
		})(),
		processor: { apply({ event }) { recorder.observe(event) } },
	}
	world.setHandlers([...world.getHandlers(), tap])

	initializeRuntime({ state: new TraconState() })
	join(world)
	identity.register(world)

	const applied = new Set<string>()
	const driver = new WorldDriver(engine, clock, (output) => {
		for (const clearance of options.clearances) {
			if (output.tick >= clearance.effectiveTick && !applied.has(clearance.id)) {
				applied.add(clearance.id)
				engine.command(clearance.callsign, clearance.command)
			}
		}
		world.publishTick(output)
	})

	driver.start()
	clock.advance((options.horizonSec ?? HORIZON_S) * 1000)
	driver.stop()

	// Two independent determinism witnesses: a readable quantised trace, and a raw-bit hash that
	// catches drift BELOW print precision — which is exactly what a quantised diff would miss.
	const hash = new StateHash()
	const trace: string[] = []
	for (const state of engine.states()) {
		hash.pushString(state.callsign)
		hash.pushNumber(state.x)
		hash.pushNumber(state.y)
		hash.pushNumber(state.altFt)
		hash.pushInt(state.headingMdeg)
		trace.push(
			`${state.callsign} x=${quantise(state.x)} y=${quantise(state.y)} ` +
			`alt=${quantise(state.altFt)} hdg=${state.headingMdeg}`,
		)
	}
	for (const entry of recorder.tape()) {
		if (entry.kind !== "event") continue
		hash.pushString(entry.type)
		hash.pushInt(entry.seq ?? 0)
	}

	return { trace, stateHash: hash.digest(), ticks: engine.currentTick(), events: recorder.tape().length }
}

export const SCENARIOS = {
	baseline: [] as readonly PendingClearance[],
	a: [clearanceA()],
	b: [clearanceB()],
	joint: [clearanceA(), clearanceB()],
} as const

export { secondsToTick }
