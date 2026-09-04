import { describe, expect, it } from "@rstest/core"
import { horizontalRangeSq, integrate, type AircraftState } from "../../src/domain/airspace/aircraft-state"
import { isSeparationLost, LATERAL_MINIMUM_NM_SQ } from "../../src/domain/airspace/separation-standard"
import { degreesToMdeg, INTEGRATE_DT_S, TURN_RATE_MDEG_PER_S } from "../../src/domain/airspace/units"

const level = (over: Partial<AircraftState> = {}): AircraftState => ({
	callsign: "TEST", x: 0, y: 0, altFt: 6_000,
	headingMdeg: degreesToMdeg(0), groundspeedKt: 250, verticalSpeedFpm: 0, ...over,
})

const stepN = (s: AircraftState, n: number, cmd?: Parameters<typeof integrate>[1]) => {
	let out = s
	for (let i = 0; i < n; i++) out = integrate(out, cmd)
	return out
}

describe("integrator", () => {
	describe("translation", () => {
		it("flies north at groundspeed", () => {
			const after = stepN(level(), 50 * 60) // 60 s at 50 Hz
			expect(after.y).toBeCloseTo(250 / 60, 6) // 250 kt = 4.1667 NM per minute
			expect(after.x).toBeCloseTo(0, 12)
		})

		it("flies east with no northward component — cardinals are snapped", () => {
			const after = stepN(level({ headingMdeg: degreesToMdeg(90) }), 50 * 60)
			expect(after.x).toBeCloseTo(250 / 60, 6)
			expect(after.y).toBe(0) // exactly, not 1e-15
		})
	})

	describe("turning", () => {
		it("turns at exactly 60 mdeg per tick — a standard rate turn", () => {
			expect(TURN_RATE_MDEG_PER_S * INTEGRATE_DT_S).toBe(60)
			const after = integrate(level(), { targetHeadingMdeg: degreesToMdeg(90) })
			expect(after.headingMdeg).toBe(60)
		})

		it("lands EXACTLY on the target heading, with no residue", () => {
			// 000 -> 340 is a 20 degree left turn = 20000 mdeg / 60 = 333.33 ticks
			const after = stepN(level(), 400, { targetHeadingMdeg: degreesToMdeg(340) })
			expect(after.headingMdeg).toBe(340_000)
		})

		it("takes the short way round rather than the long way", () => {
			const after = integrate(level({ headingMdeg: degreesToMdeg(10) }), { targetHeadingMdeg: degreesToMdeg(350) })
			expect(after.headingMdeg).toBe(9_940) // turning left through north, not right the long way
		})

		it("a 3 deg/s turn covers 90 degrees in 30 seconds", () => {
			const after = stepN(level(), 50 * 30, { targetHeadingMdeg: degreesToMdeg(90) })
			expect(after.headingMdeg).toBe(90_000)
		})
	})

	describe("vertical", () => {
		it("descends at the armed rate", () => {
			const after = stepN(level({ verticalSpeedFpm: -2_000 }), 50 * 30, { targetAltFt: 4_000 })
			expect(after.altFt).toBeCloseTo(5_000, 6) // 2000 fpm for 30 s = 1000 ft
		})

		it("levels off EXACTLY on the target, so the tick is determinate", () => {
			const after = stepN(level({ verticalSpeedFpm: -2_000 }), 50 * 120, { targetAltFt: 4_000 })
			expect(after.altFt).toBe(4_000) // exactly
			expect(after.verticalSpeedFpm).toBe(0)
		})

		it("a vertical clearance ARMS its own descent — being told to descend causes a descent", () => {
			// The aircraft starts level. The clearance alone is enough to move it.
			const after = stepN(level({ verticalSpeedFpm: 0 }), 50 * 30, { targetAltFt: 4_000 })
			expect(after.altFt).toBeCloseTo(5_000, 6)
			expect(after.verticalSpeedFpm).toBe(-2_000)
		})

		it("stays level when the clearance says nothing about altitude", () => {
			const after = stepN(level({ verticalSpeedFpm: 0 }), 500, { targetHeadingMdeg: degreesToMdeg(90) })
			expect(after.altFt).toBe(6_000)
			expect(after.verticalSpeedFpm).toBe(0)
		})

		it("honours an explicit rate over the default", () => {
			const slow = stepN(level(), 50 * 30, { targetAltFt: 4_000, verticalRateFpm: 1_000 })
			expect(slow.altFt).toBeCloseTo(5_500, 6)
		})
	})

	describe("separation predicate", () => {
		it("requires BOTH minima to be violated — this is the whole mechanism", () => {
			const close = 2.0 * 2.0        // 2 NM, inside the 3 NM lateral minimum
			const far = 5.0 * 5.0
			expect(isSeparationLost(close, 500)).toBe(true)   // both violated
			expect(isSeparationLost(close, 1_500)).toBe(false) // lateral only
			expect(isSeparationLost(far, 500)).toBe(false)     // vertical only
			expect(isSeparationLost(far, 1_500)).toBe(false)
		})

		it("compares squared ranges, so no branch depends on sqrt", () => {
			expect(LATERAL_MINIMUM_NM_SQ).toBe(9)
			const a = level({ x: 0, y: 0 })
			const b = level({ x: 3, y: 4 })
			expect(horizontalRangeSq(a, b)).toBe(25)
		})
	})

	describe("determinism", () => {
		it("1500 turn ticks land exactly on target, where float degrees would drift", () => {
			let drifting = 90
			for (let i = 0; i < 1_500; i++) drifting += 0.06
			expect(drifting).not.toBe(180)

			const after = stepN(level({ headingMdeg: degreesToMdeg(90) }), 1_500, { targetHeadingMdeg: degreesToMdeg(180) })
			expect(after.headingMdeg).toBe(180_000)
		})

		it("two identical integrations agree bit-for-bit over 10000 ticks", () => {
			const run = () => stepN(level({ headingMdeg: degreesToMdeg(37) }), 10_000, { targetHeadingMdeg: degreesToMdeg(211) })
			const a = run(), b = run()
			expect(Object.is(a.x, b.x)).toBe(true)
			expect(Object.is(a.y, b.y)).toBe(true)
			expect(a).toEqual(b)
		})
	})
})
