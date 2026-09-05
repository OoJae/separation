import type { AircraftState } from "../domain/airspace/aircraft-state"
import { flyEncounter, type PendingClearance } from "../domain/airspace/encounter"
import { findJointHazards, narrowToSafe } from "../domain/interlock/joint-prober"
import { admissibleBandMs } from "../domain/interlock/band"
import { madeIt, type ManeuverWindow } from "../domain/airspace/maneuver-window"

/**
 * Three ARCHITECTURAL arms, one decision policy.
 *
 * The policy below is deterministic and IDENTICAL in all three arms, so the only variable is the
 * architecture. That is what makes any difference attributable — and it is also the honest bound on
 * what this measures: it shows what the ARCHITECTURE changes, not what a model would have done
 * differently. Seeds vary scenario conditions, never model sampling.
 *
 *   A · world-waits             the clock stops while a controller decides. Sequential-equivalent:
 *                               no peer intent can exist during formation, so nothing can change
 *                               what is issued. Content-differs is 0 BY CONSTRUCTION here, and that
 *                               is the point of including it rather than a flaw in it.
 *   B · concurrent, no interlock  turns overlap, but commits are not held. Each clearance is checked
 *                               against committed state only — validate-at-commit.
 *   C · concurrent + interlock  the full system: commits held together and inspected as a set.
 */
export type Arm = "world-waits" | "concurrent-no-interlock" | "concurrent-interlock"
export const ARMS: readonly Arm[] = ["world-waits", "concurrent-no-interlock", "concurrent-interlock"]

export type ArmResult = {
	readonly arm: Arm
	readonly seed: number
	/** What was actually issued, in callsign order. The comparison key for content-differs. */
	readonly committed: readonly { readonly callsign: string; readonly command: string }[]
	readonly separationLost: boolean
	readonly jointHazardsCaught: number
	/** Clearances dropped because their window shut before the arm could act. */
	readonly windowMissed: number
}

export type RunInputs = {
	readonly world: readonly [AircraftState, AircraftState]
	readonly clearances: readonly PendingClearance[]
	readonly windows: ReadonlyMap<string, ManeuverWindow>
	readonly narrowingCandidates: (subject: PendingClearance) => readonly PendingClearance[]
	readonly horizonSec: number
	readonly seed: number
}

const key = (c: PendingClearance) => ({ callsign: c.callsign, command: JSON.stringify(c.command) })
const byCallsign = (a: { callsign: string }, b: { callsign: string }) => (a.callsign < b.callsign ? -1 : 1)

export function runArm(arm: Arm, inputs: RunInputs): ArmResult {
	const band = admissibleBandMs()

	// ARM A — the world does not advance while anyone deliberates, so decisions are effectively
	// sequential and neither controller can see the other forming an intent.
	if (arm === "world-waits") {
		// Each clearance is decided alone, against a world containing only itself.
		const committed = inputs.clearances.map(key).sort(byCallsign)
		const together = flyEncounter(inputs.world, inputs.clearances, inputs.horizonSec)
		return {
			arm, seed: inputs.seed, committed,
			separationLost: together.loss !== null,
			jointHazardsCaught: 0,   // nothing ever holds two intents at once, so none can be seen
			windowMissed: 0,
		}
	}

	// ARMS B and C — decisions are concurrent, so both commits land inside the same window.
	// A serialized arm would reach its second decision only after the radio; both of these do not.
	const live = inputs.clearances.filter((c) => {
		const w = inputs.windows.get(c.id)
		return w === undefined || madeIt(w, band.lowerMs)
	})
	const windowMissed = inputs.clearances.length - live.length

	if (arm === "concurrent-no-interlock") {
		// Validate-at-commit: each clearance checked against the world, never against a peer's
		// pending intent. The joint hazard is invisible here — that is the theorem.
		const committed = live.map(key).sort(byCallsign)
		const together = flyEncounter(inputs.world, live, inputs.horizonSec)
		return {
			arm, seed: inputs.seed, committed,
			separationLost: together.loss !== null,
			jointHazardsCaught: 0,
			windowMissed,
		}
	}

	// ARM C — the airlock holds both commits and inspects them as a set.
	const hazards = findJointHazards([...inputs.world], live, inputs.horizonSec)
	const issued: PendingClearance[] = []
	for (const clearance of live) {
		const implicated = hazards.some((h) => h.clearanceIds.includes(clearance.id))
		if (!implicated) { issued.push(clearance); continue }
		const narrowed = narrowToSafe({
			world: [...inputs.world],
			others: live.filter((c) => c.id !== clearance.id),
			subject: clearance,
			candidates: inputs.narrowingCandidates(clearance),
			horizonSec: inputs.horizonSec,
		})
		issued.push(narrowed ?? clearance)
	}

	const after = flyEncounter(inputs.world, issued, inputs.horizonSec)
	return {
		arm, seed: inputs.seed,
		committed: issued.map(key).sort(byCallsign),
		separationLost: after.loss !== null,
		jointHazardsCaught: hazards.length,
		windowMissed,
	}
}

/** Did the architecture change what was ISSUED? The "not a pipeline" number. */
export function contentDiffers(baseline: ArmResult, other: ArmResult): boolean {
	if (baseline.committed.length !== other.committed.length) return true
	return baseline.committed.some((c, i) => {
		const o = other.committed[i]!
		return c.callsign !== o.callsign || c.command !== o.command
	})
}
