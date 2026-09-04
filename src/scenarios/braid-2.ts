import type { AircraftState } from "../domain/airspace/aircraft-state"
import type { PendingClearance } from "../domain/airspace/encounter"
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
 *   - FLOW wants SWA455 turned for the metering fix: "turn left heading 340"     (lateral)
 *
 * Each controller is looking at a different axis, and neither can tell from its own axis that
 * the other is about to remove the protection it is relying on.
 */

export const COMMAND_LAG_S = 13.0 // T_RT 8.0 (transmit + readback) + T_PILOT 5.0
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
	x: 2.5,
	y: -6.0,
	altFt: 6_000,
	headingMdeg: degreesToMdeg(0), // north
	groundspeedKt: 250,
	verticalSpeedFpm: 0,
}

export const INITIAL: readonly [AircraftState, AircraftState] = [AAL221, SWA455]

/** Descent rate once a vertical clearance is live. */
export const DESCENT_FPM = 2_000

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
		command: { targetHeadingMdeg: degreesToMdeg(340) },
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
