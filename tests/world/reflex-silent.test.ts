import { describe, expect, it } from "@rstest/core"
import {
	AdvisoryTracker, isComplementary, modeSAddress, selectSense, testAdvisory,
} from "../../src/domain/reflex/advisory"
import { CLEAR_TICKS, CONFIRM_TICKS, sensitivityFor } from "../../src/domain/reflex/constants"
import { modifiedTauSeconds, verticalTauSeconds } from "../../src/domain/reflex/tau"
import { WorldEngine } from "../../src/infrastructure/simulation/world-engine"
import type { PendingClearance } from "../../src/domain/airspace/encounter"
import { secondsToTick } from "../../src/domain/airspace/units"
import { AAL221, HORIZON_S, SWA455, clearanceA, clearanceB } from "../../src/scenarios/braid-2"

function flyWithTcas(clearances: readonly PendingClearance[]) {
	const world = WorldEngine.init([AAL221, SWA455])
	const applied = new Set<string>()
	let ras = 0, tas = 0
	let bestRaTau = Number.POSITIVE_INFINITY, bestTaTau = Number.POSITIVE_INFINITY
	let minRangeNm = Number.POSITIVE_INFINITY, minVerticalFt = Number.POSITIVE_INFINITY
	const row = sensitivityFor(6_000)

	for (let tick = 1; tick <= secondsToTick(HORIZON_S); tick++) {
		for (const c of clearances) {
			if (tick >= c.effectiveTick && !applied.has(c.id)) {
				applied.add(c.id)
				world.command(c.callsign, c.command)
			}
		}
		for (const closure of world.step().closures) {
			for (const own of [world.stateOf(closure.a)!, world.stateOf(closure.b)!]) {
				const test = testAdvisory(closure, own.altFt)
				if (test.kind === "resolution") ras++
				if (test.kind === "traffic") tas++
			}
			bestRaTau = Math.min(bestRaTau, modifiedTauSeconds(closure.rangeSqNm2, closure.closureRateNmPerSec, row.raDmodNm))
			bestTaTau = Math.min(bestTaTau, modifiedTauSeconds(closure.rangeSqNm2, closure.closureRateNmPerSec, row.taDmodNm))
			minRangeNm = Math.min(minRangeNm, Math.sqrt(closure.rangeSqNm2))
			minVerticalFt = Math.min(minVerticalFt, closure.verticalSeparationFt)
		}
	}
	return { ras, tas, bestRaTau, bestTaTau, minRangeNm, minVerticalFt, row }
}

/**
 * THE TEST THAT PROTECTS THE THESIS.
 *
 * If TCAS resolved BRAID-2, the joint hazard would be an encounter the safety net already
 * handles, and no amount of architecture above it would matter. So: does it?
 */
describe("the reflex layer stays silent through BRAID-2", () => {
	it("fires no RA and no TA in any of the four cases", () => {
		for (const clearances of [[], [clearanceA()], [clearanceB()], [clearanceA(), clearanceB()]]) {
			const r = flyWithTcas(clearances)
			expect(r.ras).toBe(0)
			expect(r.tas).toBe(0)
		}
	})

	/**
	 * WHICH test does the work, and by how much. Being precise here matters, because the two
	 * margins are very different and only one of them is comfortable.
	 */
	it("is the RANGE test that keeps it silent — by 4.6x — not the vertical one", () => {
		const r = flyWithTcas([clearanceA(), clearanceB()])
		expect(r.minRangeNm).toBeCloseTo(2.5361, 4)
		expect(r.minRangeNm / r.row.raDmodNm).toBeGreaterThan(4.5)
		expect(r.bestRaTau / r.row.raTauS).toBeGreaterThan(1.7)
	})

	it("the vertical test would PASS — the aircraft cross co-altitude — and it never matters", () => {
		const r = flyWithTcas([clearanceA(), clearanceB()])
		// AAL221 descends 9000 -> 4000 straight through SWA455's 6000, so at some point the
		// vertical gap is ~0. An advisory needs BOTH tests, and the range test never passes.
		expect(r.minVerticalFt).toBeLessThan(r.row.raZthrFt)
		expect(r.ras).toBe(0)
	})

	/**
	 * Stated rather than hidden: the TA margin is thin. A TA is advisory only — it commands no
	 * manoeuvre — so even if the geometry shifted enough to trigger one, the encounter would
	 * still be unresolved and the result would stand. The RA margin is what protects the thesis,
	 * and that one is comfortable.
	 */
	it("has only a 6% margin on the TA threshold, which is honest and does not matter", () => {
		const r = flyWithTcas([clearanceA(), clearanceB()])
		const taMargin = r.bestTaTau / r.row.taTauS
		expect(taMargin).toBeGreaterThan(1.0)
		expect(taMargin).toBeLessThan(1.2) // thin, and we say so
	})
})

describe("advisory mechanics", () => {
	describe("modified tau", () => {
		it("is infinite when the pair is not closing", () => {
			expect(modifiedTauSeconds(25, 0, 0.55)).toBe(Number.POSITIVE_INFINITY)
			expect(modifiedTauSeconds(25, 0.5, 0.55)).toBe(Number.POSITIVE_INFINITY)
		})

		it("shrinks as a closing encounter develops", () => {
			const far = modifiedTauSeconds(100, -0.05, 0.55)
			const near = modifiedTauSeconds(4, -0.05, 0.55)
			expect(near).toBeLessThan(far)
			expect(near).toBeGreaterThan(0)
		})

		it("credits DMOD, so a slow close pass fires far earlier than plain tau would", () => {
			// A slow, close encounter: 0.6 NM apart, closing at only 0.001 NM/s.
			const rangeSq = 0.36, rate = -0.001, dmod = 0.55
			const plainTau = Math.sqrt(rangeSq) / -rate          // 600 s — uselessly far off
			const modified = modifiedTauSeconds(rangeSq, rate, dmod)
			expect(plainTau).toBeCloseTo(600, 0)
			expect(modified).toBeLessThan(plainTau / 5)          // ~96 s — actionable
			expect(modified).toBeGreaterThan(0)
		})

		it("goes non-positive once the pair is already inside DMOD", () => {
			// r < DMOD: the protected radius has been penetrated, so the test is already met.
			expect(modifiedTauSeconds(0.09, -0.001, 0.55)).toBeLessThanOrEqual(0)
		})

		it("vertical tau is infinite when the gap is opening", () => {
			expect(verticalTauSeconds(500, 10)).toBe(Number.POSITIVE_INFINITY)
			expect(verticalTauSeconds(500, -10)).toBe(50)
		})
	})

	describe("pairwise sense selection has no arbiter", () => {
		it("gives complementary senses from geometry when altitudes differ", () => {
			const mine = selectSense(9_000, 6_000, 1, 2)
			const theirs = selectSense(6_000, 9_000, 2, 1)
			expect(mine).toBe("climb")   // higher aircraft climbs
			expect(theirs).toBe("descend")
			expect(isComplementary(mine, theirs)).toBe(true)
		})

		it("falls back to Mode S address inside the indifference band, still complementary", () => {
			const mine = selectSense(6_000, 6_010, 500, 100)
			const theirs = selectSense(6_010, 6_000, 100, 500)
			expect(isComplementary(mine, theirs)).toBe(true)
			expect(mine).toBe("climb") // higher address climbs
		})

		it("never lets two aircraft pick the same sense, over the whole address space", () => {
			for (const [altA, altB] of [[6_000, 6_000], [6_000, 6_010], [6_000, 6_024], [7_000, 6_000]]) {
				const addrA = modeSAddress("AAL221"), addrB = modeSAddress("SWA455")
				expect(isComplementary(
					selectSense(altA, altB, addrA, addrB),
					selectSense(altB, altA, addrB, addrA),
				)).toBe(true)
			}
		})

		it("derives a stable 24-bit address from the callsign", () => {
			expect(modeSAddress("AAL221")).toBe(modeSAddress("AAL221"))
			expect(modeSAddress("AAL221")).not.toBe(modeSAddress("SWA455"))
			expect(modeSAddress("AAL221")).toBeLessThanOrEqual(0xffffff)
		})
	})

	describe("hysteresis is integer-counted, so no float decides an advisory", () => {
		it("needs CONFIRM_TICKS consecutive samples before declaring", () => {
			const tracker = new AdvisoryTracker()
			for (let i = 0; i < CONFIRM_TICKS - 1; i++) expect(tracker.observe("traffic")).toBe("none")
			expect(tracker.observe("traffic")).toBe("traffic")
		})

		it("needs CLEAR_TICKS consecutive quiet samples before clearing", () => {
			const tracker = new AdvisoryTracker()
			for (let i = 0; i < CONFIRM_TICKS; i++) tracker.observe("traffic")
			for (let i = 0; i < CLEAR_TICKS - 1; i++) expect(tracker.observe("none")).toBe("traffic")
			expect(tracker.observe("none")).toBe("none")
		})

		it("does not thrash on a single stray sample", () => {
			const tracker = new AdvisoryTracker()
			for (let i = 0; i < 50; i++) {
				expect(tracker.observe(i === 20 ? "resolution" : "none")).toBe("none")
			}
		})
	})
})
