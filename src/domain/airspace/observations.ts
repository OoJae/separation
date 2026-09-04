import type { AircraftState, Callsign } from "./aircraft-state"

/**
 * The two observation types the world publishes, deliberately kept DISJOINT.
 *
 * `PairClosure` carries only RELATIVE quantities, at 20 Hz, to the reflex layer.
 * `WorldSnapshot` carries only ABSOLUTE state, at 1 Hz, to planners.
 *
 * An honest note on what the rate separation does and does not prove: a 1 Hz consumer holding two
 * snapshots CAN derive a closure rate analytically, so we do not claim the fast channel carries
 * information the slow one could never reconstruct. What it does carry is pair-level
 * discretisation — a crossing that begins and ends between two snapshots is simply not in them —
 * and the snapshot deliberately omits commanded state, so a planner cannot read an intent out of
 * the world before it has moved metal. Those are the narrow claims, and they are what is asserted.
 */

export type PairClosure = {
	readonly a: Callsign
	readonly b: Callsign
	/** Squared, so no consumer's threshold comparison depends on sqrt. */
	readonly rangeSqNm2: number
	/** Signed, NM/s. Negative is closing. Analytic, not finite-differenced. */
	readonly closureRateNmPerSec: number
	readonly verticalSeparationFt: number
	/** Signed, ft/s. Negative means the vertical gap is shrinking. */
	readonly verticalRateFtPerSec: number
	readonly tSim: number
}

export type TrackRecord = {
	readonly callsign: Callsign
	readonly x: number
	readonly y: number
	readonly altFt: number
	readonly headingMdeg: number
	readonly groundspeedKt: number
	readonly verticalSpeedFpm: number
}

export type WorldSnapshot = {
	/** Bumps every snapshot, so a planner can tell how stale its premise is. */
	readonly generation: number
	readonly tSim: number
	readonly tracks: readonly TrackRecord[]
}

/** Observable state only — commanded targets are deliberately absent. */
export function toTrackRecord(state: AircraftState): TrackRecord {
	return {
		callsign: state.callsign,
		x: state.x,
		y: state.y,
		altFt: state.altFt,
		headingMdeg: state.headingMdeg,
		groundspeedKt: state.groundspeedKt,
		verticalSpeedFpm: state.verticalSpeedFpm,
	}
}
