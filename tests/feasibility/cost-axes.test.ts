import { describe, expect, it } from "@rstest/core"
import { integrate, type AircraftState } from "../../src/domain/airspace/aircraft-state"
import {
	EXPEDITE_TURN_RATE_MDEG_PER_S, INTEGRATE_DT_S, TURN_RATE_MDEG_PER_S,
	degreesToMdeg, isAdmissibleTurnRate,
} from "../../src/domain/airspace/units"
import { areIncomparable, dominates } from "../../src/domain/feasibility/cost"
import {
	MANEUVER_TEMPLATE_COUNT, SPEED_TARGETS_KT, maneuverCatalogue,
} from "../../src/domain/feasibility/maneuver"
import { loadFactorFor, probe } from "../../src/domain/feasibility/prober"
import { HORIZON_S, INITIAL } from "../../src/scenarios/braid-2"
import { MEDICAL_AIRCRAFT } from "../../src/scenarios/pilot-sheets"

const world = [...INITIAL, MEDICAL_AIRCRAFT]
const optionsFor = (callsign: string) =>
	probe({ subject: callsign, world, forGeneration: 1, horizonSec: HORIZON_S, nowSec: 0 }).options
const costOf = (callsign: string, template: string) =>
	optionsFor(callsign).find((o) => o.maneuver.template === template)!.cost

/**
 * THE COST AXES ARE GENUINELY INDEPENDENT — which they were not.
 *
 * `cost.ts` has always advertised "four genuinely incommensurable axes". Three of the four were
 * not: `arrivalDelaySec` was an exact rescaling of `deltaTrackMilesNm`, `peakLoadFactor` was the
 * hardcoded constant 1.06 for every turn regardless of angle or speed, and the speed-reduction
 * option used to justify fuel as a separate axis did not exist — `Command` had no speed field.
 * All six turns were therefore totally ordered and a solver could have taken an argmax.
 *
 * These tests pin the repair. They are the reason "geometry cannot choose between them" is now a
 * property of the code rather than a sentence in a README.
 */
describe("the cost axes are independent, not decorative", () => {
	it("peak load factor varies with turn RATE, so it carries information", () => {
		const standard = costOf("AAL77", "turn-right-20").peakLoadFactor
		const expedite = costOf("AAL77", "turn-right-20-expedite").peakLoadFactor
		expect(expedite).toBeGreaterThan(standard)
		expect(standard).toBeGreaterThan(1)
	})

	it("and with SPEED — the same rate at a lower speed needs less bank", () => {
		expect(loadFactorFor(180, TURN_RATE_MDEG_PER_S))
			.toBeLessThan(loadFactorFor(250, TURN_RATE_MDEG_PER_S))
	})

	it("computes load factor from bank geometry, matching 1/cos(phi)", () => {
		// tan(phi) = v*omega/g; at 250 kt and 3 deg/s that is a ~34.5 deg bank, so ~1.21 g.
		expect(loadFactorFor(250, TURN_RATE_MDEG_PER_S)).toBeCloseTo(1.2131, 3)
		expect(loadFactorFor(250, EXPEDITE_TURN_RATE_MDEG_PER_S)).toBeCloseTo(1.6989, 3)
		expect(loadFactorFor(250, 0)).toBe(1) // wings level is exactly 1 g
	})

	it("a speed reduction adds NO track miles, arrives LATER, and burns LESS", () => {
		const slow = costOf("AAL77", `slow-to-${SPEED_TARGETS_KT[0]}`)
		expect(slow.deltaTrackMilesNm).toBe(0)
		expect(slow.arrivalDelaySec).toBeGreaterThan(0)
		expect(slow.fuelBurnMg).toBeLessThan(0) // a saving
		expect(slow.peakLoadFactor).toBe(1)
	})

	it("which no turn and no descent can produce — that is why fuel is its own axis", () => {
		const slow = costOf("AAL77", "slow-to-210")
		const descend = costOf("AAL77", "descend-4000")
		const turn = costOf("AAL77", "turn-right-20")
		// The descent arrives sooner but burns more; the speed reduction the other way round.
		expect(areIncomparable(slow, descend)).toBe(true)
		expect(areIncomparable(slow, turn)).toBe(true)
	})

	it("the six turns are no longer a totally ordered chain", () => {
		const turns = optionsFor("AAL77").filter((o) => o.maneuver.axis === "lateral")
		let incomparable = 0
		for (let i = 0; i < turns.length; i++) {
			for (let j = i + 1; j < turns.length; j++) {
				if (areIncomparable(turns[i]!.cost, turns[j]!.cost)) incomparable++
			}
		}
		expect(incomparable).toBeGreaterThan(0)
	})

	/**
	 * Stated rather than hidden. Cost never sees traffic, so a left and a right turn of the same
	 * magnitude and rate cost exactly the same. What separates them is `margins` — geometry, which
	 * is deliberately a filter and not a cost.
	 */
	it("a left and right turn of equal magnitude tie on cost and differ only in margin", () => {
		expect(costOf("AAL77", "turn-left-20")).toEqual(costOf("AAL77", "turn-right-20"))
		const left = optionsFor("AAL77").find((o) => o.maneuver.template === "turn-left-20")!
		const right = optionsFor("AAL77").find((o) => o.maneuver.template === "turn-right-20")!
		expect(left.margins.minHorizontalNm).not.toBeCloseTo(right.margins.minHorizontalNm, 2)
	})

	it("no option dominates the whole catalogue — there is always a real choice", () => {
		const options = optionsFor("AAL77")
		const frontier = options.filter((o) => !options.some((p) => dominates(p.cost, o.cost)))
		expect(frontier.length).toBeGreaterThan(1)
		expect(MANEUVER_TEMPLATE_COUNT).toBe(18)
		expect(maneuverCatalogue(degreesToMdeg(120))).toHaveLength(18)
	})
})

/**
 * The integrator gained two fields. Its exactness is the spine of every determinism claim in the
 * repo, so the admissibility rule is asserted rather than trusted.
 */
describe("the new command fields keep the integrator exact", () => {
	it("every turn rate the catalogue can produce divides the step exactly", () => {
		for (const rate of [TURN_RATE_MDEG_PER_S, EXPEDITE_TURN_RATE_MDEG_PER_S]) {
			expect(isAdmissibleTurnRate(rate)).toBe(true)
			expect(Number.isInteger(rate * INTEGRATE_DT_S)).toBe(true)
		}
		expect(isAdmissibleTurnRate(2_222)).toBe(false) // 44.44 mdeg per step — would leave residue
	})

	it("an expedited turn lands exactly on its target heading, with no residue", () => {
		let state: AircraftState = { ...MEDICAL_AIRCRAFT, headingMdeg: degreesToMdeg(0) }
		const command = {
			targetHeadingMdeg: degreesToMdeg(30),
			turnRateMdegPerS: EXPEDITE_TURN_RATE_MDEG_PER_S,
		}
		for (let i = 0; i < 1_000; i++) state = integrate(state, command)
		expect(state.headingMdeg).toBe(degreesToMdeg(30)) // exact integer, not 30000.0000001
	})

	it("speed is ASSIGNED, never accumulated, so it cannot drift", () => {
		let state: AircraftState = { ...MEDICAL_AIRCRAFT }
		const command = { targetGroundspeedKt: 180 }
		for (let i = 0; i < 10_000; i++) state = integrate(state, command)
		expect(state.groundspeedKt).toBe(180)
	})

	it("BRAID-2 commands set neither field, so the theorem's geometry is untouched", () => {
		let state: AircraftState = { ...MEDICAL_AIRCRAFT }
		const before = integrate(state, { targetHeadingMdeg: degreesToMdeg(130) })
		state = { ...MEDICAL_AIRCRAFT }
		const after = integrate(state, {
			targetHeadingMdeg: degreesToMdeg(130), turnRateMdegPerS: TURN_RATE_MDEG_PER_S,
		})
		expect(after).toEqual(before) // omitting the rate is identical to naming the default
	})
})
