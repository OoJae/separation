import { KT_TO_NM_PER_S } from "./units"

/**
 * A manoeuvre window: how long a controller has left to COMMIT a clearance and still have the
 * aircraft complete it before its gate.
 *
 *     W = T_gate - D_manoeuvre - LAG
 *
 * where T_gate is time to the gate at current groundspeed, D_manoeuvre is how long the commanded
 * change takes to finish, and LAG is the delay between a controller committing and metal moving.
 *
 * This is the quantity the whole theorem turns on. If W is large, serialising two decisions costs
 * nothing and there is no argument to make. The interesting regime — and the one a busy sector
 * actually lives in — is where W is comparable to a decision latency.
 */

/** PUBLISHED. Transmit + readback on a single-channel frequency (FAA JO 7110.65 §2-4-3). */
export const T_RT_S = 8.0
/** PUBLISHED-ish. Typical crew response to a routine clearance. */
export const T_PILOT_S = 5.0
/** A clearance committed at t moves metal at t + LAG. */
export const COMMAND_LAG_S = T_RT_S + T_PILOT_S

export type ManeuverWindow = {
	readonly label: string
	readonly gateDistanceNm: number
	readonly maneuverDurationS: number
	readonly timeToGateS: number
	/** Milliseconds from now within which the clearance must be committed. */
	readonly windowMs: number
}

export function computeWindow(params: {
	readonly label: string
	readonly gateDistanceNm: number
	readonly maneuverDurationS: number
	readonly groundspeedKt: number
}): ManeuverWindow {
	const speed = params.groundspeedKt * KT_TO_NM_PER_S
	const timeToGateS = params.gateDistanceNm / speed
	return {
		label: params.label,
		gateDistanceNm: params.gateDistanceNm,
		maneuverDurationS: params.maneuverDurationS,
		timeToGateS,
		windowMs: (timeToGateS - params.maneuverDurationS - COMMAND_LAG_S) * 1000,
	}
}

/** How badly a commit at `commitAtMs` misses the window. Negative means it made it. */
export function missedByMs(window: ManeuverWindow, commitAtMs: number): number {
	return commitAtMs - window.windowMs
}

export function madeIt(window: ManeuverWindow, commitAtMs: number): boolean {
	return commitAtMs <= window.windowMs
}

/**
 * Time for a level change, seconds. Duration is what makes A's window tight: descending 5000 ft
 * at 2000 fpm takes two and a half minutes, and the gate does not move while it happens.
 */
export function levelChangeDurationS(fromFt: number, toFt: number, rateFpm: number): number {
	return (Math.abs(fromFt - toFt) / rateFpm) * 60
}

/**
 * Time to turn AND then establish a required cross-track offset, seconds.
 *
 * The turn itself is quick; what takes time is flying the new heading long enough to actually be
 * displaced. Modelling only the turn would give B a window of minutes and quietly destroy the
 * scenario, so the establish leg is counted.
 *
 * `sinOffAngle` is passed in rather than computed, because Math.sin is banned outside the heading
 * table — the caller reads it from there.
 */
export function turnAndEstablishDurationS(params: {
	readonly turnDegrees: number
	readonly turnRateDegPerSec: number
	readonly requiredOffsetNm: number
	readonly groundspeedKt: number
	readonly sinOffAngle: number
}): number {
	const turnS = Math.abs(params.turnDegrees) / params.turnRateDegPerSec
	const crossTrackRate = params.groundspeedKt * KT_TO_NM_PER_S * params.sinOffAngle
	const establishS = crossTrackRate === 0 ? Number.POSITIVE_INFINITY : params.requiredOffsetNm / crossTrackRate
	return turnS + establishS
}
