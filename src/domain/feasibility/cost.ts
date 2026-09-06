/**
 * FOUR GENUINELY INCOMMENSURABLE COST AXES.
 *
 * This type is the project's answer to its most dangerous question — "what did the language
 * models decide that a solver could not?" If these axes could be combined into a number, a
 * solver would take the argmax and the models would be decorative. They cannot be, because
 * trading delay against fuel against passenger load against who-else-gets-constrained is a
 * judgement about priorities, and priorities here are private, contested, and sometimes shaded.
 *
 * There is deliberately NO score, rank, best, recommended, utility, weight, sortKey, or any
 * numeric aggregate anywhere in this module. That absence is machine-checked by
 * tests/substrate/invariants.test.ts — it is an invariant, not an intention.
 *
 * ONE HONEST ASYMMETRY: a left and a right turn of the same magnitude and rate have IDENTICAL cost
 * vectors, because cost does not see traffic. What separates them is `margins`, which is geometry
 * and deliberately not a cost. So the catalogue contains genuinely tied pairs, and that is a fact
 * about the world rather than a defect — tests/feasibility/cost-axes.test.ts asserts it stays true.
 */
export type CostVector = {
	/** Extra track miles flown, NM. */
	readonly deltaTrackMilesNm: number
	/** Delay to the arrival gate, seconds. */
	readonly arrivalDelaySec: number
	/**
	 * Fuel burned, integer milligrams. NEGATIVE when the manoeuvre saves fuel.
	 *
	 * Derived from the burn regime, never from track miles. A speed reduction adds ZERO track
	 * miles, arrives LATER, and burns LESS — the one combination no turn and no descent can
	 * produce, and the reason this is a separate axis rather than a rescaling of the first one.
	 * That option is `slow-to-*` in the catalogue; the claim used to be made here with nothing in
	 * the catalogue backing it, because `Command` had no speed field at all.
	 */
	readonly fuelBurnMg: number
	/**
	 * Peak load factor, g. Computed from the bank a level turn at this speed and rate requires:
	 * `sqrt(1 + (v*omega/g)^2)`. See `loadFactorFor` in prober.ts.
	 *
	 * It was previously a hardcoded 1.06 returned for every turn regardless of angle, rate or
	 * speed — a constant axis, carrying no information, which left all six turns totally ordered
	 * and made this type's "four incommensurable axes" claim false. It now varies with both speed
	 * and turn rate, which is what makes an expedited turn a genuine trade rather than a label.
	 */
	readonly peakLoadFactor: number
}

/**
 * Pareto dominance: strictly better on at least one axis and no worse on any.
 *
 * Note what this does NOT do. It never says which of two incomparable options is preferable. It
 * only removes options that are worse in every respect — which is a filter, not a preference.
 */
export function dominates(a: CostVector, b: CostVector): boolean {
	const axes = [
		[a.deltaTrackMilesNm, b.deltaTrackMilesNm],
		[a.arrivalDelaySec, b.arrivalDelaySec],
		[a.fuelBurnMg, b.fuelBurnMg],
		[a.peakLoadFactor, b.peakLoadFactor],
	] as const
	let strictlyBetter = false
	for (const [x, y] of axes) {
		if (x > y) return false
		if (x < y) strictlyBetter = true
	}
	return strictlyBetter
}

/** True when neither dominates the other — the interesting case, and the common one. */
export function areIncomparable(a: CostVector, b: CostVector): boolean {
	return !dominates(a, b) && !dominates(b, a)
}
