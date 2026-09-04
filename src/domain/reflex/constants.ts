/**
 * TCAS II thresholds. A defensible subset of RTCA DO-185B — enough to be correct about the one
 * thing that matters here, and honest about being a subset.
 *
 * Every constant is marked PUBLISHED (from the standard) or CHOSEN (ours). The distinction is
 * the point: a reader can see exactly where the real system ends and our modelling begins.
 */

export type SensitivityLevel = 3 | 4 | 5 | 6 | 7

export type SensitivityRow = {
	readonly level: SensitivityLevel
	/** PUBLISHED. Altitude band, ft. */
	readonly minAltFt: number
	readonly maxAltFt: number
	/** PUBLISHED. Traffic-advisory tau threshold, seconds. */
	readonly taTauS: number
	/** PUBLISHED. Resolution-advisory tau threshold, seconds. */
	readonly raTauS: number
	/** PUBLISHED. Distance modification for the RA range test, NM. */
	readonly raDmodNm: number
	/** PUBLISHED. Distance modification for the TA range test, NM. */
	readonly taDmodNm: number
	/** PUBLISHED. Vertical threshold for the RA test, ft. */
	readonly raZthrFt: number
	/** PUBLISHED. Vertical threshold for the TA test, ft. */
	readonly taZthrFt: number
	/** PUBLISHED. Altitude limit — the vertical miss distance an RA aims to achieve, ft. */
	readonly alimFt: number
}

/** RTCA DO-185B sensitivity-level table. */
export const SENSITIVITY_TABLE: readonly SensitivityRow[] = [
	{ level: 3, minAltFt: 1_000, maxAltFt: 2_350, taTauS: 25, raTauS: 15, raDmodNm: 0.2, taDmodNm: 0.3, raZthrFt: 600, taZthrFt: 850, alimFt: 300 },
	{ level: 4, minAltFt: 2_350, maxAltFt: 5_000, taTauS: 30, raTauS: 20, raDmodNm: 0.35, taDmodNm: 0.48, raZthrFt: 600, taZthrFt: 850, alimFt: 300 },
	{ level: 5, minAltFt: 5_000, maxAltFt: 10_000, taTauS: 40, raTauS: 25, raDmodNm: 0.55, taDmodNm: 0.75, raZthrFt: 600, taZthrFt: 850, alimFt: 350 },
	{ level: 6, minAltFt: 10_000, maxAltFt: 20_000, taTauS: 45, raTauS: 30, raDmodNm: 0.8, taDmodNm: 1.0, raZthrFt: 600, taZthrFt: 850, alimFt: 400 },
	{ level: 7, minAltFt: 20_000, maxAltFt: Number.POSITIVE_INFINITY, taTauS: 48, raTauS: 35, raDmodNm: 1.1, taDmodNm: 1.3, raZthrFt: 700, taZthrFt: 850, alimFt: 600 },
]

/** PUBLISHED. Crew response delay to an initial RA, seconds. */
export const RA_RESPONSE_DELAY_S = 5.0
/** PUBLISHED. Commanded vertical rate for an initial corrective RA, ft/min. */
export const RA_COMMANDED_FPM = 1_500
/** CHOSEN. Consecutive 20 Hz samples a condition must hold before an advisory is declared. */
export const CONFIRM_TICKS = 4
/** CHOSEN. Consecutive samples the condition must be absent before an advisory clears. */
export const CLEAR_TICKS = 10
/** CHOSEN. Vertical indifference band, ft — inside it, sense is decided by Mode S address. */
export const SENSE_INDIFFERENCE_FT = 25

export function sensitivityFor(altFt: number): SensitivityRow {
	for (const row of SENSITIVITY_TABLE) {
		if (altFt >= row.minAltFt && altFt < row.maxAltFt) return row
	}
	return SENSITIVITY_TABLE[SENSITIVITY_TABLE.length - 1]!
}
