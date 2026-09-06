import {
	horizontalRangeSq, verticalSeparationFt, type AircraftState, type Callsign, turnMagnitudeDeg,
} from "../airspace/aircraft-state"
import { flyEncounter, type PendingClearance } from "../airspace/encounter"
import { LATERAL_MINIMUM_NM, VERTICAL_MINIMUM_FT } from "../airspace/separation-standard"
import {
	DEG_TO_RAD, G_M_PER_S2, KT_TO_M_PER_S, KT_TO_NM_PER_S, TURN_RATE_MDEG_PER_S, secondsToTick,
} from "../airspace/units"
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
/**
 * Fuel MARGINAL to doing nothing, integer milligrams. Negative when the manoeuvre saves fuel.
 *
 * This used to return the ABSOLUTE burn during the manoeuvre, while the speed branch returned a
 * marginal delta — so the axis mixed two conventions and its values were not comparable with each
 * other. A turn was "+8.3 million" and a speed reduction "−63.8 million", and Pareto-comparing them
 * was meaningless: one was fuel spent over six seconds of turning, the other a saving over six
 * minutes of flying. Nothing can be dominated or incomparable on an axis with no common referent.
 *
 * Every branch now answers the same question — what does this manoeuvre cost, or save, against
 * simply carrying on — so an idle descent is correctly a saving and a turn correctly a cost.
 */
function burnFor(maneuver: Maneuver, durationSec: number): number {
	const regime = maneuver.axis === "vertical" ? "descent" : maneuver.axis === "lateral" ? "turning" : "cruise"
	const marginalMgPerSec = BURN_MG_PER_SEC[regime] - BURN_MG_PER_SEC.cruise
	return Math.round((marginalMgPerSec * Math.round(durationSec * 1000)) / 1000)
}

/**
 * Peak load factor for a level turn, in g.
 *
 * A rate-omega turn at speed v needs bank phi with tan(phi) = v*omega/g, and the load factor of a
 * level banked turn is 1/cos(phi) = sqrt(1 + tan(phi)^2). Substituting gives this closed form,
 * which uses only multiply, divide and sqrt — all IEEE-correctly-rounded — so the Math.* ban holds
 * with no new exemption and no trigonometry.
 *
 * This REPLACES a hardcoded 1.06 that was returned for every turn regardless of angle, rate or
 * speed. A constant axis carries no information: it made `peakLoadFactor` decorative and left the
 * six turns totally ordered, so "four incommensurable axes" was really three. Now a faster turn
 * or a higher rate genuinely costs more g, and a speed reduction genuinely costs less.
 *
 * A SIMPLIFICATION WORTH STATING, because the numbers are checkable and a reader who flies will
 * check them. At 250 kt the model's standard rate implies 34.5 degrees of bank, and the expedited
 * rate 53.9 degrees at 1.70 g — both above the 25-30 degrees an airliner would actually use in a
 * terminal area. The reason is that this model turns at a FIXED groundspeed: a real aircraft slows
 * before it turns hard, and nothing here couples the two axes. The formula is right and the inputs
 * are the scenario's; the bank it implies at 250 kt is aggressive, and "expedite" should be read as
 * the catalogue's steepest option rather than as a manoeuvre a captain would fly with passengers.
 * The axis is used to ORDER options against each other, and for that the relative values hold.
 */
export function loadFactorFor(groundspeedKt: number, turnRateMdegPerS: number): number {
	const vMs = groundspeedKt * KT_TO_M_PER_S
	const omegaRadPerS = (turnRateMdegPerS / 1000) * DEG_TO_RAD
	const tanPhi = (vMs * omegaRadPerS) / G_M_PER_S2
	return Math.sqrt(1 + tanPhi * tanPhi)
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
		// A manoeuvre that asks for what the aircraft is already doing costs nothing on every axis,
		// and an all-zero cost vector DOMINATES every real option — handing a solver a free argmax
		// and quietly emptying the Pareto frontier. Not an option, so not in the set.
		if (isNoOp(maneuver, subject)) continue
		const optionId = `${subject.callsign}/${maneuver.template}`
		const clearance: PendingClearance = {
			id: optionId,
			callsign: subject.callsign,
			command: maneuver.command,
			// RELATIVE TO THE WORLD SUPPLIED, which is what flyEncounter integrates from.
			//
			// These were `secondsToTick(request.nowSec)`. The world handed in is already the world
			// AT nowSec, so stamping the clearance with nowSec too delayed the manoeuvre by that
			// much a second time — the same clearance-tick/world-clock mismatch the joint prober
			// calls unrepresentable, sitting in its sibling. It was latent only because every caller
			// passes nowSec 0. `nowSec` is metadata for availability windows and nothing else.
			committedTick: 0,
			effectiveTick: 0,
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

/** Does this manoeuvre ask the aircraft for something it is already doing? */
function isNoOp(maneuver: Maneuver, subject: AircraftState): boolean {
	const { targetAltFt, targetHeadingMdeg, targetGroundspeedKt } = maneuver.command
	if (targetAltFt !== undefined && targetAltFt !== subject.altFt) return false
	if (targetHeadingMdeg !== undefined && targetHeadingMdeg !== subject.headingMdeg) return false
	if (targetGroundspeedKt !== undefined && targetGroundspeedKt !== subject.groundspeedKt) return false
	return true
}

function costOf(maneuver: Maneuver, subject: AircraftState, horizonSec: number): CostVector {
	const speedNmPerSec = subject.groundspeedKt * KT_TO_NM_PER_S

	if (maneuver.axis === "lateral") {
		const degrees = Math.abs(turnMagnitudeDegrees(maneuver, subject.headingMdeg))
		const rate = maneuver.command.turnRateMdegPerS ?? TURN_RATE_MDEG_PER_S
		const turnDurationSec = degrees / (rate / 1000)
		// A turn adds track miles roughly in proportion to the angle off the direct path, scaled by
		// how much of the horizon is spent displaced. An EXPEDITED turn rolls out sooner, so it
		// spends MORE of the horizon on the new heading and therefore costs slightly MORE track
		// miles — not fewer. What it buys is FUEL: half the time in the expensive turning regime.
		// The trade is fuel and time against track miles and g, and it is genuinely three-sided.
		// Clamped: horizonSec is a free caller parameter, and a horizon shorter than the turn itself
		// would make this negative — handing back NEGATIVE track miles and a turn that dominates
		// everything by appearing to save distance.
		const offTrackFraction = Math.min(1, Math.max(0, (horizonSec - turnDurationSec) / horizonSec))
		const extraNm = speedNmPerSec * horizonSec * oneMinusCos(degrees) * offTrackFraction
		return {
			deltaTrackMilesNm: extraNm,
			arrivalDelaySec: extraNm / speedNmPerSec,
			fuelBurnMg: burnFor(maneuver, turnDurationSec),
			peakLoadFactor: loadFactorFor(subject.groundspeedKt, rate),
		}
	}

	if (maneuver.axis === "speed") {
		// Zero track miles, LATER arrival, and LESS fuel. That combination is the whole reason fuel
		// is a separate axis: no turn and no descent can produce it, so a speed reduction is
		// genuinely incomparable with both. Slowing down to save fuel is also simply what airlines
		// do — an early version of this branch charged extra fuel for slowing, which made every
		// speed option strictly dominated and the axis decorative again.
		const targetKt = maneuver.command.targetGroundspeedKt ?? subject.groundspeedKt
		if (targetKt >= subject.groundspeedKt) {
			return { deltaTrackMilesNm: 0, arrivalDelaySec: 0, fuelBurnMg: 0, peakLoadFactor: 1.0 }
		}
		const distanceNm = speedNmPerSec * horizonSec
		const timeAtNewSpeedSec = distanceNm / (targetKt * KT_TO_NM_PER_S)
		const delaySec = timeAtNewSpeedSec - horizonSec

		// Fuel flow above best-range speed rises faster than linearly with speed (drag goes as v^2),
		// so the ratio is squared rather than proportional. Proportional would make fuel a pure
		// function of DISTANCE and cancel exactly — which is how this axis collapsed before.
		const ratio = targetKt / subject.groundspeedKt
		const slowBurnMgPerSec = BURN_MG_PER_SEC.cruise * ratio * ratio
		const spent = slowBurnMgPerSec * timeAtNewSpeedSec
		const wouldHaveSpent = BURN_MG_PER_SEC.cruise * horizonSec
		return {
			deltaTrackMilesNm: 0,
			arrivalDelaySec: delaySec,
			fuelBurnMg: Math.round(spent - wouldHaveSpent), // negative: a SAVING
			peakLoadFactor: 1.0,
		}
	}

	// A descent adds no track miles at all, but costs fuel and buys time.
	// A "descend to 7000" issued to an aircraft already at 7000 changes nothing, so every axis is
	// zero — and an all-zero cost vector DOMINATES every real option. It is filtered out of the set
	// rather than costed; see isNoOp at the call site.
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
	// Delegates to the airspace domain so the desk and the prober cannot drift apart.
	return turnMagnitudeDeg(currentHeadingMdeg, maneuver.command.targetHeadingMdeg ?? currentHeadingMdeg)
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
