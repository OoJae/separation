import { describe, expect, it } from "@rstest/core"
import { PHASE_ORDER, WorldEngine, closureRate, isDue, verticalRate } from "../../src/infrastructure/simulation/world-engine"
import { WorldDriver } from "../../src/infrastructure/simulation/world-driver"
import { VirtualClock } from "../../src/support/ports"
import { degreesToMdeg } from "../../src/domain/airspace/units"
import { AAL221, SWA455 } from "../../src/scenarios/braid-2"
import type { TickOutput } from "../../src/infrastructure/simulation/world-engine"

const engine = () => WorldEngine.init([AAL221, SWA455])

describe("world engine", () => {
	describe("the three rates", () => {
		it("runs integrate at 50 Hz, closure at 20 Hz, snapshot at 1 Hz", () => {
			const world = engine()
			let integrates = 0, closures = 0, snapshots = 0
			for (let i = 0; i < 100; i++) {
				const out = world.step()
				if (out.phases.includes("integrate")) integrates++
				if (out.phases.includes("closure")) closures++
				if (out.snapshot !== null) snapshots++
			}
			expect(integrates).toBe(50)  // 1 second at 50 Hz
			expect(closures).toBe(20)
			expect(snapshots).toBe(1)
		})

		it("always runs due phases in PHASE_ORDER, never in due-order", () => {
			const world = engine()
			let seen: readonly string[] = []
			for (let i = 0; i < 100; i++) {
				const out = world.step()
				if (out.phases.length > seen.length) seen = out.phases
			}
			// tick 100 is due for everything
			expect(seen).toEqual([...PHASE_ORDER])
		})

		it("gates purely on integer modulus", () => {
			expect(isDue("integrate", 2)).toBe(true)
			expect(isDue("integrate", 3)).toBe(false)
			expect(isDue("closure", 5)).toBe(true)
			expect(isDue("snapshot", 100)).toBe(true)
			expect(isDue("snapshot", 50)).toBe(false)
		})
	})

	describe("observations are disjoint channels", () => {
		it("pair closure carries only RELATIVE quantities", () => {
			const world = engine()
			let closure = world.step().closures[0]
			for (let i = 0; i < 10 && closure === undefined; i++) closure = world.step().closures[0]
			expect(closure).toBeDefined()
			expect(Object.keys(closure!).sort()).toEqual([
				"a", "b", "closureRateNmPerSec", "rangeSqNm2", "tSim",
				"verticalRateFtPerSec", "verticalSeparationFt",
			])
		})

		/**
		 * The narrow, honest claim. A 1 Hz consumer CAN derive closure analytically from two
		 * snapshots, so we do not claim the fast channel is irreplaceable. What the snapshot
		 * genuinely omits is COMMANDED state — a planner cannot read an intent out of the world
		 * before it has moved metal.
		 */
		it("the snapshot omits commanded state, so intent is not readable from the world", () => {
			const world = engine()
			world.command("AAL221", { targetAltFt: 4_000 })
			let snapshot = null
			for (let i = 0; i < 100 && snapshot === null; i++) snapshot = world.step().snapshot
			expect(snapshot).not.toBeNull()
			const track = snapshot!.tracks.find((t) => t.callsign === "AAL221")!
			expect(Object.keys(track)).not.toContain("targetAltFt")
			expect(JSON.stringify(snapshot)).not.toContain("4000")
		})

		it("bumps a generation on every snapshot so staleness is visible", () => {
			const world = engine()
			const generations: number[] = []
			for (let i = 0; i < 300; i++) {
				const s = world.step().snapshot
				if (s !== null) generations.push(s.generation)
			}
			expect(generations).toEqual([1, 2, 3])
		})
	})

	describe("commands are values, never exceptions", () => {
		it("rejects an unknown callsign with a reason instead of throwing", () => {
			const result = engine().command("XXX999", { targetAltFt: 4_000 })
			expect(result).toEqual({ ok: false, reason: "unknown callsign XXX999" })
		})

		it("rejects an off-grid heading with a reason", () => {
			const result = engine().command("AAL221", { targetHeadingMdeg: 1_001 })
			expect(result.ok).toBe(false)
			if (result.ok) return
			expect(result.reason).toContain("off the 20 mdeg grid")
		})

		it("merges commands per callsign rather than replacing them", () => {
			const world = engine()
			world.command("AAL221", { targetAltFt: 4_000 })
			world.command("AAL221", { targetHeadingMdeg: degreesToMdeg(270) })
			expect(world.commandOf("AAL221")).toEqual({ targetAltFt: 4_000, targetHeadingMdeg: 270_000 })
		})
	})

	describe("separation invariant", () => {
		it("reports a loss as an EDGE, not once per tick", () => {
			const world = WorldEngine.init([
				{ ...AAL221, x: 0, y: 0, altFt: 6_000, headingMdeg: degreesToMdeg(90) },
				{ ...SWA455, x: 1, y: 0, altFt: 6_000, headingMdeg: degreesToMdeg(90) },
			])
			let losses = 0
			for (let i = 0; i < 200; i++) losses += world.step().losses.length
			expect(losses).toBe(1) // one edge, not 100 level reports
		})

		it("stays silent when only one minimum is breached", () => {
			const world = WorldEngine.init([
				{ ...AAL221, x: 0, y: 0, altFt: 6_000 },
				{ ...SWA455, x: 1, y: 0, altFt: 9_000 }, // 1 NM apart but 3000 ft vertically
			])
			let losses = 0
			for (let i = 0; i < 200; i++) losses += world.step().losses.length
			expect(losses).toBe(0)
		})
	})

	describe("closure and vertical rates", () => {
		it("is negative when closing and positive when opening", () => {
			const west = { ...AAL221, x: -5, y: 0, headingMdeg: degreesToMdeg(90) }
			const east = { ...SWA455, x: 5, y: 0, headingMdeg: degreesToMdeg(270) }
			expect(closureRate(west, east)).toBeLessThan(0)
			expect(closureRate({ ...west, headingMdeg: degreesToMdeg(270) }, { ...east, headingMdeg: degreesToMdeg(90) })).toBeGreaterThan(0)
		})

		it("reports the vertical gap shrinking when one descends toward the other", () => {
			const high = { ...AAL221, altFt: 9_000, verticalSpeedFpm: -2_000 }
			const low = { ...SWA455, altFt: 6_000, verticalSpeedFpm: 0 }
			expect(verticalRate(high, low)).toBeLessThan(0)
		})
	})
})

describe("world driver", () => {
	it("holds exactly ONE clock handle at a time, re-armed per tick", () => {
		const clock = new VirtualClock(0)
		const world = engine()
		const ticks: TickOutput[] = []
		const driver = new WorldDriver(world, clock, (out) => ticks.push(out))

		driver.start()
		expect(clock.pendingCount()).toBe(1)

		clock.advance(1_000) // 100 master ticks
		expect(ticks).toHaveLength(100)
		expect(clock.pendingCount()).toBe(1) // still exactly one, never three
		expect(driver.handlesTaken()).toBe(101)
	})

	it("stops cleanly and leaves no timer behind", () => {
		const clock = new VirtualClock(0)
		const driver = new WorldDriver(engine(), clock, () => {})
		driver.start()
		clock.advance(100)
		driver.stop()
		expect(clock.pendingCount()).toBe(0)
		expect(driver.isRunning()).toBe(false)
	})

	it("is reproducible: two identical drives produce identical tick streams", () => {
		const drive = () => {
			const clock = new VirtualClock(0)
			const ticks: TickOutput[] = []
			new WorldDriver(engine(), clock, (o) => ticks.push(o)).start()
			clock.advance(2_000)
			return ticks
		}
		expect(drive()).toEqual(drive())
	})
})
