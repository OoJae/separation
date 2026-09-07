import type { SemanticEvent } from "@mozaik-ai/core"
import { Rng } from "../support/rng"
import { checkAll, type RunObservation, type Violation } from "./invariants"
import { FifoPolicy, ScriptedPolicy, withPolicy, type ScheduleDecision } from "./schedule"

export type Schedule = {
	readonly picks: readonly number[]
	readonly yieldAt: readonly string[]
}

export type ExplorationResult = {
	readonly schedule: Schedule
	readonly violations: readonly Violation[]
	readonly decisions: readonly ScheduleDecision[]
	readonly events: number
}

/** A scenario returns what the invariants need to judge it. */
export type Scenario = () => Promise<RunObservation>

/**
 * Explore schedules within causal constraints.
 *
 * The constraints are enforced by CONSTRUCTION rather than by filtering: the outbox only ever
 * offers events already published, and the clock only ever offers timers already due. So every
 * schedule this generates is reachable — there is no way to express an impossible one, which is
 * what keeps this from being a random number generator with a violation counter.
 */
export async function explore(params: {
	readonly scenario: Scenario
	readonly runs: number
	readonly seed: string
	readonly yieldLabels: readonly string[]
}): Promise<{
	readonly baseline: ExplorationResult
	readonly violations: readonly ExplorationResult[]
	/** Schedules GENERATED. Says nothing about how many behaved differently — see `distinct`. */
	readonly generated: number
	/**
	 * Behaviourally DISTINCT executions, deduped on the decisions the policy was actually asked to
	 * make rather than on the pick-vector that was offered.
	 *
	 * These are not the same number and the difference is the whole honesty of this tool. A pick
	 * vector is 24 integers; if the run only ever reaches one decision point, all 200 vectors drive
	 * the identical execution and `generated` says 200 while `distinct` says 2. Reporting the former
	 * as "explored 200 distinct schedules" is exactly the random-number-generator-with-a-counter
	 * this file's own docstring disclaims.
	 */
	readonly distinct: number
}> {
	// The default schedule first. If THIS violates, exploration is not even needed.
	const fifo = new FifoPolicy()
	const baselineObs = await withPolicy(fifo, params.scenario)
	const baseline: ExplorationResult = {
		schedule: { picks: [], yieldAt: [] },
		violations: checkAll(baselineObs),
		decisions: fifo.decisions(),
		events: baselineObs.events.length,
	}

	const rng = Rng.fromSeed(params.seed)
	const found: ExplorationResult[] = []
	const seen = new Set<string>()
	// Keyed on what the run actually DID, not on what it was offered.
	const behaviours = new Set<string>()
	behaviours.add(traceKey(fifo.decisions()))

	for (let run = 0; run < params.runs; run++) {
		// A schedule is a list of integers plus a set of yield seams. Data, not description —
		// which is what lets the shrinker operate on it directly.
		const picks = Array.from({ length: 24 }, () => rng.nextInt(0, 3))
		const yieldAt = params.yieldLabels.filter(() => rng.nextInt(0, 1) === 1)
		const key = `${picks.join(",")}|${yieldAt.join(",")}`
		if (seen.has(key)) continue
		seen.add(key)

		const policy = new ScriptedPolicy(picks, new Set(yieldAt))
		const obs = await withPolicy(policy, params.scenario)
		behaviours.add(traceKey(policy.decisions(), yieldAt))
		const violations = checkAll(obs)
		if (violations.length === 0) continue

		found.push({
			schedule: { picks, yieldAt },
			violations,
			decisions: policy.decisions(),
			events: obs.events.length,
		})
	}

	return { baseline, violations: found, generated: seen.size, distinct: behaviours.size }
}

/** Identity of an execution: the choices actually taken, plus which seams were opened. */
function traceKey(decisions: readonly ScheduleDecision[], yieldAt: readonly string[] = []): string {
	return decisions.map((d) => `${d.label}#${d.picked}`).join(">") + "|" + [...yieldAt].sort().join(",")
}

/** Re-run one exact schedule. A repro must be replayable, or it is an anecdote. */
export async function replaySchedule(scenario: Scenario, schedule: Schedule): Promise<readonly Violation[]> {
	const policy = new ScriptedPolicy(schedule.picks, new Set(schedule.yieldAt))
	return checkAll(await withPolicy(policy, scenario))
}

export type { SemanticEvent }
