/**
 * THE ABLATION. 3 architectural arms x 200 seeds = 600 runs, zero tokens.
 *
 * One deterministic decision policy across all three arms, so the only variable is the
 * architecture. Seeds vary the scenario — initial jitter and commit timing — never model sampling.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import type { AircraftState } from "../src/domain/airspace/aircraft-state"
import { ARMS, contentDiffers, runArm, type ArmResult } from "../src/ablation/arms"
import { Rng } from "../src/support/rng"
import {
	AAL221, HORIZON_S, SWA455, WINDOWS, clearanceA, clearanceB, narrowingCandidatesForA,
} from "../src/scenarios/braid-2"

const SEEDS = Number(process.argv.find((a) => a.startsWith("--seeds="))?.split("=")[1] ?? 200)

/**
 * Seeds deliberately span BOTH regimes.
 *
 * If every seed contained a joint hazard, the airlock would fire on all of them and the table
 * would read 200/200/200 — which is indistinguishable from an architecture that simply modifies
 * everything. Half the seeds are therefore drawn with a shallow descent target, which Phase 2
 * established is safe because the aircraft level exactly 1000 ft apart. A selective mechanism must
 * fire on one regime and stay silent on the other, and that is what the table has to show.
 */
const HAZARD_TARGETS = [4_000, 5_000, 6_000]   // deep enough to remove the vertical protection
const SAFE_TARGETS = [7_000, 8_000]            // levels off legally separated

function inputsFor(seed: number) {
	const rng = Rng.fromSeed(`ablation-${seed}`)
	const jitter = () => (rng.nextInt(0, 20) - 10) / 100        // +-0.10 NM
	const commitAt = () => rng.nextInt(0, 9) / 2                 // 0 - 4.5 s
	const hazardous = seed % 2 === 0
	const targetAltFt = hazardous
		? HAZARD_TARGETS[rng.nextInt(0, HAZARD_TARGETS.length - 1)]!
		: SAFE_TARGETS[rng.nextInt(0, SAFE_TARGETS.length - 1)]!

	const world: readonly [AircraftState, AircraftState] = [
		{ ...AAL221, x: AAL221.x + jitter(), y: AAL221.y + jitter() },
		{ ...SWA455, x: SWA455.x + jitter(), y: SWA455.y + jitter() },
	]
	const a = clearanceA(commitAt())
	return {
		hazardous,
		world,
		clearances: [{ ...a, command: { ...a.command, targetAltFt } }, clearanceB(commitAt())],
		windows: WINDOWS,
		narrowingCandidates: (s: { callsign: string }) =>
			s.callsign === "AAL221" ? narrowingCandidatesForA() : [],
		horizonSec: HORIZON_S,
		seed,
	}
}

console.log(`Ablation — ${ARMS.length} arms x ${SEEDS} seeds = ${ARMS.length * SEEDS} runs, zero tokens\n`)

const results = new Map<string, ArmResult[]>(ARMS.map((a) => [a, []]))
const regime: boolean[] = []   // true = this seed's clearances actually create a joint hazard
for (let seed = 0; seed < SEEDS; seed++) {
	const inputs = inputsFor(seed)
	regime.push(inputs.hazardous)
	for (const arm of ARMS) results.get(arm)!.push(runArm(arm, inputs as never))
}

const baseline = results.get("world-waits")!
const rows = ARMS.map((arm) => {
	const runs = results.get(arm)!
	return {
		arm,
		runs: runs.length,
		separationLosses: runs.filter((r) => r.separationLost).length,
		jointHazardsCaught: runs.reduce((n, r) => n + r.jointHazardsCaught, 0),
		contentDiffers: runs.filter((r, i) => contentDiffers(baseline[i]!, r)).length,
		windowMissed: runs.reduce((n, r) => n + r.windowMissed, 0),
		// Split by regime: a SELECTIVE mechanism fires on one and stays silent on the other.
		differsOnHazard: runs.filter((r, i) => regime[i] && contentDiffers(baseline[i]!, r)).length,
		differsOnSafe: runs.filter((r, i) => !regime[i] && contentDiffers(baseline[i]!, r)).length,
		lossOnHazard: runs.filter((r, i) => regime[i] && r.separationLost).length,
	}
})
const hazardSeeds = regime.filter(Boolean).length
const safeSeeds = regime.length - hazardSeeds

const pad = (s: string | number, n: number) => String(s).padStart(n)
console.log(`  ${"arm".padEnd(26)} ${pad("runs", 5)} ${pad("sep losses", 11)} ${pad("hazards caught", 15)} ${pad("content differs", 16)}`)
console.log("  " + "-".repeat(78))
for (const r of rows) {
  console.log(`  ${r.arm.padEnd(26)} ${pad(r.runs, 5)} ${pad(r.separationLosses, 11)} ${pad(r.jointHazardsCaught, 15)} ${pad(r.contentDiffers, 16)}`)
}

const a = rows[0]!, b = rows[1]!, c = rows[2]!
console.log(`\n  Seeds by regime: ${hazardSeeds} hazardous, ${safeSeeds} safe.`)
console.log(`  ${"arm".padEnd(26)} ${pad("narrowed / hazardous", 21)} ${pad("narrowed / safe", 16)}`)
console.log("  " + "-".repeat(66))
for (const r of rows) {
	console.log(`  ${r.arm.padEnd(26)} ${pad(`${r.differsOnHazard} / ${hazardSeeds}`, 21)} ${pad(`${r.differsOnSafe} / ${safeSeeds}`, 16)}`)
}
console.log(`\n  THE SELECTIVITY CHECK: the airlock must alter instructions on the hazardous regime`)
console.log(`  and leave the safe one alone. A mechanism that modified everything would be`)
console.log(`  indistinguishable from one that understood nothing.\n`)
console.log(`  Column three is the "not a pipeline" number. It is 0 in the sequential arm BY`)
console.log(`  CONSTRUCTION — no peer intent exists while a clearance is being formed, so nothing`)
console.log(`  can change what is issued. It is non-zero only where the architecture actually`)
console.log(`  altered an instruction.\n`)
console.log(`  Column two is why it is not a solver: the joint hazard is invisible to both the`)
console.log(`  sequential arm and to validate-at-commit, and visible only to the airlock.\n`)

const ok = a.contentDiffers === 0 && c.jointHazardsCaught > 0 && b.jointHazardsCaught === 0
	&& c.differsOnSafe === 0 && c.differsOnHazard > 0
console.log(`  ${ok ? "PASS" : "FAIL"} — arm A content-differs is 0 by construction (${a.contentDiffers}),`)
console.log(`         validate-at-commit catches ${b.jointHazardsCaught}, the airlock catches ${c.jointHazardsCaught}`)
console.log(`         and the airlock is SELECTIVE: ${c.differsOnHazard}/${hazardSeeds} hazardous altered, ${c.differsOnSafe}/${safeSeeds} safe altered`)

mkdirSync("fixtures", { recursive: true })
writeFileSync("fixtures/ablation.json", JSON.stringify({
	generated: { seeds: SEEDS, arms: ARMS },
	rows,
	regime: { hazardSeeds, safeSeeds },
	note: "Arms vary the ARCHITECTURE, not the model. One deterministic decision policy across all three; seeds vary scenario conditions only.",
}, null, 1))
console.log(`\n  wrote fixtures/ablation.json`)
process.exit(ok ? 0 : 1)
