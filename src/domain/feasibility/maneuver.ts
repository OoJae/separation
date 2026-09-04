import type { Command } from "../airspace/aircraft-state"
import { degreesToMdeg } from "../airspace/units"

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
const turn = (offsetDegrees: number, currentHeadingMdeg: number): Maneuver => {
	const direction = offsetDegrees < 0 ? "left" : "right"
	const magnitude = Math.abs(offsetDegrees)
	return {
		template: `turn-${direction}-${magnitude}`,
		axis: "lateral",
		label: `turn ${direction} ${magnitude} degrees`,
		command: { targetHeadingMdeg: degreesToMdeg(Math.round(currentHeadingMdeg / 1000) + offsetDegrees) },
	}
}

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

export function maneuverCatalogue(currentHeadingMdeg: number): readonly Maneuver[] {
	return [
		...TURN_OFFSETS_DEGREES.map((offset) => turn(offset, currentHeadingMdeg)),
		...DESCENT_TARGETS_FT.map(descend),
	]
}

export const MANEUVER_TEMPLATE_COUNT = 10
