/**
 * THE THEOREM. Zero tokens, no network, no API key.
 *
 * A judge with a laptop and no credentials must be able to reproduce this, which is why it runs
 * entirely on the deterministic world.
 */
import { admissibleBandMs, isInBand } from "../src/domain/interlock/band"
import { evaluateJoint } from "../src/domain/interlock/joint-prober"
import { HORIZON_S, INITIAL, WINDOWS, WINDOW_A, WINDOW_B, clearanceA, clearanceB } from "../src/scenarios/braid-2"

const world = [...INITIAL]
const A = clearanceA()
const B = clearanceB()
const band = admissibleBandMs()

const probe = (pending: readonly (typeof A)[], atMs: number) =>
	evaluateJoint({ world, pending, windows: WINDOWS, atMs, horizonSec: HORIZON_S })

console.log("THE THEOREM\n" + "=".repeat(78) + "\n")

console.log("Windows, derived from manoeuvre physics:")
for (const w of [WINDOW_A, WINDOW_B]) {
	console.log(`  ${w.label.padEnd(18)} gate ${w.gateDistanceNm.toFixed(2).padStart(6)} NM   ` +
		`manoeuvre ${w.maneuverDurationS.toFixed(2).padStart(6)}s   W = ${w.windowMs.toFixed(0).padStart(6)} ms   ` +
		`in band: ${isInBand(w.windowMs)}`)
}
console.log(`\n  Admissible band (${band.lowerMs}, ${band.upperMs}) ms — derived from the latency model,`)
console.log(`  with no geometry in it. The gate distances are calibrated to land inside it; the`)
console.log(`  band itself is not a free parameter.\n`)

console.log("-".repeat(78))
console.log("\n(a) THE COMPANION CLAIM — the hazard IS visible to anything holding pending intent\n")
for (const [label, pending] of [["[A] alone", [A]], ["[B] alone", [B]], ["[A, B] pending", [A, B]]] as const) {
	const v = probe(pending, 0)
	const h = v.hazards[0]
	console.log(`  ${label.padEnd(16)} -> ${h ? `HAZARD ${h.minHorizontalNm.toFixed(4)} NM / ${h.verticalAtMinFt.toFixed(0)} ft / ${h.lossSeconds.toFixed(2)}s` : "no hazard"}`)
}
console.log("\n  Holding pending intent is exactly what the interlock does, and exactly what")
console.log("  validate-at-commit does not. That is the mechanism, not a weakness.\n")

console.log("-".repeat(78))
console.log("\n(b) THE REAL THEOREM — actionability, not blindness\n")
console.log(`  A serialized system cannot reach its SECOND decision before ${band.upperMs} ms`)
console.log(`  (turn + 8.0s single-channel readback + turn).\n`)

let bothOrdersFail = true
for (const [label, second] of [["[A then B]", B], ["[B then A]", A]] as const) {
	const v = probe([A, B], band.upperMs)
	const excluded = v.excluded.find((e) => e.clearanceId === second.id)
	if (!excluded) bothOrdersFail = false
	console.log(`  order ${label.padEnd(12)} at ${band.upperMs} ms -> ${second.id} ${excluded
		? `EXCLUDED "${excluded.reason}", missed by ${excluded.missedByMs.toFixed(0)} ms`
		: "still open"}`)
}

const concurrent = probe([A, B], band.lowerMs)
console.log(`\n  concurrent      at ${band.lowerMs} ms -> both windows open, ` +
	`${concurrent.hazards.length} hazard(s) found and ACTIONABLE`)

console.log("\n" + "-".repeat(78))
const serialized = probe([A, B], band.upperMs)
const ok = bothOrdersFail && serialized.hazards.length === 0 && concurrent.hazards.length === 1
console.log(`\n  ${ok ? "PASS" : "FAIL"}`)
console.log("\n  Validate-at-commit does not fail because it cannot see. It fails because by the")
console.log("  time it has committed and looked, the other aircraft's window is shut.")
console.log("\n  Both orders fail. If only one did, the hazard would be serializable and this")
console.log("  theorem would be false.\n")
process.exit(ok ? 0 : 1)
