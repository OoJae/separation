import { describe, expect, it } from "@rstest/core"
import { Rng } from "../../src/support/rng"
import { StateHash, normaliseZero, quantise } from "../../src/domain/airspace/canonical"
import { LoopAlias } from "../../src/participants/recorder/loop-alias"
import {
	mdegDelta, normaliseMdeg, secondsToTick, tickToSeconds, TURN_RATE_MDEG_PER_S,
} from "../../src/domain/airspace/units"

describe("determinism substrate", () => {
	describe("integer accumulation — the reason these types are integers", () => {
		it("float time accumulation DRIFTS, which is why time is an integer tick", () => {
			let accumulated = 0
			for (let i = 0; i < 20_000; i++) accumulated += 0.02
			expect(accumulated).not.toBe(400)          // measured 399.99999999992616
			expect(tickToSeconds(secondsToTick(400))).toBe(400) // computed fresh: exact
		})

		it("float heading accumulation DRIFTS, which is why heading is integer mdeg", () => {
			let degrees = 90
			for (let i = 0; i < 1_500; i++) degrees += 0.06
			expect(degrees).not.toBe(180)              // measured 180.00000000000341

			let mdeg = 90_000
			for (let i = 0; i < 1_500; i++) mdeg = normaliseMdeg(mdeg + 60)
			expect(mdeg).toBe(180_000)                 // exact, every time
		})

		it("the per-tick turn increment is an exact integer", () => {
			expect(TURN_RATE_MDEG_PER_S * 0.02).toBe(60)
			expect(Number.isInteger(TURN_RATE_MDEG_PER_S * 0.02)).toBe(true)
		})
	})

	describe("angles", () => {
		it("normalises into [0, 360000)", () => {
			expect(normaliseMdeg(-1_000)).toBe(359_000)
			expect(normaliseMdeg(360_000)).toBe(0)
			expect(normaliseMdeg(725_000)).toBe(5_000)
		})

		it("takes the shortest way round, with sign", () => {
			expect(mdegDelta(350_000, 10_000)).toBe(20_000)    // right through north
			expect(mdegDelta(10_000, 350_000)).toBe(-20_000)   // left through north
			expect(mdegDelta(0, 180_000)).toBe(180_000)        // the boundary is inclusive one way
		})
	})

	describe("canonical form", () => {
		/**
		 * -0 is invisible to JSON.stringify, String() and ===, but its raw bits differ
		 * (8000000000000000 vs 0000000000000000). So it cannot corrupt the readable trace — it
		 * corrupts the BIT HASH, making two numerically identical runs report a false mismatch.
		 * That is the whole reason normaliseZero exists.
		 */
		it("collapses -0, which is invisible to JSON but differs in raw bits", () => {
			expect(JSON.stringify(-0)).toBe("0")   // invisible here...
			expect(-0 === 0).toBe(true)            // ...and here...
			expect(Object.is(-0, 0)).toBe(false)   // ...but not here

			const signed = new StateHash(); signed.pushNumber(-0)
			const plain = new StateHash(); plain.pushNumber(0)
			expect(signed.digest()).toBe(plain.digest()) // normalised inside pushNumber

			expect(Object.is(normaliseZero(-0), 0)).toBe(true)
		})

		it("quantises for the readable trace without touching physics", () => {
			expect(quantise(2.53649999)).toBe(2.5365)
			expect(quantise(1 / 3, 6)).toBe(0.333333)
		})

		it("hashes raw bits, so drift below print precision is still caught", () => {
			const a = new StateHash(); a.pushNumber(0.1 + 0.2)
			const b = new StateHash(); b.pushNumber(0.3)
			expect(quantise(0.1 + 0.2)).toBe(quantise(0.3))   // a quantised diff would MISS it
			expect(a.digest()).not.toBe(b.digest())            // the bit hash does not
		})

		it("is stable across instances", () => {
			const make = () => { const h = new StateHash(); h.pushString("AAL221"); h.pushNumber(-10); h.pushInt(9000); return h.digest() }
			expect(make()).toBe(make())
		})
	})

	describe("Rng", () => {
		it("is reproducible from a seed", () => {
			const draw = () => { const r = Rng.fromSeed("braid-2"); return [r.nextUint32(), r.nextUint32(), r.nextUint32()] }
			expect(draw()).toEqual(draw())
		})

		it("gives different streams for different seeds", () => {
			expect(Rng.fromSeed("a").nextUint32()).not.toBe(Rng.fromSeed("b").nextUint32())
		})

		it("stays in range", () => {
			const rng = Rng.fromSeed("range")
			for (let i = 0; i < 2_000; i++) {
				const f = rng.nextFloat()
				expect(f).toBeGreaterThanOrEqual(0)
				expect(f).toBeLessThan(1)
				const n = rng.nextInt(-3, 7)
				expect(n).toBeGreaterThanOrEqual(-3)
				expect(n).toBeLessThanOrEqual(7)
			}
		})
	})

	describe("LoopAlias — the Phase 1 gap this phase found", () => {
		it("maps random loop ids to stable monotonic aliases", () => {
			const alias = new LoopAlias()
			const a = crypto.randomUUID(), b = crypto.randomUUID()
			expect(alias.aliasFor(a)).toBe("L1")
			expect(alias.aliasFor(b)).toBe("L2")
			expect(alias.aliasFor(a)).toBe("L1")   // stable on re-observation
			expect(alias.size()).toBe(2)
		})

		it("gives two runs with different uuids an identical alias sequence", () => {
			const run = () => {
				const alias = new LoopAlias()
				return [crypto.randomUUID(), crypto.randomUUID()].map((id) => alias.aliasFor(id))
			}
			expect(run()).toEqual(run())
		})
	})
})
