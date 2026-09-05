import { describe, expect, it } from "@rstest/core"
import { readFileSync } from "node:fs"
import { contentDiffers, runArm, type ArmResult } from "../../src/ablation/arms"
import { AAL221, HORIZON_S, SWA455, WINDOWS, clearanceA, clearanceB, narrowingCandidatesForA } from "../../src/scenarios/braid-2"

const inputs = (targetAltFt: number) => {
	const a = clearanceA(0)
	return {
		world: [AAL221, SWA455] as const,
		clearances: [{ ...a, command: { ...a.command, targetAltFt } }, clearanceB(0)],
		windows: WINDOWS,
		narrowingCandidates: (s: { callsign: string }) => (s.callsign === "AAL221" ? narrowingCandidatesForA() : []),
		horizonSec: HORIZON_S,
		seed: 0,
	}
}

describe("the ablation arms", () => {
	/**
	 * The rigging check. If arm A could not express the joint hazard at all, the comparison would
	 * be theatre. It runs the SAME scenario with the SAME clearances — it simply cannot see a peer
	 * forming an intent, which is the whole difference being measured.
	 */
	it("arm A runs the same scenario and loses separation — it is not a crippled control", () => {
		const a = runArm("world-waits", inputs(4_000) as never)
		expect(a.committed).toHaveLength(2)
		expect(a.separationLost).toBe(true)
		expect(a.jointHazardsCaught).toBe(0) // it cannot SEE it, which is the point
	})

	it("validate-at-commit is equally blind — the theorem, as an arm", () => {
		const b = runArm("concurrent-no-interlock", inputs(4_000) as never)
		expect(b.jointHazardsCaught).toBe(0)
		expect(b.separationLost).toBe(true)
	})

	it("only the airlock catches it, and having caught it, prevents the loss", () => {
		const c = runArm("concurrent-interlock", inputs(4_000) as never)
		expect(c.jointHazardsCaught).toBeGreaterThan(0)
		expect(c.separationLost).toBe(false)
	})

	it("content-differs is 0 for arm A against itself, by construction", () => {
		const a = runArm("world-waits", inputs(4_000) as never)
		expect(contentDiffers(a, a)).toBe(false)
	})

	/**
	 * THE SELECTIVITY CHECK. A mechanism that altered every clearance would be indistinguishable
	 * from one that understood nothing.
	 */
	it("the airlock is SELECTIVE — it alters a hazardous clearance and leaves a safe one alone", () => {
		const hazardous = inputs(4_000) as never
		const safe = inputs(7_000) as never   // levels off exactly 1000 ft apart: legal

		expect(contentDiffers(runArm("world-waits", hazardous), runArm("concurrent-interlock", hazardous))).toBe(true)
		expect(contentDiffers(runArm("world-waits", safe), runArm("concurrent-interlock", safe))).toBe(false)
	})

	it("is deterministic run to run", () => {
		const once = runArm("concurrent-interlock", inputs(4_000) as never)
		const twice = runArm("concurrent-interlock", inputs(4_000) as never)
		expect(once).toEqual(twice)
	})
})

describe("the committed ablation result", () => {
	const report = JSON.parse(readFileSync("fixtures/ablation.json", "utf8")) as {
		rows: (ArmResult extends never ? never : {
			arm: string; separationLosses: number; jointHazardsCaught: number
			contentDiffers: number; differsOnHazard: number; differsOnSafe: number
		})[]
		regime: { hazardSeeds: number; safeSeeds: number }
	}

	it("spans both regimes, so 'always fires' cannot masquerade as 'understands'", () => {
		expect(report.regime.hazardSeeds).toBeGreaterThan(0)
		expect(report.regime.safeSeeds).toBeGreaterThan(0)
	})

	it("shows the airlock firing only on the hazardous regime", () => {
		const c = report.rows.find((r) => r.arm === "concurrent-interlock")!
		expect(c.differsOnHazard).toBe(report.regime.hazardSeeds)
		expect(c.differsOnSafe).toBe(0)
		expect(c.separationLosses).toBe(0)
	})

	it("shows both other arms blind to the joint hazard", () => {
		for (const arm of ["world-waits", "concurrent-no-interlock"]) {
			expect(report.rows.find((r) => r.arm === arm)!.jointHazardsCaught).toBe(0)
		}
	})
})
