import { replaySchedule, type Scenario, type Schedule } from "./explorer"

/**
 * Delta-debug a violating schedule down to a minimal one.
 *
 * A 24-decision schedule that triggers a violation says almost nothing. A 2-decision one says
 * exactly what went wrong. The shrinker removes yield seams and flattens picks toward the default,
 * keeping any change that still reproduces the SAME invariant — never merely "some" violation,
 * because collapsing into a different bug would make the repro a lie.
 */
export async function shrink(params: {
	readonly scenario: Scenario
	readonly schedule: Schedule
	readonly invariant: string
}): Promise<Schedule> {
	let best = params.schedule

	const stillFails = async (candidate: Schedule): Promise<boolean> => {
		const violations = await replaySchedule(params.scenario, candidate)
		return violations.some((v) => v.invariant === params.invariant)
	}

	// 1. Drop yield seams one at a time — the fewer seams, the sharper the story.
	for (const label of [...best.yieldAt]) {
		const candidate: Schedule = { ...best, yieldAt: best.yieldAt.filter((l) => l !== label) }
		if (await stillFails(candidate)) best = candidate
	}

	// 2. Flatten each pick toward 0 (the default choice). A pick that can be 0 was never the cause.
	for (let i = 0; i < best.picks.length; i++) {
		if (best.picks[i] === 0) continue
		const picks = [...best.picks]
		picks[i] = 0
		const candidate: Schedule = { ...best, picks }
		if (await stillFails(candidate)) best = candidate
	}

	// 3. Truncate the tail — decisions after the violation cannot have caused it.
	for (let length = 1; length <= best.picks.length; length++) {
		const candidate: Schedule = { ...best, picks: best.picks.slice(0, length) }
		if (await stillFails(candidate)) {
			best = candidate
			break
		}
	}

	return best
}

/** How much of a schedule is actually load-bearing. */
export function describe(schedule: Schedule): string {
	const nonDefault = schedule.picks.filter((p) => p !== 0).length
	return `${schedule.picks.length} decisions (${nonDefault} non-default), ${schedule.yieldAt.length} yield seam(s)${
		schedule.yieldAt.length > 0 ? `: ${schedule.yieldAt.join(", ")}` : ""
	}`
}
