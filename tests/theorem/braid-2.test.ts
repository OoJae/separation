import { describe, expect, it } from "@rstest/core"
import type { AircraftState } from "../../src/domain/airspace/aircraft-state"
import { flyEncounter, type PendingClearance } from "../../src/domain/airspace/encounter"
import { LATERAL_MINIMUM_NM, VERTICAL_MINIMUM_FT } from "../../src/domain/airspace/separation-standard"
import { degreesToMdeg } from "../../src/domain/airspace/units"
import {
	AAL221_ARMED, HORIZON_S, INITIAL_ARMED, SWA455, clearanceA, clearanceB,
} from "../../src/scenarios/braid-2"

const fly = (clearances: readonly PendingClearance[], init = INITIAL_ARMED) =>
	flyEncounter(init, clearances, HORIZON_S)

/**
 * BRAID-2 — the scenario Phase 3's theorem rests on.
 *
 * MECHANISM: separation is lost only when horizontal < 3 NM AND |dAlt| < 1000 ft. Clearance A is
 * purely vertical, clearance B purely lateral. Neither alone can produce a non-empty
 * intersection of the two breach intervals. Together they do.
 *
 * Every number here is MEASURED by the shipped 50 Hz integrator, not derived on paper.
 */
describe("BRAID-2", () => {
	describe("the four cases", () => {
		it("baseline: 3000 ft apart, no breach on either axis", () => {
			const r = fly([])
			expect(r.minHorizontalNm).toBeCloseTo(4.5962, 4)
			expect(r.verticalAtMinFt).toBe(3_000)
			expect(r.lateralBreach).toBeNull()
			expect(r.verticalBreach).toBeNull()
			expect(r.loss).toBeNull()
		})

		it("[A] alone removes VERTICAL protection only — still safe", () => {
			const r = fly([clearanceA()])
			expect(r.verticalBreach).not.toBeNull()          // vertical protection gone
			expect(r.lateralBreach).toBeNull()               // lateral still holds
			expect(r.minHorizontalNm).toBeCloseTo(4.5962, 4) // A does not move the lateral axis
			expect(r.loss).toBeNull()
		})

		it("[B] alone removes LATERAL protection only — still safe", () => {
			const r = fly([clearanceB()])
			expect(r.lateralBreach).not.toBeNull()           // lateral protection gone
			expect(r.verticalBreach).toBeNull()              // vertical still holds
			expect(r.minHorizontalNm).toBeCloseTo(2.5361, 4)
			expect(r.verticalAtMinFt).toBe(3_000)            // B does not move the vertical axis
			expect(r.loss).toBeNull()
		})

		it("[A,B] together loses separation — the intersection is non-empty", () => {
			const r = fly([clearanceA(), clearanceB()])
			expect(r.minHorizontalNm).toBeCloseTo(2.5361, 4)
			expect(r.minHorizontalNm).toBeLessThan(LATERAL_MINIMUM_NM)
			expect(r.verticalAtMinFt).toBeLessThan(VERTICAL_MINIMUM_FT)
			expect(r.loss).not.toBeNull()
			expect(r.lossSeconds).toBeCloseTo(24.4, 1)
		})
	})

	describe("the mechanism is orthogonality, not coincidence", () => {
		it("A moves ONLY the vertical interval and B ONLY the lateral one", () => {
			const a = fly([clearanceA()])
			const b = fly([clearanceB()])
			const base = fly([])

			expect(a.minHorizontalNm).toBeCloseTo(base.minHorizontalNm, 6) // A: lateral untouched
			expect(b.verticalAtMinFt).toBe(base.verticalAtMinFt)           // B: vertical untouched
		})

		it("the loss window is exactly where the two breach intervals overlap", () => {
			const both = fly([clearanceA(), clearanceB()])
			expect(both.lateralBreach).not.toBeNull()
			expect(both.verticalBreach).not.toBeNull()
			expect(both.loss).not.toBeNull()

			const expectedFrom = Math.max(both.lateralBreach!.fromS, both.verticalBreach!.fromS)
			const expectedTo = Math.min(both.lateralBreach!.toS, both.verticalBreach!.toS)
			expect(both.loss!.fromS).toBeCloseTo(expectedFrom, 2)
			expect(both.loss!.toS).toBeCloseTo(expectedTo, 2)
		})
	})

	describe("robustness — a knife-edge construction would read as rigged", () => {
		it("survives the whole commit-time grid: 81/81", () => {
			const grid = [0, 1.2, 2.4, 3.6, 4.8, 6.0, 7.2, 8.4, 9.6]
			let hazards = 0
			for (const ta of grid) for (const tb of grid) {
				if (fly([clearanceA(ta), clearanceB(tb)]).loss !== null) hazards++
			}
			expect(hazards).toBe(81)
		})

		it("survives initial-condition jitter, and no SINGLE clearance is ever hazardous there", () => {
			const deltas = [-0.1, 0, 0.1]
			let joint = 0, singles = 0, total = 0
			for (const dx of deltas) for (const dy of deltas) for (const dx2 of deltas) for (const dy2 of deltas) {
				total++
				const a: AircraftState = { ...AAL221_ARMED, x: AAL221_ARMED.x + dx, y: AAL221_ARMED.y + dy }
				const b: AircraftState = { ...SWA455, x: SWA455.x + dx2, y: SWA455.y + dy2 }
				const init = [a, b] as const
				if (fly([clearanceA(), clearanceB()], init).loss !== null) joint++
				if (fly([clearanceA()], init).loss !== null) singles++
				if (fly([clearanceB()], init).loss !== null) singles++
			}
			expect(joint).toBe(total)   // every jittered case still produces the joint hazard
			expect(singles).toBe(0)     // and never a single-clearance one
		})

		it("is a legible region, not one magic pair: shallow descents are safe", () => {
			const heading = degreesToMdeg(340)
			const hazardous = (targetAltFt: number) =>
				fly([
					{ ...clearanceA(), command: { targetAltFt } },
					{ ...clearanceB(), command: { targetHeadingMdeg: heading } },
				]).loss !== null

			expect(hazardous(4_000)).toBe(true)
			expect(hazardous(6_000)).toBe(true)
			// 7000 levels off exactly 1000 ft above SWA455 — legal, so no loss. The boundary is
			// the separation standard itself, which is why the region is explainable.
			expect(hazardous(7_000)).toBe(false)
			expect(hazardous(8_000)).toBe(false)
		})
	})

	describe("determinism", () => {
		it("two identical runs agree bit-for-bit", () => {
			const a = fly([clearanceA(), clearanceB()])
			const b = fly([clearanceA(), clearanceB()])
			expect(Object.is(a.minHorizontalNm, b.minHorizontalNm)).toBe(true)
			expect(Object.is(a.verticalAtMinFt, b.verticalAtMinFt)).toBe(true)
			expect(a).toEqual(b)
		})
	})
})
