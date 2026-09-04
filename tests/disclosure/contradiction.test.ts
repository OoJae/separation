import { describe, expect, it } from "@rstest/core"
import { BurnIntegral, burnForMs, BURN_MG_PER_SEC } from "../../src/domain/disclosure/burn-model"
import { ClaimLedger } from "../../src/domain/disclosure/claim-ledger"
import {
	boundedWorstCaseMg, GAUGE_QUANTUM_MG, RELATIVE_MAX, testAnchored, testDifferential,
} from "../../src/domain/disclosure/contradiction"

const KG = 1_000_000 // milligrams per kilogram

describe("burn model", () => {
	it("is exact integer arithmetic, with no accumulation drift", () => {
		const integral = new BurnIntegral()
		for (let i = 0; i < 20_000; i++) integral.accumulate("cruise", 20)
		// 20000 ticks x 20 ms = 400 s of cruise
		expect(integral.totalMilligrams()).toBe(BURN_MG_PER_SEC.cruise * 400)
		expect(Number.isInteger(integral.totalMilligrams())).toBe(true)
	})

	it("stays well inside exact-integer range for a full run", () => {
		const worst = BURN_MG_PER_SEC.turning * 400_000
		expect(worst).toBeLessThan(Number.MAX_SAFE_INTEGER)
	})

	it("charges a descent less than a turn, so the axes really differ", () => {
		expect(burnForMs("descent", 60_000)).toBeLessThan(burnForMs("turning", 60_000))
	})
})

describe("contradiction detection", () => {
	/**
	 * The threshold is the bounded worst case, stated as such. The design this replaced called it
	 * "3 sigma", which was an algebraic identity dressed as statistics: with its own error model,
	 * k = sqrt(6 + RMAX^2/RSD^2) is exactly 3 whenever RSD = RMAX/sqrt(3). No distribution was
	 * ever involved, so no probability is claimed here.
	 */
	it("carries no probability field, because we are not entitled to one", () => {
		const verdict = testDifferential({ firstClaimMg: 5_000 * KG, secondClaimMg: 4_000 * KG, burnBetweenMg: 1_000 * KG })
		expect(Object.keys(verdict)).not.toContain("probability")
		expect(Object.keys(verdict)).not.toContain("sigma")
		expect(verdict.interpretation).toBe("margin-above-bounded-error-model")
	})

	it("bounds error as two gauge quanta plus the model's relative error", () => {
		expect(boundedWorstCaseMg(0)).toBe(2 * GAUGE_QUANTUM_MG)
		expect(boundedWorstCaseMg(1_000 * KG)).toBe(2 * GAUGE_QUANTUM_MG + 1_000 * KG * RELATIVE_MAX)
	})

	describe("the differential test", () => {
		/**
		 * THE KEY PROPERTY. The pilot's unknown true fuel appears in both claims and CANCELS, so
		 * this is sound with no exogenous truth at all — which matters, because ATC genuinely
		 * cannot see fuel.
		 */
		it("is sound without ever knowing the true fuel — the anchor cancels", () => {
			const burn = 1_000 * KG
			// Two pilots with wildly different true fuel, both reporting CONSISTENTLY.
			const honestA = testDifferential({ firstClaimMg: 9_000 * KG, secondClaimMg: 8_000 * KG, burnBetweenMg: burn })
			const honestB = testDifferential({ firstClaimMg: 2_000 * KG, secondClaimMg: 1_000 * KG, burnBetweenMg: burn })
			expect(honestA.contradicted).toBe(false)
			expect(honestB.contradicted).toBe(false)
			expect(honestA.observedDiscrepancyMg).toBe(honestB.observedDiscrepancyMg)
		})

		it("catches a pilot who cannot keep the shaded story straight", () => {
			// Claims 2100 kg, burns 400 kg, then claims 2100 kg again — 400 kg unaccounted for.
			const verdict = testDifferential({
				firstClaimMg: 2_100 * KG, secondClaimMg: 2_100 * KG, burnBetweenMg: 400 * KG,
			})
			expect(verdict.contradicted).toBe(true)
			expect(verdict.marginMg).toBeGreaterThan(0)
			expect(verdict.marginRatioE3).toBeGreaterThan(0)
		})

		it("tolerates honest gauge noise inside the bound", () => {
			// 150 kg off after a 400 kg burn — inside two 100 kg quanta plus 12%.
			const verdict = testDifferential({
				firstClaimMg: 2_100 * KG, secondClaimMg: 1_550 * KG, burnBetweenMg: 400 * KG,
			})
			expect(verdict.contradicted).toBe(false)
		})

		/**
		 * Stated as a limitation rather than hidden: a pilot who shades ONCE and then reports
		 * consistently is invisible to this test. It catches inconsistency, not dishonesty.
		 */
		it("cannot see a single consistent lie — and does not pretend to", () => {
			const verdict = testDifferential({
				firstClaimMg: 1_400 * KG, secondClaimMg: 1_000 * KG, burnBetweenMg: 400 * KG,
			})
			expect(verdict.contradicted).toBe(false)
		})

		it("does not claim to distinguish a leak from a lie", () => {
			const verdict = testDifferential({
				firstClaimMg: 2_100 * KG, secondClaimMg: 2_100 * KG, burnBetweenMg: 900 * KG,
			})
			expect(verdict.contradicted).toBe(true)
			expect(verdict.cause).toBe("unexplained")
		})
	})

	describe("the anchored test", () => {
		it("works against a filed figure, and is strictly weaker", () => {
			const anchored = testAnchored({ filedFuelMg: 5_000 * KG, burnSinceFiledMg: 1_000 * KG, claimedNowMg: 2_000 * KG })
			expect(anchored.contradicted).toBe(true)
			// It inherits the filed figure's error, so its bound is only as good as that number.
			expect(anchored.boundMg).toBe(boundedWorstCaseMg(1_000 * KG))
		})
	})
})

describe("claim ledger", () => {
	it("returns no verdict on a first claim — there is nothing to compare against", () => {
		const ledger = new ClaimLedger()
		expect(ledger.record({ callsign: "UAL231", claimedMg: 2_100 * KG, atSimSec: 0, burnIntegralMg: 0 })).toBeNull()
	})

	it("compares each claim against that pilot's previous one", () => {
		const ledger = new ClaimLedger()
		ledger.record({ callsign: "UAL231", claimedMg: 2_100 * KG, atSimSec: 0, burnIntegralMg: 0 })
		const verdict = ledger.record({
			callsign: "UAL231", claimedMg: 2_100 * KG, atSimSec: 400, burnIntegralMg: 500 * KG,
		})
		expect(verdict).not.toBeNull()
		expect(verdict!.contradicted).toBe(true)
	})

	it("keeps pilots independent of one another", () => {
		const ledger = new ClaimLedger()
		ledger.record({ callsign: "UAL231", claimedMg: 2_100 * KG, atSimSec: 0, burnIntegralMg: 0 })
		expect(ledger.record({ callsign: "AAL77", claimedMg: 900 * KG, atSimSec: 1, burnIntegralMg: 0 })).toBeNull()
		expect(ledger.claimsFor("UAL231")).toHaveLength(1)
		expect(ledger.size()).toBe(2)
	})

	it("is append-only and deterministic", () => {
		const build = () => {
			const ledger = new ClaimLedger()
			for (let i = 0; i < 5; i++) {
				ledger.record({ callsign: "UAL231", claimedMg: (2_100 - i * 100) * KG, atSimSec: i * 100, burnIntegralMg: i * 100 * KG })
			}
			return ledger.claimsFor("UAL231")
		}
		expect(build()).toEqual(build())
		expect(build()).toHaveLength(5)
	})
})
