import { FT_PER_NM } from "./units-bridge"

/**
 * Modified tau — the TCAS range test.
 *
 * Plain tau (range / closure rate) goes to infinity for a slow, close encounter, which is exactly
 * the case you most want to catch. Modified tau fixes that by crediting a protected radius DMOD:
 *
 *     tauMod = (DMOD^2 - r^2) / (r * rdot)
 *
 * With r > DMOD and rdot < 0 (closing) both numerator and denominator are negative, so tauMod is
 * positive and shrinks as the encounter develops. When rdot >= 0 the pair is not closing and the
 * test can never fire, so tau is +Infinity rather than a negative number that might compare
 * below a threshold by accident.
 *
 * No sqrt appears: the caller supplies rangeSq, so nothing here depends on a rounding mode.
 */
export function modifiedTauSeconds(rangeSqNm2: number, closureRateNmPerSec: number, dmodNm: number): number {
	if (closureRateNmPerSec >= 0) return Number.POSITIVE_INFINITY
	const range = Math.sqrt(rangeSqNm2)
	if (range === 0) return 0
	return (dmodNm * dmodNm - rangeSqNm2) / (range * closureRateNmPerSec)
}

/** Vertical tau: time until the altitude gap closes, given its current signed rate. */
export function verticalTauSeconds(verticalSeparationFt: number, verticalRateFtPerSec: number): number {
	if (verticalRateFtPerSec >= 0) return Number.POSITIVE_INFINITY
	return verticalSeparationFt / -verticalRateFtPerSec
}

export { FT_PER_NM }
