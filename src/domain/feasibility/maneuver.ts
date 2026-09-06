import type { Command } from "../airspace/aircraft-state"
import { EXPEDITE_TURN_RATE_MDEG_PER_S, TURN_RATE_MDEG_PER_S, degreesToMdeg } from "../airspace/units"

/**
 * The fixed manoeuvre vocabulary. Identical for every aircraft, every seed, every arm — so no
 * option set can be quietly tailored to produce a desired answer.
 */
export type ManeuverAxis = "vertical" | "lateral" | "speed"

export type Maneuver = {
	readonly template: string
	readonly axis: ManeuverAxis
	readonly label: string
	readonly command: Command
}

/**
 * The template names the RELATIVE manoeuvre ("turn-left-30"), never the absolute heading it
 * happens to produce. That is what makes the catalogue identical for every aircraft — if the
 * template encoded the resulting heading, two aircraft on different headings would be offered
 * differently-named option sets and "the same options for everyone" would be false.
 */
const turn = (offsetDegrees: number, currentHeadingMdeg: number, expedite: boolean): Maneuver => {
	const direction = offsetDegrees < 0 ? "left" : "right"
	const magnitude = Math.abs(offsetDegrees)
	const rate = expedite ? EXPEDITE_TURN_RATE_MDEG_PER_S : TURN_RATE_MDEG_PER_S
	return {
		template: `turn-${direction}-${magnitude}${expedite ? "-expedite" : ""}`,
		axis: "lateral",
		label: `turn ${direction} ${magnitude} degrees${expedite ? ", expedite" : ""}`,
		command: {
			targetHeadingMdeg: degreesToMdeg(Math.round(currentHeadingMdeg / 1000) + offsetDegrees),
			turnRateMdegPerS: rate,
		},
	}
}

/**
 * A speed reduction — the manoeuvre that makes fuel a real axis rather than a rescaling.
 *
 * It adds ZERO track miles and delays the arrival, which is the exact combination no turn and no
 * descent can produce. `cost.ts` has always claimed this option existed to justify treating fuel
 * as independent; it did not, and until now `Command` had no speed field to express it.
 */
const slowTo = (groundspeedKt: number): Maneuver => ({
	template: `slow-to-${groundspeedKt}`,
	axis: "speed",
	label: `reduce speed to ${groundspeedKt} knots`,
	command: { targetGroundspeedKt: groundspeedKt },
})

const descend = (altFt: number): Maneuver => ({
	template: `descend-${altFt}`,
	axis: "vertical",
	label: `descend and maintain ${altFt}`,
	command: { targetAltFt: altFt },
})

/**
 * Built per-aircraft from its current heading, but from the SAME template list every time.
 * `MANEUVER_TEMPLATES` is what a reader should audit; the headings are just that list applied.
 */
/** The offsets and altitudes a reader should audit. Everything else is this list, applied. */
export const TURN_OFFSETS_DEGREES = [-30, -20, -10, 10, 20, 30] as const
export const DESCENT_TARGETS_FT = [4_000, 5_000, 6_000, 7_000] as const
export const SPEED_TARGETS_KT = [210, 180] as const
/**
 * Standard rate and expedited, so load factor discriminates WITHIN the turn family — which was the
 * specific overclaim: peakLoadFactor was a constant, so all six turns were totally ordered.
 */
export const TURN_RATES_EXPEDITE = [false, true] as const

export function maneuverCatalogue(currentHeadingMdeg: number): readonly Maneuver[] {
	return [
		...TURN_RATES_EXPEDITE.flatMap((expedite) =>
			TURN_OFFSETS_DEGREES.map((offset) => turn(offset, currentHeadingMdeg, expedite))),
		...DESCENT_TARGETS_FT.map(descend),
		...SPEED_TARGETS_KT.map(slowTo),
	]
}

export const MANEUVER_TEMPLATE_COUNT =
	TURN_OFFSETS_DEGREES.length * TURN_RATES_EXPEDITE.length
	+ DESCENT_TARGETS_FT.length + SPEED_TARGETS_KT.length
