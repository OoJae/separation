import { unitVector } from "./heading-table"
import {
	FPM_TO_FPS, INTEGRATE_DT_S, KT_TO_NM_PER_S, TURN_RATE_MDEG_PER_S, mdegDelta, normaliseMdeg,
	type Mdeg,
} from "./units"

export type Callsign = string

/**
 * One aircraft's kinematic state. Position and altitude are doubles; HEADING IS AN INTEGER in
 * milli-degrees, because a float heading accumulates drift (measured: 1500 ticks of 0.06 degrees
 * from 090 lands on 180.00000000000341, not 180).
 */
export type AircraftState = {
	readonly callsign: Callsign
	/** East, NM, from the radar antenna. */
	readonly x: number
	/** North, NM. */
	readonly y: number
	readonly altFt: number
	readonly headingMdeg: Mdeg
	readonly groundspeedKt: number
	/** Signed, ft/min. Zero when level. */
	readonly verticalSpeedFpm: number
}

/** Standard climb/descent rate a clearance arms when it does not specify one. */
export const DEFAULT_VERTICAL_RATE_FPM = 2_000

/**
 * What a clearance asks for. Absent fields mean "leave that axis alone".
 *
 * A vertical clearance ARMS its own rate — "descend and maintain 4000" causes a descent. The
 * aircraft's `verticalSpeedFpm` is an observation of what it is doing, not a precondition for
 * being told to do it.
 */
export type Command = {
	readonly targetAltFt?: number
	readonly targetHeadingMdeg?: Mdeg
	readonly verticalRateFpm?: number
}

/**
 * One 20 ms integration step (50 Hz).
 *
 * Semi-implicit Euler: attitude first, then translate along the NEW heading. At 3 degrees/s and
 * 20 ms the per-step turn is exactly 60 mdeg, so a standard-rate turn lands exactly on its target
 * on a determinate tick with no residue.
 *
 * There is no vertical acceleration ramp: vertical rate is constant with an exact level-off
 * clamp. That is a simplification and is stated as one — modelling a ramp we then failed to use
 * consistently would be worse than not modelling it.
 */
export function integrate(state: AircraftState, command: Command | undefined): AircraftState {
	let headingMdeg = state.headingMdeg
	let altFt = state.altFt
	let verticalSpeedFpm = state.verticalSpeedFpm

	if (command?.targetHeadingMdeg !== undefined) {
		const remaining = mdegDelta(headingMdeg, command.targetHeadingMdeg)
		const step = TURN_RATE_MDEG_PER_S * INTEGRATE_DT_S // exactly 60
		if (Math.abs(remaining) <= step) headingMdeg = normaliseMdeg(command.targetHeadingMdeg)
		else headingMdeg = normaliseMdeg(headingMdeg + Math.sign(remaining) * step)
	}

	if (command?.targetAltFt !== undefined) {
		const remaining = command.targetAltFt - altFt
		if (remaining === 0) {
			verticalSpeedFpm = 0
		} else {
			const rate = Math.abs(command.verticalRateFpm ?? DEFAULT_VERTICAL_RATE_FPM)
			const stepFt = rate * FPM_TO_FPS * INTEGRATE_DT_S
			if (Math.abs(remaining) <= stepFt) {
				altFt = command.targetAltFt // exact level-off, so the tick is determinate
				verticalSpeedFpm = 0
			} else {
				altFt += Math.sign(remaining) * stepFt
				verticalSpeedFpm = Math.sign(remaining) * rate
			}
		}
	}

	const { east, north } = unitVector(headingMdeg)
	const distance = state.groundspeedKt * KT_TO_NM_PER_S * INTEGRATE_DT_S

	return {
		callsign: state.callsign,
		x: state.x + east * distance,
		y: state.y + north * distance,
		altFt,
		headingMdeg,
		groundspeedKt: state.groundspeedKt,
		verticalSpeedFpm,
	}
}

/** Squared horizontal range in NM^2. Squared so no threshold comparison depends on sqrt. */
export function horizontalRangeSq(a: AircraftState, b: AircraftState): number {
	const dx = a.x - b.x
	const dy = a.y - b.y
	return dx * dx + dy * dy
}

export function verticalSeparationFt(a: AircraftState, b: AircraftState): number {
	return Math.abs(a.altFt - b.altFt)
}
