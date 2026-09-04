import type { AircraftState, Callsign } from "../airspace/aircraft-state"
import { flyEncounter, type Interval, type PendingClearance } from "../airspace/encounter"
import { madeIt, missedByMs, type ManeuverWindow } from "../airspace/maneuver-window"

export type JointHazard = {
	/** The clearances that are JOINTLY responsible — none of them causes it alone. */
	readonly clearanceIds: readonly string[]
	readonly callsigns: readonly [Callsign, Callsign]
	readonly minHorizontalNm: number
	readonly verticalAtMinFt: number
	readonly loss: Interval
	readonly lossSeconds: number
}

export type ExcludedClearance = {
	readonly clearanceId: string
	readonly reason: "window-closed"
	readonly missedByMs: number
}

export type JointVerdict = {
	readonly evaluatedAtMs: number
	readonly considered: readonly string[]
	readonly hazards: readonly JointHazard[]
	readonly excluded: readonly ExcludedClearance[]
}

export type JointProbeRequest = {
	readonly world: readonly AircraftState[]
	/** Clearances FORMED but not necessarily committed — the whole point of this prober. */
	readonly pending: readonly PendingClearance[]
	/** clearanceId -> the window it must be committed inside. */
	readonly windows: ReadonlyMap<string, ManeuverWindow>
	/** Sim-time at which this evaluation happens. Decides which windows are still open. */
	readonly atMs: number
	readonly horizonSec: number
}

/**
 * The JointProber.
 *
 * It takes a `pending` parameter, and the FeasibilityProber structurally does not (grep-enforced
 * in `tests/substrate/invariants.test.ts`). That difference is the point: one asks "is this
 * manoeuvre safe against the world as flown", the other asks "are these half-formed intentions
 * safe TOGETHER". Keeping the signatures distinct is what stops the second quietly becoming a
 * flag on the first.
 *
 * A clearance whose window has already shut at `atMs` is EXCLUDED rather than evaluated. That is
 * not bookkeeping — it is the theorem. A serialized system reaches its second decision after the
 * other aircraft's window has closed, so it has no candidate left to find a hazard against. It
 * does not fail to see the hazard; it arrives too late for the hazard to be actionable.
 */
export function evaluateJoint(request: JointProbeRequest): JointVerdict {
	const excluded: ExcludedClearance[] = []
	const live: PendingClearance[] = []

	for (const clearance of request.pending) {
		const window = request.windows.get(clearance.id)
		if (window !== undefined && !madeIt(window, request.atMs)) {
			excluded.push({
				clearanceId: clearance.id,
				reason: "window-closed",
				missedByMs: missedByMs(window, request.atMs),
			})
			continue
		}
		live.push(clearance)
	}

	return {
		evaluatedAtMs: request.atMs,
		considered: live.map((c) => c.id).sort(),
		hazards: findJointHazards(request.world, live, request.horizonSec),
		excluded: excluded.sort((a, b) => (a.clearanceId < b.clearanceId ? -1 : 1)),
	}
}

/**
 * A hazard is JOINT when the whole set loses separation but no proper subset does.
 *
 * That test is what makes "joint" mean something. Reporting any loss found while several
 * clearances are pending would also flag a clearance that is simply unsafe on its own, and the
 * distinction between "this one is bad" and "these two are bad together" is the entire thesis.
 */
export function findJointHazards(
	world: readonly AircraftState[],
	pending: readonly PendingClearance[],
	horizonSec: number,
): JointHazard[] {
	if (pending.length < 2) return []

	const hazards: JointHazard[] = []
	for (let i = 0; i < world.length; i++) {
		for (let j = i + 1; j < world.length; j++) {
			const pair = [world[i]!, world[j]!] as const
			const relevant = pending.filter((c) => c.callsign === pair[0].callsign || c.callsign === pair[1].callsign)
			if (relevant.length < 2) continue

			const together = flyEncounter(pair, relevant, horizonSec)
			if (together.loss === null) continue

			// Does any proper subset already lose separation? If so this is not a JOINT hazard —
			// one of these clearances is simply unsafe, which is a different finding.
			const anySubsetUnsafe = relevant.some((dropped) => {
				const subset = relevant.filter((c) => c.id !== dropped.id)
				return flyEncounter(pair, subset, horizonSec).loss !== null
			})
			if (anySubsetUnsafe) continue

			hazards.push({
				clearanceIds: relevant.map((c) => c.id).sort(),
				callsigns: [pair[0].callsign, pair[1].callsign],
				minHorizontalNm: together.minHorizontalNm,
				verticalAtMinFt: together.verticalAtMinFt,
				loss: together.loss,
				lossSeconds: together.lossSeconds,
			})
		}
	}
	return hazards
}

/**
 * The narrowing the InterlockDesk applies: the least restrictive alternative that clears the
 * joint hazard while keeping the clearance useful.
 *
 * Returning "denied" would make the airlock a veto with extra steps. It searches the candidates
 * in order of decreasing usefulness and takes the first that is safe, so the aircraft still gets
 * a real clearance rather than a refusal.
 */
export function narrowToSafe(params: {
	readonly world: readonly AircraftState[]
	readonly others: readonly PendingClearance[]
	readonly subject: PendingClearance
	readonly candidates: readonly PendingClearance[]
	readonly horizonSec: number
}): PendingClearance | null {
	for (const candidate of params.candidates) {
		const hazards = findJointHazards(params.world, [...params.others, candidate], params.horizonSec)
		if (hazards.length === 0) return candidate
	}
	return null
}
