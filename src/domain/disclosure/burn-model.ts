/**
 * Fuel burn, in INTEGER MILLIGRAMS.
 *
 * Integer because the burn integral accumulates over tens of thousands of ticks and a float would
 * drift — the same reason time and heading are integers. `mgPerSec * dtMs` stays far below 2^53
 * for any plausible run (1.4e6 mg/s * 4e5 ms is ~5.6e11), so the arithmetic is exact.
 *
 * Modelled per SECOND by regime, never per NAUTICAL MILE. Kg-per-NM would make fuel a monotone
 * function of track miles, collapsing two of the four cost axes into one and handing a solver an
 * ordering it must not have.
 */
export type BurnRegime = "cruise" | "descent" | "turning" | "holding"

/** CHOSEN, but in the right ballpark for a narrow-body at terminal altitudes. */
export const BURN_MG_PER_SEC: Readonly<Record<BurnRegime, number>> = {
	cruise: 1_050_000,
	descent: 420_000,
	turning: 1_240_000,
	holding: 1_150_000,
}

export function burnForMs(regime: BurnRegime, durationMs: number): number {
	return Math.floor((BURN_MG_PER_SEC[regime] * durationMs) / 1000)
}

/** Running integral of observed burn. Integer throughout — no accumulation error, ever. */
export class BurnIntegral {
	private totalMg = 0

	accumulate(regime: BurnRegime, durationMs: number): void {
		this.totalMg += burnForMs(regime, durationMs)
	}

	totalMilligrams(): number {
		return this.totalMg
	}
}
