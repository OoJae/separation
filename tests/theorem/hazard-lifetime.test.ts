import { describe, expect, it } from "@rstest/core"
import { admissibleBandMs, CONCURRENT_MAX_MS, SERIALIZED_MIN_MS } from "../../src/domain/interlock/band"
import { MAX_TURN_MS, MIN_TURN_MS } from "../../src/domain/interlock/decision-latency"
import { findJointHazards } from "../../src/domain/interlock/joint-prober"
import { HORIZON_S, INITIAL, clearanceA, clearanceB } from "../../src/scenarios/braid-2"

const world = [...INITIAL]

/** Is the joint hazard present if BOTH controllers commit at this instant? */
const hazardousAt = (commitMs: number): boolean =>
	findJointHazards(world, [clearanceA(commitMs / 1000), clearanceB(commitMs / 1000)], HORIZON_S).length === 1

/**
 * The last instant, to 100 ms, at which committing both clearances still produces a joint hazard.
 * MEASURED by bisection over the shipped integrator — not a constant anyone can edit to taste.
 */
function hazardLifetimeMs(): number {
	if (!hazardousAt(0)) return -1
	let lo = 0, hi = 120_000
	while (hi - lo > 100) {
		const mid = Math.floor((lo + hi) / 2)
		if (hazardousAt(mid)) lo = mid
		else hi = mid
	}
	return lo
}

/**
 * THE TRIPWIRE THIS REPO DID NOT HAVE, AND THE REASON THE THEOREM WAS BRIEFLY FALSE.
 *
 * A joint hazard is not a static property of a scenario — it has a LIFETIME. BRAID-2's hazard
 * exists because SWA455's turn steals lateral separation while AAL221's descent steals the
 * vertical. Commit both later and the turn has less distance left to run, so the aircraft pass
 * further apart, and at some point they pass legally. Past that instant there is nothing for the
 * interlock to catch.
 *
 * That instant has to sit beyond the SLOWEST concurrent commit the latency model admits, or the
 * theorem is a coin flip: the architecture would catch the hazard when both controllers happen to
 * think quickly and miss it when they do not.
 *
 * It did not. Phase 3 calibrated the geometry against an ASSUMED controller turn of 2.2-9.0 s.
 * Phase 4 measured the real thing at 22.6-34.6 s and correctly re-derived the gates and the band —
 * but not the encounter. The hazard's lifetime stayed at 27.5 s while the commit range moved out
 * to 34.58 s, so `theorem.test.ts` was asserting a hazard at an instant where the aircraft were
 * 3.1259 NM apart and legally separated. Nothing in the suite computed this number, so nothing
 * failed.
 *
 * This test computes it. Re-measure latency, shallow the turn, move a gate, nudge a start
 * position — any of those changes this number, and if it stops covering the decision range this
 * fails and says so, instead of letting a stale calibration certify a theorem it no longer backs.
 */
describe("the joint hazard outlives every decision the architecture can make", () => {
	it("is alive at the fastest AND the slowest concurrent commit", () => {
		expect(hazardousAt(MIN_TURN_MS)).toBe(true)
		expect(hazardousAt(MAX_TURN_MS)).toBe(true)
	})

	it("has a lifetime that strictly contains the whole concurrent commit range", () => {
		const lifetimeMs = hazardLifetimeMs()

		// The requirement. band.lowerMs IS MAX_TURN_MS — the slowest a concurrent pair can commit.
		expect(lifetimeMs).toBeGreaterThan(CONCURRENT_MAX_MS)
		expect(admissibleBandMs().lowerMs).toBe(CONCURRENT_MAX_MS)

		// And with real margin, not by a hair. A calibration that only just clears the requirement
		// is the same fragility that produced the defect in the first place.
		expect(lifetimeMs - CONCURRENT_MAX_MS).toBeGreaterThan(10_000)
	})

	/**
	 * theorem.test.ts's falsifiability case widens the windows and asserts the serialized arm
	 * WOULD then find the hazard — which is only meaningful if the hazard still exists that late.
	 * That dependency is asserted here rather than left implicit, so if the lifetime ever drops
	 * below the serialized instant, this fails with the reason rather than that test failing with
	 * a bare count mismatch.
	 */
	it("is still alive at the serialized instant, so the serialized arm fails on the WINDOW alone", () => {
		expect(hazardousAt(SERIALIZED_MIN_MS)).toBe(true)

		/**
		 * THE THIN ONE, PINNED RATHER THAN HIDDEN.
		 *
		 * The 10-second margin asserted above is over the CONCURRENT bound, which the calibration
		 * clears by ~19 s. The serialized bound is the tight one — the hazard outlives it by well
		 * under a second — and asserting only the comfortable margin while the load-bearing one is
		 * 20x thinner is the kind of reassurance that reads as diligence and is not.
		 *
		 * This margin does not need to be large. It only needs to exist, and to be visible when it
		 * stops existing: below it, theorem.test.ts's falsifiability case silently changes meaning.
		 */
		const margin = hazardLifetimeMs() - SERIALIZED_MIN_MS
		expect(margin).toBeGreaterThan(0)
		expect(margin).toBeLessThan(2_000) // it IS thin; a change that widens it is worth noticing
	})

	it("does eventually expire — the lifetime is real, not an artefact of the search bound", () => {
		const lifetimeMs = hazardLifetimeMs()
		expect(lifetimeMs).toBeLessThan(120_000)
		expect(hazardousAt(lifetimeMs + 1_000)).toBe(false)
	})
})
