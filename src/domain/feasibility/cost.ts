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
 */
export type CostVector = {
	/** Extra track miles flown, NM. */
	readonly deltaTrackMilesNm: number
	/** Delay to the arrival gate, seconds. */
	readonly arrivalDelaySec: number
	/**
	 * Fuel burned, integer milligrams. Derived from the burn regime, NOT from track miles — a
	 * speed reduction costs fuel with ZERO extra track miles, which is exactly why this is a
	 * separate axis rather than a rescaling of the first one.
	 */
	readonly fuelBurnMg: number
	/** Peak load factor, g. Derived from turn rate; a comfort and passenger-safety cost. */
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
