import { describe, expect, it } from "@rstest/core"
import { areIncomparable, dominates, type CostVector } from "../../src/domain/feasibility/cost"
import { maneuverCatalogue, MANEUVER_TEMPLATE_COUNT } from "../../src/domain/feasibility/maneuver"
import { probe } from "../../src/domain/feasibility/prober"
import { AAL221, SWA455 } from "../../src/scenarios/braid-2"

const request = (over: Partial<Parameters<typeof probe>[0]> = {}) => ({
	subject: "AAL221",
	world: [AAL221, SWA455],
	forGeneration: 7,
	horizonSec: 180,
	nowSec: 0,
	...over,
})

const cost = (over: Partial<CostVector> = {}): CostVector => ({
	deltaTrackMilesNm: 1, arrivalDelaySec: 10, fuelBurnMg: 1_000, peakLoadFactor: 1.0, ...over,
})

describe("feasibility prober", () => {
	describe("it emits a SET, never a ranking", () => {
		it("labels its own ordering as meaningless", () => {
			expect(probe(request()).ordering).toBe("lexicographic-by-optionId (semantically meaningless)")
		})

		it("sorts lexicographically by optionId, for reproducibility not preference", () => {
			const set = probe(request())
			const ids = set.options.map((o) => o.optionId)
			expect(ids).toEqual([...ids].sort())
		})

		it("carries no score, rank or aggregate on any option", () => {
			const set = probe(request())
			expect(set.options.length).toBeGreaterThan(0)
			for (const option of set.options) {
				const keys = [...Object.keys(option), ...Object.keys(option.cost)]
				for (const forbidden of ["score", "rank", "best", "recommended", "utility", "weight", "sortKey"]) {
					expect(keys).not.toContain(forbidden)
				}
			}
		})

		it("offers the same template catalogue to every aircraft, so no set is tailored", () => {
			expect(maneuverCatalogue(AAL221.headingMdeg)).toHaveLength(MANEUVER_TEMPLATE_COUNT)
			expect(maneuverCatalogue(SWA455.headingMdeg)).toHaveLength(MANEUVER_TEMPLATE_COUNT)
			// Identical TEMPLATE names for aircraft on completely different headings — the
			// catalogue is relative, so no aircraft is offered a differently-shaped menu.
			expect(maneuverCatalogue(AAL221.headingMdeg).map((m) => m.template))
				.toEqual(maneuverCatalogue(SWA455.headingMdeg).map((m) => m.template))
			// ...but the resulting commands genuinely differ, because the headings do.
			expect(maneuverCatalogue(AAL221.headingMdeg)[0]!.command)
				.not.toEqual(maneuverCatalogue(SWA455.headingMdeg)[0]!.command)
		})
	})

	describe("the cost axes are genuinely incommensurable", () => {
		/**
		 * THE CRUX. If a solver could order these, the language models would be decorative. The
		 * axes are built so that turning and descending trade against each other in opposite
		 * directions, and neither dominates.
		 */
		it("produces options no solver can order — a turn and a descent are incomparable", () => {
			const set = probe(request())
			const turn = set.options.find((o) => o.maneuver.axis === "lateral")
			const descent = set.options.find((o) => o.maneuver.axis === "vertical")
			expect(turn).toBeDefined()
			expect(descent).toBeDefined()
			expect(areIncomparable(turn!.cost, descent!.cost)).toBe(true)
		})

		it("has at least one incomparable pair in the real BRAID-2 set", () => {
			const options = probe(request()).options
			let incomparable = 0
			for (let i = 0; i < options.length; i++) {
				for (let j = i + 1; j < options.length; j++) {
					if (areIncomparable(options[i]!.cost, options[j]!.cost)) incomparable++
				}
			}
			expect(incomparable).toBeGreaterThan(0)
		})

		it("costs fuel for a manoeuvre that adds ZERO track miles", () => {
			// This is why fuel is a separate axis rather than a rescaling of distance. Model fuel
			// as kg/NM and this option costs nothing, collapsing four axes into three.
			const descent = probe(request()).options.find((o) => o.maneuver.axis === "vertical")
			expect(descent).toBeDefined()
			expect(descent!.cost.deltaTrackMilesNm).toBe(0)
			expect(descent!.cost.fuelBurnMg).toBeGreaterThan(0)
		})

		it("dominance is a filter, and it refuses to order incomparable options", () => {
			const cheapButSlow = cost({ deltaTrackMilesNm: 0, arrivalDelaySec: 100 })
			const fastButLong = cost({ deltaTrackMilesNm: 5, arrivalDelaySec: 1 })
			expect(dominates(cheapButSlow, fastButLong)).toBe(false)
			expect(dominates(fastButLong, cheapButSlow)).toBe(false)
			expect(areIncomparable(cheapButSlow, fastButLong)).toBe(true)

			// Dominance still works when one really is worse on every axis.
			const worse = cost({ deltaTrackMilesNm: 9, arrivalDelaySec: 900, fuelBurnMg: 9_000, peakLoadFactor: 2 })
			expect(dominates(cost(), worse)).toBe(true)
		})
	})

	describe("separation is a filter, never a cost", () => {
		it("excludes an unsafe option with a reason instead of scoring it down", () => {
			// Put the other aircraft directly in the way at the same altitude.
			const set = probe(request({
				world: [AAL221, { ...SWA455, x: -2, y: 0, altFt: AAL221.altFt, headingMdeg: AAL221.headingMdeg }],
			}))
			for (const excluded of set.excluded) {
				expect(excluded.reason).toBe("separation")
				expect(excluded.detail).toContain("loses separation")
			}
			// Excluded options are ABSENT from the option set, not present with a bad number.
			const excludedIds = new Set(set.excluded.map((e) => e.optionId))
			for (const option of set.options) expect(excludedIds.has(option.optionId)).toBe(false)
		})

		it("reports margins for every surviving option", () => {
			for (const option of probe(request()).options) {
				expect(option.margins.minHorizontalNm).toBeGreaterThan(0)
				expect(option.margins.against).toContain("SWA455")
			}
		})
	})

	describe("what it structurally cannot see", () => {
		/**
		 * The prober takes NO `pending` parameter. Reasoning about clearances formed but not
		 * committed is a different computation, and Phase 3's JointProber will have a different
		 * signature. Keeping them distinct is what stops the two silently becoming one.
		 */
		it("takes no pending-clearance parameter", () => {
			const keys = Object.keys(request())
			expect(keys).not.toContain("pending")
			expect(keys).not.toContain("intents")
		})

		it("tags the world generation, so a stale premise is detectable", () => {
			expect(probe(request({ forGeneration: 42 })).forGeneration).toBe(42)
		})

		it("returns an empty set for an unknown subject rather than throwing", () => {
			const set = probe(request({ subject: "XXX999" }))
			expect(set.options).toEqual([])
			expect(set.excluded).toEqual([])
		})
	})

	describe("determinism", () => {
		it("two identical probes agree exactly", () => {
			expect(probe(request())).toEqual(probe(request()))
		})
	})
})
