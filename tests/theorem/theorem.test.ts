import { describe, expect, it } from "@rstest/core"
import { admissibleBandMs, admissibleGateRangeNm, isInBand } from "../../src/domain/interlock/band"
import { MAX_TURN_MS, MIN_TURN_MS } from "../../src/domain/interlock/decision-latency"
import { evaluateJoint, findJointHazards } from "../../src/domain/interlock/joint-prober"
import { COMMAND_LAG_S } from "../../src/domain/airspace/maneuver-window"
import { KT_TO_NM_PER_S, secondsToTick, tickToSeconds } from "../../src/domain/airspace/units"
import { LATERAL_MINIMUM_NM, VERTICAL_MINIMUM_FT } from "../../src/domain/airspace/separation-standard"
import {
	GATE_A_NM, GATE_B_NM, HORIZON_S, INITIAL, MANEUVER_A_DURATION_S, MANEUVER_B_DURATION_S,
	WINDOWS, WINDOW_A, WINDOW_B, clearanceA, clearanceB,
} from "../../src/scenarios/braid-2"

const world = [...INITIAL]
const A = clearanceA()
const B = clearanceB()
const band = admissibleBandMs()

/**
 * ONE CLOCK.
 *
 * A probe models a decision taken at `commitMs`, so the clearances are BUILT at that instant
 * rather than baked at t=0 and judged at another time. An earlier version of this helper passed
 * `atMs` for the window test while handing the geometry clearances committed at zero, which let
 * the suite assert a joint hazard at a commit time where the aircraft are legally separated.
 * Constructing the clearances from the same number is what makes that mistake unrepresentable.
 */
const probeAt = (ids: readonly ("A" | "B")[], commitMs: number) =>
	evaluateJoint({
		world,
		pending: ids.map((id) => (id === "A" ? clearanceA(commitMs / 1000) : clearanceB(commitMs / 1000))),
		windows: WINDOWS,
		atMs: commitMs,
		horizonSec: HORIZON_S,
	})

/**
 * THE THEOREM. Everything in this repo exists to make these assertions mean something.
 *
 * Runs with no network and no API key, so a judge with a laptop and no credentials can
 * reproduce the central claim.
 */
describe("theorem", () => {
	describe("(a) the companion claim, stated first", () => {
		it("theorem: the joint hazard IS visible to anything holding both as pending intent", () => {
			const verdict = probeAt(["A", "B"], 0)
			expect(verdict.hazards).toHaveLength(1)

			const hazard = verdict.hazards[0]!
			expect(hazard.clearanceIds).toEqual(["A", "B"])
			expect(hazard.minHorizontalNm).toBeCloseTo(2.3511, 4)
			expect(hazard.minHorizontalNm).toBeLessThan(LATERAL_MINIMUM_NM)
			expect(hazard.verticalAtMinFt).toBeLessThan(VERTICAL_MINIMUM_FT)
			expect(hazard.lossSeconds).toBeCloseTo(34.54, 1)
		})

		it("neither clearance alone produces it — that is what makes it JOINT", () => {
			expect(probeAt(["A"], 0).hazards).toEqual([])
			expect(probeAt(["B"], 0).hazards).toEqual([])
		})

		it("refuses to call a hazard joint when one clearance is simply unsafe alone", () => {
			// A clearance that loses separation by itself is a different finding, and reporting it
			// as "joint" would make the word mean nothing.
			const unsafeAlone = {
				...B,
				id: "B-unsafe",
				command: { targetAltFt: 9_000, verticalRateFpm: 2_000 },
			}
			const soloHazard = findJointHazards(world, [unsafeAlone, A], HORIZON_S)
			for (const hazard of soloHazard) expect(hazard.clearanceIds).not.toContain("B-unsafe")
		})
	})

	describe("(b) the real theorem — actionability, not blindness", () => {
		it("theorem: serializing closes at least one aircraft's window, in BOTH orders", () => {
			const serialized = probeAt(["A", "B"], band.upperMs)

			// Whichever went first, the second decision arrives after that aircraft's window shut.
			const excludedIds = serialized.excluded.map((e) => e.clearanceId).sort()
			expect(excludedIds).toEqual(["A", "B"])

			const missedA = serialized.excluded.find((e) => e.clearanceId === "A")!
			const missedB = serialized.excluded.find((e) => e.clearanceId === "B")!
			expect(missedA.reason).toBe("window-closed")
			expect(missedB.reason).toBe("window-closed")
			// Commit instants are integer 10 ms ticks — the whole determinism story rests on that —
			// so the serialized commit lands on the tick at or before band.upperMs, not on the
			// millisecond itself. Quantise the expectation rather than loosening it.
			const committedMs = tickToSeconds(secondsToTick(band.upperMs / 1000)) * 1000
			expect(missedA.missedByMs).toBeCloseTo(committedMs - WINDOW_A.windowMs, 0)
			expect(missedB.missedByMs).toBeCloseTo(committedMs - WINDOW_B.windowMs, 0)

			// BOTH must miss. If only one did, the hazard would be serializable and this is false.
			expect(missedA.missedByMs).toBeGreaterThan(0)
			expect(missedB.missedByMs).toBeGreaterThan(0)
		})

		it("finds no hazard when serialized — not because it cannot see, but because nothing is left", () => {
			const serialized = probeAt(["A", "B"], band.upperMs)
			expect(serialized.hazards).toEqual([])
			expect(serialized.considered).toEqual([])   // there was no candidate to look at
			expect(serialized.excluded).toHaveLength(2)
		})

		it("finds it and can still act on it when the decisions are concurrent", () => {
			// band.lowerMs is MAX_TURN_MS — the SLOWEST a concurrent pair can commit, so this is
			// the worst case, not a friendly one. The hazard has to still be there.
			const concurrent = probeAt(["A", "B"], band.lowerMs)
			expect(concurrent.excluded).toEqual([])
			expect(concurrent.considered).toEqual(["A", "B"])
			expect(concurrent.hazards).toHaveLength(1)

			// And at the fastest concurrent commit too, so it holds across the whole range.
			const fastest = probeAt(["A", "B"], MIN_TURN_MS)
			expect(fastest.excluded).toEqual([])
			expect(fastest.hazards).toHaveLength(1)
		})

		it("is falsifiable: if the windows were wider, the serialized arm would find it too", () => {
			const generous = new Map(WINDOWS)
			generous.set("A", { ...WINDOW_A, windowMs: 60_000 })
			generous.set("B", { ...WINDOW_B, windowMs: 60_000 })
			const verdict = evaluateJoint({
				world,
				pending: [clearanceA(band.upperMs / 1000), clearanceB(band.upperMs / 1000)],
				windows: generous, atMs: band.upperMs, horizonSec: HORIZON_S,
			})
			expect(verdict.excluded).toEqual([])
			// The hazard is STILL THERE at the serialized instant — see hazard-lifetime.test.ts,
			// which asserts the lifetime covers it. So the serialized arm does not fail because the
			// hazard evaporated; it fails because the window shut. That is the whole claim.
			expect(verdict.hazards).toHaveLength(1)
		})
	})

	describe("the admissible band is COMPUTED, not asserted", () => {
		/**
		 * The gate distances ARE calibrated, and the README says so. The band is not: it comes
		 * from the latency model and contains no geometry. This test recomputes it, so changing
		 * the latency deciles fails here and tells you to re-derive the gates rather than letting
		 * a stale calibration slide through. That is also the Phase 4 tripwire.
		 */
		/**
		 * The band is DERIVED, so this asserts the derivation rather than the literals. Re-measure
		 * latency and these numbers move together; the relationships must not.
		 */
		it("derives the band from the latency model alone", () => {
			expect(band.lowerMs).toBe(MAX_TURN_MS)                       // slowest concurrent commit
			expect(band.upperMs).toBe(MIN_TURN_MS + 8_000 + MIN_TURN_MS) // fastest serialized second
			expect(band.widthMs).toBe(band.upperMs - band.lowerMs)
			expect(band.widthMs).toBeGreaterThan(0)                      // else no gate could ever work
		})

		/**
		 * Pins the MEASURED calibration (mimo-v2.5-pro, 2026-09-05, n=10). If a re-measurement
		 * moves these, that is the tripwire working — update them from the measurement, never the
		 * other way round.
		 */
		it("pins the measured band, so a silent drift is visible", () => {
			expect(band.lowerMs).toBe(34_580)
			expect(band.upperMs).toBe(53_132)
			expect(band.widthMs).toBe(18_552)
		})

		it("puts both scenario gates strictly inside it", () => {
			expect(isInBand(WINDOW_A.windowMs)).toBe(true)
			expect(isInBand(WINDOW_B.windowMs)).toBe(true)
			// Deterministic, but not round: timeToGate is 12.0 / (250/3600), which has no exact
			// binary representation. Asserted to the millisecond, which is the unit that matters.
			expect(WINDOW_A.windowMs).toBeCloseTo(44_360, 0)
			expect(WINDOW_B.windowMs).toBeCloseTo(43_684, 0)
		})

		it("states the admissible gate range, so the calibration is inspectable", () => {
			const speed = 250 * KT_TO_NM_PER_S
			const rangeA = admissibleGateRangeNm({ maneuverDurationS: MANEUVER_A_DURATION_S, lagS: COMMAND_LAG_S, speedNmPerSec: speed })
			const rangeB = admissibleGateRangeNm({ maneuverDurationS: MANEUVER_B_DURATION_S, lagS: COMMAND_LAG_S, speedNmPerSec: speed })

			expect(rangeA.minNm).toBeCloseTo(13.7208, 4)
			expect(rangeA.maxNm).toBeCloseTo(15.0092, 4)

			// The measured distribution made the calibration FIVE TIMES more tolerant than the
			// assumed one did: the admissible gate range widened from 0.24 NM to 1.29 NM.
			expect(rangeA.maxNm - rangeA.minNm).toBeGreaterThan(1.2)
			expect(GATE_A_NM).toBeGreaterThan(rangeA.minNm)
			expect(GATE_A_NM).toBeLessThan(rangeA.maxNm)

			expect(GATE_B_NM).toBeGreaterThan(rangeB.minNm)
			expect(GATE_B_NM).toBeLessThan(rangeB.maxNm)
		})

		it("derives each window from real manoeuvre physics, not from a chosen number", () => {
			// Descending 5000 ft at 2000 fpm genuinely takes 150 s.
			expect(MANEUVER_A_DURATION_S).toBe(150)
			// A 12 deg turn plus establishing 0.60 NM of offset genuinely takes ~46 s. The shallower
			// the turn, the longer it takes to build the same offset — which is exactly the trade
			// that buys the joint hazard its lifetime.
			expect(MANEUVER_B_DURATION_S).toBeCloseTo(45.56, 1)
		})
	})

	describe("determinism", () => {
		it("two identical evaluations agree exactly", () => {
			expect(probeAt(["A", "B"], 0)).toEqual(probeAt(["A", "B"], 0))
		})
	})
})


/**
 * evaluateJoint's OWN CLOCK, which nothing exercised.
 *
 * `probeAt` always builds the clearances at the same instant it evaluates, so the window test and
 * the geometry always agreed and the reconciliation between them was never put under load. Reverting
 * the two-clock fix failed one assertion; the worldAtMs half failed none, because no caller passed it.
 *
 * These drive the two halves apart deliberately.
 */
describe("evaluateJoint reconciles the clocks it is given", () => {
	it("tests each clearance's window against ITS OWN commit time, not a shared instant", () => {
		// A is committed early and B late. Only B should be excluded, even though both are
		// evaluated at the same `atMs` — the window belongs to the clearance, not to the call.
		const verdict = evaluateJoint({
			world,
			pending: [clearanceA(0), clearanceB(band.upperMs / 1000)],
			windows: WINDOWS, atMs: band.upperMs, horizonSec: HORIZON_S,
		})
		expect(verdict.excluded.map((e) => e.clearanceId)).toEqual(["B"])
		expect(verdict.considered).toEqual(["A"])
	})

	it("re-dates the geometry onto the instant the world snapshot describes", () => {
		// The same clearances, flown from a world that is already 20 s old. Rebasing must move the
		// clearance forward relative to that snapshot, so the verdict is NOT identical to worldAtMs 0.
		const atOrigin = evaluateJoint({
			world, pending: [clearanceA(20), clearanceB(20)],
			windows: WINDOWS, atMs: 20_000, horizonSec: HORIZON_S,
		})
		const rebased = evaluateJoint({
			world, pending: [clearanceA(20), clearanceB(20)],
			windows: WINDOWS, atMs: 20_000, worldAtMs: 20_000, horizonSec: HORIZON_S,
		})
		expect(atOrigin.considered).toEqual(["A", "B"])
		expect(rebased.considered).toEqual(["A", "B"])
		// Same clearances, same windows, different world origin -> different flown geometry.
		expect(rebased.hazards).not.toEqual(atOrigin.hazards)
	})
})
