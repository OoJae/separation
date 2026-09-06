import type { AircraftState } from "../domain/airspace/aircraft-state"
import type { PendingClearance } from "../domain/airspace/encounter"
import { COMMAND_LAG_S, computeWindow, levelChangeDurationS, turnAndEstablishDurationS, type ManeuverWindow } from "../domain/airspace/maneuver-window"
import { eastOf } from "../domain/airspace/heading-table"
import { degreesToMdeg, secondsToTick } from "../domain/airspace/units"

/**
 * BRAID-2 — the joint-hazard scenario.
 *
 * MECHANISM: axis orthogonality. Separation is lost only when horizontal < 3 NM AND
 * |dAlt| < 1000 ft (see separation-standard.ts). Clearance A is PURELY VERTICAL and moves only
 * the vertical interval; clearance B is PURELY LATERAL and moves only the lateral one. Neither
 * alone can produce a non-empty intersection. Together they do.
 *
 * Two aircraft converge on the same fix. AAL221 runs in from the west at 9000 ft; SWA455 comes
 * up from the south at 6000 ft. Laterally they will pass close; vertically they are 3000 ft
 * apart, so there is no conflict.
 *
 *   - APPROACH wants AAL221 down for the arrival:  "descend and maintain 4000"   (vertical)
 *   - FLOW wants SWA455 turned for the metering fix: "turn left heading 348"     (lateral)
 *
 * Each controller is looking at a different axis, and neither can tell from its own axis that
 * the other is about to remove the protection it is relying on.
 */

/** Re-exported, not redeclared: the lag is a physical constant of the R/T loop, not a scenario knob. */
export { COMMAND_LAG_S }
export const HORIZON_S = 380

export const AAL221: AircraftState = {
	callsign: "AAL221",
	x: -10.0,
	y: 0.0,
	altFt: 9_000,
	headingMdeg: degreesToMdeg(90), // east
	groundspeedKt: 250,
	verticalSpeedFpm: 0,
}

export const SWA455: AircraftState = {
	callsign: "SWA455",
	x: 0.9,
	y: -6.0,
	altFt: 6_000,
	headingMdeg: degreesToMdeg(0), // north
	groundspeedKt: 250,
	verticalSpeedFpm: 0,
}

export const INITIAL: readonly [AircraftState, AircraftState] = [AAL221, SWA455]

/** Descent rate once a vertical clearance is live. */
export const DESCENT_FPM = 2_000

export const REQUIRED_OFFSET_NM = 0.6
/**
 * SHALLOWED from 20 degrees when the two-clock defect was fixed — and NOT for the reason first
 * written here.
 *
 * The original note claimed a shallower turn "buys hazard lifetime". Measurement says the opposite:
 * holding this start position, 20 degrees gives 59.5 s of lifetime and 12 degrees only 53.5 s. The
 * lifetime comes from the CLOSER START, not from the shallower turn.
 *
 * What the shallower turn actually buys is TCAS silence, and that is what pins it. At this position
 * a 20-degree turn closes to 1.6184 NM and fires 1242 traffic advisories; 15 degrees closes to
 * 2.0751 NM and fires 764; 12 degrees closes to 2.3511 NM and fires none. The pair (12 degrees,
 * x = 0.9) is the shallowest-cost combination that holds the hazard alive across the whole
 * concurrent commit range while leaving the collision-avoidance system with nothing to say — which
 * is the constraint that protects the thesis, since an advisory the safety net acts on would
 * resolve the encounter for us.
 *
 * hazard-lifetime.test.ts computes the lifetime rather than trusting any of this.
 */
export const TURN_DEGREES = 12
export const TURN_RATE_DEG_PER_S = 3

export function clearanceA(committedSeconds = 0): PendingClearance {
	return {
		id: "A",
		callsign: "AAL221",
		command: { targetAltFt: 4_000, verticalRateFpm: DESCENT_FPM },
		committedTick: secondsToTick(committedSeconds),
		effectiveTick: secondsToTick(committedSeconds + COMMAND_LAG_S),
	}
}

export function clearanceB(committedSeconds = 0): PendingClearance {
	return {
		id: "B",
		callsign: "SWA455",
		command: { targetHeadingMdeg: degreesToMdeg(360 - TURN_DEGREES) },
		committedTick: secondsToTick(committedSeconds),
		effectiveTick: secondsToTick(committedSeconds + COMMAND_LAG_S),
	}
}

/**
 * Retained as aliases: clearance A now arms its own descent rate (a clearance to descend causes
 * a descent), so there is no separate "armed" initial state. Kept so callers read naturally.
 */
export const AAL221_ARMED = AAL221
export const INITIAL_ARMED = INITIAL

// ─────────────────────────────────────────────────────────────────────────────────────────
// GATES AND WINDOWS
//
// The gate DISTANCES below are calibrated: they are chosen so both manoeuvre windows land
// inside the admissible band. That is a scenario parameter and it is stated openly here and in
// the README rather than buried.
//
// What is NOT calibrated is the band itself, which is derived from the controller-latency model
// in src/domain/interlock/decision-latency.ts and has no geometry in it at all.
// tests/theorem/window-band.test.ts COMPUTES the band and asserts these gates lie strictly
// inside it — so changing the latency model fails that test and tells you to re-derive the
// gates, instead of letting a stale calibration slide through.
// ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * BAYLR — AAL221 must be level at 4000 by here.
 * RE-DERIVED 2026-09-05 from measured latency (was 12.0 NM against the assumed distribution).
 * Admissible range is now [13.7208, 15.0092] NM; 14.4 sits near its centre.
 */
export const GATE_A_NM = 14.4
/**
 * CARDL — SWA455 must be established with 0.60 NM of in-trail offset by here.
 * RE-DERIVED likewise (was 3.86 NM, then 6.2 NM). Moved again when the two-clock defect was
 * fixed: the turn shallowed from 20 to 12 degrees, which lengthens the manoeuvre, so the gate has
 * to move out to keep W_B inside the admissible band. W_B is now 43684 ms, near the band's centre.
 */
export const GATE_B_NM = 7.1

/** Descending 5000 ft at 2000 fpm takes 150 s, and the gate does not move while it happens. */
export const MANEUVER_A_DURATION_S = levelChangeDurationS(9_000, 4_000, DESCENT_FPM)

/**
 * B's turn is quick; what costs time is flying the new heading long enough to actually be
 * displaced. Counting only the turn would give B a window of minutes and quietly destroy the
 * scenario. sin(20 degrees) is read from the heading table, since Math.sin is banned here.
 */
export const MANEUVER_B_DURATION_S = turnAndEstablishDurationS({
	turnDegrees: TURN_DEGREES,
	turnRateDegPerSec: TURN_RATE_DEG_PER_S,
	requiredOffsetNm: REQUIRED_OFFSET_NM,
	groundspeedKt: SWA455.groundspeedKt,
	sinOffAngle: eastOf(degreesToMdeg(TURN_DEGREES)),
})

export const WINDOW_A: ManeuverWindow = computeWindow({
	label: "AAL221 -> BAYLR",
	gateDistanceNm: GATE_A_NM,
	maneuverDurationS: MANEUVER_A_DURATION_S,
	groundspeedKt: AAL221.groundspeedKt,
})

export const WINDOW_B: ManeuverWindow = computeWindow({
	label: "SWA455 -> CARDL",
	gateDistanceNm: GATE_B_NM,
	maneuverDurationS: MANEUVER_B_DURATION_S,
	groundspeedKt: SWA455.groundspeedKt,
})

export const WINDOWS: ReadonlyMap<string, ManeuverWindow> = new Map([
	["A", WINDOW_A],
	["B", WINDOW_B],
])

/** Narrowing candidates for A, most useful first — see narrowToSafe. */
export function narrowingCandidatesForA(committedSeconds = 0): readonly PendingClearance[] {
	return [5_000, 6_000, 7_000, 8_000].map((targetAltFt) => ({
		...clearanceA(committedSeconds),
		id: `A/descend-${targetAltFt}`,
		command: { targetAltFt, verticalRateFpm: DESCENT_FPM },
	}))
}
