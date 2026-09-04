import {
	horizontalRangeSq, integrate, verticalSeparationFt,
	type AircraftState, type Callsign, type Command,
} from "./aircraft-state"
import { isSeparationLost, LATERAL_MINIMUM_NM_SQ, VERTICAL_MINIMUM_FT } from "./separation-standard"
import { INTEGRATE_EVERY, MASTER_TICK_MS, secondsToTick, tickToSeconds, type Tick } from "./units"

/** A clearance, and when it reaches the metal. */
export type PendingClearance = {
	readonly id: string
	readonly callsign: Callsign
	readonly command: Command
	/** Wall-clock tick the controller committed. Effect is delayed by the command lag. */
	readonly committedTick: Tick
	readonly effectiveTick: Tick
}

/** A half-open interval of simulated time, in seconds. */
export type Interval = { readonly fromS: number; readonly toS: number }

export type EncounterResult = {
	readonly minHorizontalNm: number
	readonly atSeconds: number
	readonly verticalAtMinFt: number
	/** When horizontal separation is below the lateral minimum. */
	readonly lateralBreach: Interval | null
	/** When vertical separation is below the vertical minimum. */
	readonly verticalBreach: Interval | null
	/** The intersection — actual loss of separation. Non-null only if BOTH are breached at once. */
	readonly loss: Interval | null
	readonly lossSeconds: number
}

/**
 * Fly two aircraft forward and measure what actually happens.
 *
 * Deliberately NOT a closed-form CPA. A turning aircraft flies an arc, and a descending one
 * changes its vertical interval mid-encounter, so the linear r + vt model is wrong exactly where
 * this scenario lives. We integrate at 50 Hz and measure, and the numbers we publish are the
 * numbers the shipped integrator produces.
 */
export function flyEncounter(
	initial: readonly [AircraftState, AircraftState],
	clearances: readonly PendingClearance[],
	horizonSeconds: number,
): EncounterResult {
	let [a, b] = initial
	const horizonTick = secondsToTick(horizonSeconds)

	let minRangeSq = horizontalRangeSq(a, b)
	let minTick: Tick = 0
	let verticalAtMin = verticalSeparationFt(a, b)

	let lateralFrom: number | null = null
	let lateralTo: number | null = null
	let verticalFrom: number | null = null
	let verticalTo: number | null = null
	let lossFrom: number | null = null
	let lossTo: number | null = null

	const commandFor = (callsign: Callsign, tick: Tick): Command | undefined => {
		let merged: Command | undefined
		for (const clearance of clearances) {
			if (clearance.callsign !== callsign || tick < clearance.effectiveTick) continue
			merged = { ...merged, ...clearance.command }
		}
		return merged
	}

	for (let tick = 0; tick <= horizonTick; tick++) {
		if (tick > 0 && tick % INTEGRATE_EVERY === 0) {
			a = integrate(a, commandFor(a.callsign, tick))
			b = integrate(b, commandFor(b.callsign, tick))
		}

		const rangeSq = horizontalRangeSq(a, b)
		const vertical = verticalSeparationFt(a, b)
		const seconds = tickToSeconds(tick)

		if (rangeSq < minRangeSq) {
			minRangeSq = rangeSq
			minTick = tick
			verticalAtMin = vertical
		}

		if (rangeSq < LATERAL_MINIMUM_NM_SQ) {
			if (lateralFrom === null) lateralFrom = seconds
			lateralTo = seconds
		}
		if (vertical < VERTICAL_MINIMUM_FT) {
			if (verticalFrom === null) verticalFrom = seconds
			verticalTo = seconds
		}
		if (isSeparationLost(rangeSq, vertical)) {
			if (lossFrom === null) lossFrom = seconds
			lossTo = seconds
		}
	}

	const interval = (from: number | null, to: number | null): Interval | null =>
		from === null || to === null ? null : { fromS: from, toS: to }

	const loss = interval(lossFrom, lossTo)
	return {
		minHorizontalNm: Math.sqrt(minRangeSq),
		atSeconds: tickToSeconds(minTick),
		verticalAtMinFt: verticalAtMin,
		lateralBreach: interval(lateralFrom, lateralTo),
		verticalBreach: interval(verticalFrom, verticalTo),
		loss,
		lossSeconds: loss === null ? 0 : loss.toS - loss.fromS + MASTER_TICK_MS / 1000,
	}
}
