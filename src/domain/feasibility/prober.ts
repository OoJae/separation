import {
	horizontalRangeSq, verticalSeparationFt, type AircraftState, type Callsign,
} from "../airspace/aircraft-state"
import { flyEncounter, type PendingClearance } from "../airspace/encounter"
import { LATERAL_MINIMUM_NM, VERTICAL_MINIMUM_FT } from "../airspace/separation-standard"
import { KT_TO_NM_PER_S, secondsToTick } from "../airspace/units"
import type { CostVector } from "./cost"
import { makeFeasibleSet, type ExcludedOption, type FeasibleOption, type FeasibleSet } from "./feasible-set"
import { maneuverCatalogue, type Maneuver } from "./maneuver"

/** Fuel burn by regime, integer milligrams per second. Never kg/NM — see the note below. */
const BURN_MG_PER_SEC = {
	cruise: 1_050_000,
	descent: 420_000,
	turning: 1_240_000,
} as const

/**
 * NOTE ON WHY FUEL IS A SEPARATE AXIS.
 *
 * Modelling fuel as kg-per-NM would make it a monotone function of track miles, which would
 * collapse two of the four cost axes into one and hand a solver an argmax it should not have. It
 * is modelled as milligrams-per-SECOND by regime instead, so a manoeuvre that adds time without
 * adding distance still costs fuel, and one that adds distance in a cheap regime may cost less
 * than one that adds none in an expensive one. The axes stay genuinely incommensurable.
 */
function burnFor(maneuver: Maneuver, durationSec: number): number {
	const regime = maneuver.axis === "vertical" ? "descent" : maneuver.axis === "lateral" ? "turning" : "cruise"
	return Math.floor((BURN_MG_PER_SEC[regime] * Math.round(durationSec * 1000)) / 1000)
}

export type ProbeRequest = {
	readonly subject: Callsign
	readonly world: readonly AircraftState[]
	readonly forGeneration: number
	readonly horizonSec: number
	/** Sim-time now, seconds — used only to express availability windows. */
	readonly nowSec: number
}

/**
 * The FeasibilityProber.
 *
 * DELIBERATELY has no `pending` parameter. It sees only the world as flown. Reasoning about
 * clearances that have been formed but not committed is a genuinely different computation and
 * belongs to Phase 3's JointProber — keeping the signatures distinct is what stops the two from
 * quietly becoming the same thing. Machine-checked.
 *
 * It also cannot see any PilotSheet. The information that actually decides between these options
 * — fuel state, a deteriorating passenger, a crew duty limit — is private to the aircraft and
 * obtainable only by asking, in natural language, while the clock runs. That is structural, not
 * politeness: nothing in this module can import it.
 */
export function probe(request: ProbeRequest): FeasibleSet {
	const subject = request.world.find((a) => a.callsign === request.subject)
	if (subject === undefined) {
		return makeFeasibleSet(request.subject, request.forGeneration, [], [])
	}
	const others = request.world.filter((a) => a.callsign !== request.subject)

	const options: FeasibleOption[] = []
	const excluded: ExcludedOption[] = []

	for (const maneuver of maneuverCatalogue(subject.headingMdeg)) {
		const optionId = `${subject.callsign}/${maneuver.template}`
		const clearance: PendingClearance = {
			id: optionId,
			callsign: subject.callsign,
			command: maneuver.command,
			committedTick: secondsToTick(request.nowSec),
			effectiveTick: secondsToTick(request.nowSec),
		}

		let worstHorizontal = Number.POSITIVE_INFINITY
		let worstVertical = Number.POSITIVE_INFINITY
		let breached = false
		const against: Callsign[] = []

		for (const other of others) {
			const result = flyEncounter([subject, other], [clearance], request.horizonSec)
			worstHorizontal = Math.min(worstHorizontal, result.minHorizontalNm)
			worstVertical = Math.min(worstVertical, result.verticalAtMinFt)
			against.push(other.callsign)
			if (result.loss !== null) breached = true
		}

		// isSeparated is a FILTER, not a cost. Geometry defines the region; it never ranks inside it.
		if (breached) {
			excluded.push({
				optionId,
				reason: "separation",
				detail: `loses separation: ${worstHorizontal.toFixed(2)} NM / ${worstVertical.toFixed(0)} ft`,
			})
			continue
		}

		options.push({
			optionId,
			maneuver,
			margins: {
				minHorizontalNm: worstHorizontal,
				minVerticalFt: worstVertical,
				against,
			},
			cost: costOf(maneuver, subject, request.horizonSec),
			availableUntilSec: request.nowSec + request.horizonSec,
		})
	}

	return makeFeasibleSet(request.subject, request.forGeneration, options, excluded)
}

function costOf(maneuver: Maneuver, subject: AircraftState, horizonSec: number): CostVector {
	const speedNmPerSec = subject.groundspeedKt * KT_TO_NM_PER_S

	if (maneuver.axis === "lateral") {
		const degrees = Math.abs(turnMagnitudeDegrees(maneuver, subject.headingMdeg))
		// A turn adds track miles roughly in proportion to the angle off the direct path.
		const extraNm = speedNmPerSec * horizonSec * oneMinusCos(degrees)
		const delaySec = extraNm / speedNmPerSec
		return {
			deltaTrackMilesNm: extraNm,
			arrivalDelaySec: delaySec,
			fuelBurnMg: burnFor(maneuver, degrees / 3),
			// 3 deg/s standard rate at 250 kt is about 1.06 g; scaled by how long we hold the turn.
			peakLoadFactor: 1.06,
		}
	}

	// A descent adds no track miles at all, but costs fuel and buys time.
	const feet = Math.abs(subject.altFt - (maneuver.command.targetAltFt ?? subject.altFt))
	const durationSec = feet / (2_000 / 60)
	return {
		deltaTrackMilesNm: 0,
		arrivalDelaySec: -durationSec * 0.05, // descending slightly ADVANCES the arrival
		fuelBurnMg: burnFor(maneuver, durationSec),
		peakLoadFactor: 1.0,
	}
}

function turnMagnitudeDegrees(maneuver: Maneuver, currentHeadingMdeg: number): number {
	const target = maneuver.command.targetHeadingMdeg ?? currentHeadingMdeg
	const delta = ((target - currentHeadingMdeg + 540_000) % 360_000) - 180_000
	return delta / 1000
}

/**
 * `1 - cos(theta)` by Taylor series, because the Math.* ban applies here too and this module gets
 * no exemption (only the heading table does). Two terms are ample for the 10-30 degree turns in
 * the catalogue — the error at 30 degrees is under 1e-4 — and the result feeds a COST, never a
 * separation decision, so its accuracy is a presentation concern rather than a safety one.
 *
 *   1 - cos(x) = x^2/2 - x^4/24 + ...
 */
function oneMinusCos(degrees: number): number {
	const x = degrees * RADIANS_PER_DEGREE
	const x2 = x * x
	return x2 / 2 - (x2 * x2) / 24
}

/** A literal constant, not a transcendental evaluation. pi / 180. */
const RADIANS_PER_DEGREE = 0.017453292519943295

/** Squared-range helper kept local so callers never reach for a euclidean mix of NM and ft. */
export function marginAgainst(a: AircraftState, b: AircraftState): SeparationSnapshot {
	return {
		horizontalNm: Math.sqrt(horizontalRangeSq(a, b)),
		verticalFt: verticalSeparationFt(a, b),
		separated: horizontalRangeSq(a, b) >= LATERAL_MINIMUM_NM * LATERAL_MINIMUM_NM
			|| verticalSeparationFt(a, b) >= VERTICAL_MINIMUM_FT,
	}
}

export type SeparationSnapshot = {
	readonly horizontalNm: number
	readonly verticalFt: number
	readonly separated: boolean
}
