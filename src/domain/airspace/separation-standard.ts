/**
 * Terminal (TRACON) separation minima.
 *
 * FAA JO 7110.65 §5-5-4: 3 NM lateral, valid within 40 NM of the radar antenna — which is why
 * the sector radius IS the standard's validity radius rather than an arbitrary choice.
 * §4-5-1: 1000 ft vertical below FL410.
 *
 * Separation is lost only when BOTH are violated at once. That conjunction is the entire
 * mechanism of scenario BRAID-2: one clearance can compromise the lateral axis and another the
 * vertical, and neither alone loses separation.
 */
export const LATERAL_MINIMUM_NM = 3.0
export const LATERAL_MINIMUM_NM_SQ = LATERAL_MINIMUM_NM * LATERAL_MINIMUM_NM
export const VERTICAL_MINIMUM_FT = 1_000

/** Sector radius, = the lateral standard's validity radius. */
export const SECTOR_RADIUS_NM = 40

export function isSeparationLost(horizontalRangeSq: number, verticalSeparationFt: number): boolean {
	return horizontalRangeSq < LATERAL_MINIMUM_NM_SQ && verticalSeparationFt < VERTICAL_MINIMUM_FT
}
