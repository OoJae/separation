import { describe, expect, it } from "@rstest/core"
import { runScenario, SCENARIOS } from "../../src/main"
import { drawRoundMs, drawTurnMs, MAX_TURN_MS, MIN_TURN_MS, ROUND_MS_DECILES } from "../../src/infrastructure/inference/latency-model"
import { Rng } from "../../src/support/rng"

describe("full scenario on the real bus", () => {
	it("runs every arm headless with zero tokens", () => {
		for (const clearances of Object.values(SCENARIOS)) {
			const result = runScenario({ clearances })
			expect(result.ticks).toBe(38_000)
			expect(result.events).toBeGreaterThan(7_000)
		}
	})

	/**
	 * Two independent witnesses. The quantised trace is what a human reads; the raw-bit hash
	 * catches drift BELOW print precision, which is exactly what a quantised diff would pass.
	 */
	it("reproduces byte-identically, by trace AND by state hash", () => {
		for (const clearances of Object.values(SCENARIOS)) {
			const first = runScenario({ clearances })
			const second = runScenario({ clearances })
			expect(first.trace).toEqual(second.trace)
			expect(first.stateHash).toBe(second.stateHash)
		}
	})

	it("gives each arm a DIFFERENT hash, so the arms are not accidentally identical", () => {
		const hashes = Object.values(SCENARIOS).map((c) => runScenario({ clearances: c }).stateHash)
		expect(new Set(hashes).size).toBe(hashes.length)
	})

	/**
	 * The end-to-end shape of the whole thesis, observable on the bus: only the joint arm ever
	 * publishes a separation.lost event.
	 */
	it("emits separation.lost ONLY in the joint arm", () => {
		const baseline = runScenario({ clearances: SCENARIOS.baseline })
		const aOnly = runScenario({ clearances: SCENARIOS.a })
		const bOnly = runScenario({ clearances: SCENARIOS.b })
		const joint = runScenario({ clearances: SCENARIOS.joint })

		expect(aOnly.events).toBe(baseline.events)
		expect(bOnly.events).toBe(baseline.events)
		expect(joint.events).toBe(baseline.events + 1)
	})

	it("refuses to run with telemetry enabled", () => {
		const previous = process.env.MOZAIK_API_KEY
		process.env.MOZAIK_API_KEY = "dummy"
		try {
			expect(() => runScenario({ clearances: [] })).toThrow(/MOZAIK_API_KEY must be unset/)
		} finally {
			if (previous === undefined) delete process.env.MOZAIK_API_KEY
			else process.env.MOZAIK_API_KEY = previous
		}
	})
})

describe("synthetic latency", () => {
	it("draws only from the checked-in deciles, with no transcendental anywhere", () => {
		const rng = Rng.fromSeed("latency")
		for (let i = 0; i < 5_000; i++) {
			const ms = drawRoundMs(rng)
			expect(ms).toBeGreaterThanOrEqual(ROUND_MS_DECILES[0]!)
			expect(ms).toBeLessThanOrEqual(ROUND_MS_DECILES[ROUND_MS_DECILES.length - 1]!)
			expect(Number.isInteger(ms)).toBe(true)
		}
	})

	it("bounds a two-round controller turn", () => {
		const rng = Rng.fromSeed("turn")
		for (let i = 0; i < 2_000; i++) {
			const ms = drawTurnMs(rng)
			expect(ms).toBeGreaterThanOrEqual(MIN_TURN_MS)
			expect(ms).toBeLessThanOrEqual(MAX_TURN_MS + 2)
		}
	})

	/**
	 * The window arithmetic the Phase 3 theorem rests on: a concurrent commit fits inside both
	 * aircraft's manoeuvre windows, and a serialized one (two turns plus 8s of radio) does not.
	 */
	it("makes the concurrent commit fit and the serialized one miss", () => {
		const W_A_MS = 9_800, W_B_MS = 9_867
		const T_RT_MS = 8_000
		expect(MAX_TURN_MS).toBeLessThan(W_A_MS)
		expect(MAX_TURN_MS).toBeLessThan(W_B_MS)

		const serializedMin = MIN_TURN_MS + T_RT_MS + MIN_TURN_MS
		expect(serializedMin).toBeGreaterThan(W_A_MS)
		expect(serializedMin).toBeGreaterThan(W_B_MS)
	})

	it("is reproducible from a seed", () => {
		const draw = () => {
			const rng = Rng.fromSeed("repeat")
			return [drawTurnMs(rng), drawTurnMs(rng), drawTurnMs(rng)]
		}
		expect(draw()).toEqual(draw())
	})
})
