import { describe, expect, it } from "@rstest/core"
import { eastOf, northOf, tableEntry, unitVector } from "../../src/domain/airspace/heading-table"
import { HEADING_GOLDEN } from "../../src/domain/airspace/heading-table.golden"
import { HEADING_TABLE_SIZE, MDEG_GRID } from "../../src/domain/airspace/units"

describe("heading table", () => {
	/**
	 * The determinism tripwire. IEEE-754 does not mandate correct rounding for Math.sin/cos, so
	 * another engine may differ in the last bit. We cannot prevent that; we can refuse to let it
	 * pass silently. Object.is, not toBeCloseTo — the whole point is bit-exactness.
	 */
	it("matches all 720 checked-in golden vectors bit-for-bit", () => {
		expect(HEADING_GOLDEN).toHaveLength(720)
		const drift: string[] = []
		for (const [mdeg, east, north] of HEADING_GOLDEN) {
			if (!Object.is(eastOf(mdeg), east)) drift.push(`east(${mdeg}): ${eastOf(mdeg)} !== ${east}`)
			if (!Object.is(northOf(mdeg), north)) drift.push(`north(${mdeg}): ${northOf(mdeg)} !== ${north}`)
		}
		expect(drift).toEqual([])
	})

	it("uses aviation convention — 000 is North, 090 is East", () => {
		expect(unitVector(0)).toEqual({ east: 0, north: 1 })
		expect(unitVector(90_000)).toEqual({ east: 1, north: 0 })
		expect(unitVector(180_000)).toEqual({ east: 0, north: -1 })
		expect(unitVector(270_000)).toEqual({ east: -1, north: 0 })
	})

	it("snaps the cardinals exactly — no 6.12e-17 residue, no -0", () => {
		for (const mdeg of [0, 90_000, 180_000, 270_000]) {
			const { east, north } = unitVector(mdeg)
			expect(Object.is(east, -0)).toBe(false)
			expect(Object.is(north, -0)).toBe(false)
			expect(Math.abs(east) === 0 || Math.abs(east) === 1).toBe(true)
			expect(Math.abs(north) === 0 || Math.abs(north) === 1).toBe(true)
		}
	})

	it("is a unit vector everywhere, to 1e-15", () => {
		let worst = 0
		for (let i = 0; i < HEADING_TABLE_SIZE; i++) {
			const { east, north } = tableEntry(i)
			worst = Math.max(worst, Math.abs(east * east + north * north - 1))
		}
		expect(worst).toBeLessThan(1e-15)
	})

	it("rejects a heading off the 20 mdeg grid rather than rounding it silently", () => {
		expect(() => eastOf(10)).toThrow(/off the 20 mdeg grid/)
		expect(() => eastOf(1_001)).toThrow()
		expect(() => eastOf(1_000)).not.toThrow()
	})

	it("normalises headings outside [0, 360000)", () => {
		expect(unitVector(360_000)).toEqual(unitVector(0))
		expect(unitVector(-90_000)).toEqual(unitVector(270_000))
	})

	it("covers the per-tick turn increment and whole-degree targets", () => {
		expect(60 % MDEG_GRID).toBe(0)   // 3000 mdeg/s x 20 ms
		expect(1_000 % MDEG_GRID).toBe(0) // one whole degree
	})
})
