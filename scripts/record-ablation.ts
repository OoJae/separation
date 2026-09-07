/**
 * THE ABLATION, AS A PICTURE.
 *
 * The README's ablation table is the strongest evidence in this repo and it is a table. This emits
 * the same comparison as two frame sequences from the shipped integrator, so the difference the
 * table asserts can be watched instead of read.
 *
 * Both arms start from the identical world and fly the identical integrator. The ONLY difference is
 * what each arm committed: arm B validates each clearance against the world and never against a
 * peer's pending intent, so the joint hazard is invisible to it and it flies into a loss of
 * separation. Arm C holds both commits as a set, sees the hazard, and narrows one.
 *
 * No models, no cache, no clock — pure deterministic geometry, so this reproduces byte-identically.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { runArm, type Arm } from "../src/ablation/arms"
import { WorldEngine } from "../src/infrastructure/simulation/world-engine"
import type { Command } from "../src/domain/airspace/aircraft-state"
import type { TrackRecord } from "../src/domain/airspace/observations"
import type { PendingClearance } from "../src/domain/airspace/encounter"
import { secondsToTick } from "../src/domain/airspace/units"
import {
	HORIZON_S, INITIAL, WINDOWS, clearanceA, clearanceB, narrowingCandidatesForA,
} from "../src/scenarios/braid-2"

const inputs = {
	seed: 0,
	world: INITIAL,
	clearances: [clearanceA(), clearanceB()] as readonly PendingClearance[],
	windows: WINDOWS,
	horizonSec: HORIZON_S,
	narrowingCandidates: (s: PendingClearance) =>
		s.callsign === "AAL221" ? narrowingCandidatesForA() : [],
}

/** Re-fly one arm's committed clearances through the shipped world engine, capturing 1 Hz frames. */
function framesFor(committed: readonly { callsign: string; command: string }[]) {
	const engine = WorldEngine.init([...INITIAL])
	const applied = new Set<string>()
	const frames: { tSim: number; tracks: readonly TrackRecord[] }[] = []
	const parsed = committed.map((c) => ({ callsign: c.callsign, command: JSON.parse(c.command) as Command }))
	// Every clearance bites one command lag after t=0 — the same instant for both arms, so the
	// comparison isolates WHAT was issued rather than when.
	const effectiveTick = secondsToTick(13)
	let lost: number | null = null

	for (let tick = 1; tick <= secondsToTick(HORIZON_S); tick++) {
		for (const c of parsed) {
			if (tick >= effectiveTick && !applied.has(c.callsign)) {
				applied.add(c.callsign)
				engine.command(c.callsign, c.command)
			}
		}
		const out = engine.step()
		if (out.losses.length > 0 && lost === null) lost = out.tSim
		if (out.snapshot) frames.push({ tSim: out.snapshot.tSim, tracks: out.snapshot.tracks })
	}
	return { frames, lostAtSec: lost }
}

const arms: Arm[] = ["concurrent-no-interlock", "concurrent-interlock"]
const LABEL: Record<string, string> = {
	"concurrent-no-interlock": "concurrent · validate at commit",
	"concurrent-interlock": "concurrent · interlock",
}

const rendered = arms.map((arm) => {
	const result = runArm(arm, inputs)
	const { frames, lostAtSec } = framesFor(result.committed)
	return {
		arm,
		label: LABEL[arm]!,
		committed: result.committed,
		jointHazardsCaught: result.jointHazardsCaught,
		separationLost: result.separationLost,
		lostAtSec,
		frames,
	}
})

mkdirSync("fixtures", { recursive: true })
const out = { meta: { scenario: "BRAID-2", seed: inputs.seed, horizonSec: HORIZON_S }, arms: rendered }
writeFileSync("fixtures/ablation-ab.json", JSON.stringify(out))

console.log(`\nABLATION A/B — one seed, one integrator, two architectures\n`)
for (const r of rendered) {
	console.log(`  ${r.label}`)
	console.log(`    committed        : ${r.committed.map((c) => c.command).join("  ")}`)
	console.log(`    joint hazards caught: ${r.jointHazardsCaught}`)
	console.log(`    separation lost  : ${r.separationLost ? `YES, at t+${r.lostAtSec}s` : "no"}`)
}
// The whole point: the two arms must DIFFER, or the picture is a duplicate.
const differ = rendered[0]!.separationLost !== rendered[1]!.separationLost
console.log(`\n  ${differ ? "PASS" : "FAIL"} — the arms differ in outcome, which is what makes this an A/B`)
console.log(`  wrote fixtures/ablation-ab.json (${(JSON.stringify(out).length / 1024).toFixed(0)} KB)\n`)
process.exit(differ ? 0 : 1)
