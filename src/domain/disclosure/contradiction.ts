/**
 * Detecting a shaded fuel report — WITHOUT the statistics theatre.
 *
 * The design this replaces used a "3-sigma" threshold. That turned out to be an algebraic
 * identity wearing a lab coat: with a uniform-plus-quantisation error model,
 * `k = sqrt(6 + RMAX^2/RSD^2)` equals exactly 3 whenever `RSD = RMAX/sqrt(3)`, which the model
 * also assumed. The threshold was not derived from a distribution; it was the bounded worst case
 * with a sigma painted on it.
 *
 * So we test the bound directly and say so. There is no probability field on the verdict, because
 * we are not entitled to one.
 */

/** PUBLISHED. FQIS totalizer quantum on a narrow-body — 100 kg, in milligrams. */
export const GAUGE_QUANTUM_MG = 100_000_000
/** CHOSEN. Worst-case relative error of the burn model: thrust setting + wind/ISA + weight. */
export const RELATIVE_MAX = 0.12

export type ContradictionVerdict = {
	readonly contradicted: boolean
	/** How far outside the bound, in milligrams. Negative means inside. */
	readonly marginMg: number
	/** Margin as a ratio of the bound, x1000, as an integer — no float in the report. */
	readonly marginRatioE3: number
	readonly boundMg: number
	readonly observedDiscrepancyMg: number
	/** A leak and a lie look IDENTICAL from outside the aircraft. We do not claim to tell them apart. */
	readonly cause: "unexplained"
	readonly interpretation: "margin-above-bounded-error-model"
}

/** Worst-case error on a burn of this size: two gauge readings plus the model's relative error. */
export function boundedWorstCaseMg(burnMg: number): number {
	return 2 * GAUGE_QUANTUM_MG + Math.floor(burnMg * RELATIVE_MAX * 1000) / 1000
}

/**
 * The DIFFERENTIAL test — the one that is sound without any exogenous truth.
 *
 * Compare two claims by the same pilot, separated by an observed burn:
 *
 *     expected(claim2) = claim1 - burn(t1, t2)
 *     discrepancy      = claim2 - expected(claim2)
 *
 * The pilot's unknown true starting fuel appears in both claims and CANCELS. So this works
 * without ever knowing how much fuel is really on board — which matters, because ATC never does.
 * A pilot who shades a number once and then reports consistently is invisible here; a pilot who
 * shades to jump a queue and then has to keep the story straight is not.
 */
export function testDifferential(params: {
	readonly firstClaimMg: number
	readonly secondClaimMg: number
	readonly burnBetweenMg: number
}): ContradictionVerdict {
	const expected = params.firstClaimMg - params.burnBetweenMg
	const discrepancy = params.secondClaimMg - expected
	const bound = boundedWorstCaseMg(params.burnBetweenMg)
	const margin = Math.abs(discrepancy) - bound

	return {
		contradicted: margin > 0,
		marginMg: margin,
		marginRatioE3: bound === 0 ? 0 : Math.round((margin / bound) * 1000),
		boundMg: bound,
		observedDiscrepancyMg: discrepancy,
		cause: "unexplained",
		interpretation: "margin-above-bounded-error-model",
	}
}

/**
 * The ANCHORED test, for when a filed flight-plan figure is available. Strictly weaker than the
 * differential test, because it inherits whatever error the filed figure carries.
 */
export function testAnchored(params: {
	readonly filedFuelMg: number
	readonly burnSinceFiledMg: number
	readonly claimedNowMg: number
}): ContradictionVerdict {
	const expected = params.filedFuelMg - params.burnSinceFiledMg
	const discrepancy = params.claimedNowMg - expected
	const bound = boundedWorstCaseMg(params.burnSinceFiledMg)
	const margin = Math.abs(discrepancy) - bound

	return {
		contradicted: margin > 0,
		marginMg: margin,
		marginRatioE3: bound === 0 ? 0 : Math.round((margin / bound) * 1000),
		boundMg: bound,
		observedDiscrepancyMg: discrepancy,
		cause: "unexplained",
		interpretation: "margin-above-bounded-error-model",
	}
}
