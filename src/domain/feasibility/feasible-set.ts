import type { Callsign } from "../airspace/aircraft-state"
import type { CostVector } from "./cost"
import type { Maneuver } from "./maneuver"

export type SeparationMargins = {
	readonly minHorizontalNm: number
	readonly minVerticalFt: number
	/** Against which other aircraft this margin was measured. */
	readonly against: readonly Callsign[]
}

export type FeasibleOption = {
	/** `${callsign}/${template}` — one story about identity, not a content hash. */
	readonly optionId: string
	readonly maneuver: Maneuver
	readonly margins: SeparationMargins
	readonly cost: CostVector
	/** Latest sim-time, seconds, at which this option can still be started. */
	readonly availableUntilSec: number
}

export type ExcludedOption = {
	readonly optionId: string
	readonly reason: "separation" | "window-closed" | "performance"
	readonly detail: string
}

/**
 * A SET, never a ranking.
 *
 * `ordering` is a literal string carried on the type so nobody — reader or model — mistakes the
 * array order for a preference. It is sorted lexicographically by optionId purely so traces are
 * reproducible.
 *
 * The prober's job ends at "these are separation-safe, and here is what each costs on four
 * incommensurable axes". Choosing among them is the controllers' job, and it is decided by
 * private, contested information the prober structurally cannot see.
 */
export type FeasibleSet = {
	readonly subject: Callsign
	/** The world generation this was computed against, so a consumer can tell if it is stale. */
	readonly forGeneration: number
	readonly options: readonly FeasibleOption[]
	readonly excluded: readonly ExcludedOption[]
	readonly ordering: "lexicographic-by-optionId (semantically meaningless)"
}

export function makeFeasibleSet(
	subject: Callsign,
	forGeneration: number,
	options: readonly FeasibleOption[],
	excluded: readonly ExcludedOption[],
): FeasibleSet {
	return {
		subject,
		forGeneration,
		options: [...options].sort((a, b) => (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0)),
		excluded: [...excluded].sort((a, b) => (a.optionId < b.optionId ? -1 : a.optionId > b.optionId ? 1 : 0)),
		ordering: "lexicographic-by-optionId (semantically meaningless)",
	}
}
