import { MAX_TURN_MS, MIN_TURN_MS } from "./decision-latency"
import { T_RT_S } from "../airspace/maneuver-window"

/**
 * The admissible window band — DERIVED from the latency constants, never chosen.
 *
 * This is the honest core of the theorem's falsifiability. The gate distances in the scenario ARE
 * calibrated: they are picked so both windows land inside this band, and the README says so in
 * its second paragraph. But the band itself is not a free parameter — it follows from how long a
 * controller turn takes and how long a single radio channel is occupied.
 *
 *   lower bound: the SLOWEST concurrent commit must still fit, or the concurrent arm is not
 *                reliably better and the whole comparison is luck.
 *   upper bound: the FASTEST serialized commit must still miss, or serialising is viable and the
 *                theorem is false.
 *
 * A test computes this band and asserts the scenario's gates lie strictly inside it. Change the
 * latency model and that test fails, telling you the gates need re-deriving rather than letting a
 * stale calibration slide through.
 */
export const CONCURRENT_MAX_MS = MAX_TURN_MS
export const SERIALIZED_MIN_MS = MIN_TURN_MS + T_RT_S * 1000 + MIN_TURN_MS

export type AdmissibleBand = {
	/** A window must exceed this for the concurrent arm to fit on every latency draw. */
	readonly lowerMs: number
	/** A window must fall below this for the serialized arm to miss on every draw. */
	readonly upperMs: number
	readonly widthMs: number
}

export function admissibleBandMs(): AdmissibleBand {
	return {
		lowerMs: CONCURRENT_MAX_MS,
		upperMs: SERIALIZED_MIN_MS,
		widthMs: SERIALIZED_MIN_MS - CONCURRENT_MAX_MS,
	}
}

export function isInBand(windowMs: number): boolean {
	const band = admissibleBandMs()
	return windowMs > band.lowerMs && windowMs < band.upperMs
}

/** The gate distance range that puts a window inside the band, for a given manoeuvre. */
export function admissibleGateRangeNm(params: {
	readonly maneuverDurationS: number
	readonly lagS: number
	readonly speedNmPerSec: number
}): { readonly minNm: number; readonly maxNm: number } {
	const band = admissibleBandMs()
	const toGate = (windowMs: number) =>
		(windowMs / 1000 + params.maneuverDurationS + params.lagS) * params.speedNmPerSec
	return { minNm: toGate(band.lowerMs), maxNm: toGate(band.upperMs) }
}
