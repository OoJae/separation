/**
 * THE THEOREM. Zero tokens, no network, no API key.
 *
 * A judge with a laptop and no credentials must be able to reproduce this, which is why it runs
 * entirely on the deterministic world.
 */
import { admissibleBandMs, isInBand } from "../src/domain/interlock/band"
import { MIN_TURN_MS } from "../src/domain/interlock/decision-latency"
import { evaluateJoint, findJointHazards } from "../src/domain/interlock/joint-prober"
import { HORIZON_S, INITIAL, WINDOWS, WINDOW_A, WINDOW_B, clearanceA, clearanceB } from "../src/scenarios/braid-2"

const world = [...INITIAL]
const A = clearanceA()
const B = clearanceB()
const band = admissibleBandMs()

/**
 * ONE CLOCK: a probe models a decision taken at `commitMs`, so the clearances are BUILT at that
 * instant. Judging a clearance's window at one time while flying it from another is the two-clock
 * defect this script exists to disprove.
 */
const probeAt = (ids: readonly ("A" | "B")[], commitMs: number) =>
	evaluateJoint({
		world,
		pending: ids.map((id) => (id === "A" ? clearanceA(commitMs / 1000) : clearanceB(commitMs / 1000))),
		windows: WINDOWS, atMs: commitMs, horizonSec: HORIZON_S,
	})

/**
 * GEOMETRY ONLY — deliberately NOT routed through evaluateJoint.
 *
 * evaluateJoint excludes a clearance whose window has shut, so bisecting through it would measure
 * when the WINDOW closes (43.7s) and call it the hazard's lifetime. Those are two different facts
 * and conflating them is the same class of mistake as the two-clock defect. The lifetime is a
 * property of the aircraft, so it is measured against the aircraft.
 */
const hazardousAt = (commitMs: number) =>
	findJointHazards(world, [clearanceA(commitMs / 1000), clearanceB(commitMs / 1000)], HORIZON_S).length === 1
function hazardLifetimeMs(): number {
	let lo = 0, hi = 120_000
	while (hi - lo > 100) { const m = Math.floor((lo + hi) / 2); if (hazardousAt(m)) lo = m; else hi = m }
	return lo
}

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
for (const [label, ids] of [["[A] alone", ["A"]], ["[B] alone", ["B"]], ["[A, B] pending", ["A", "B"]]] as const) {
	const v = probeAt(ids, 0)
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
	const v = probeAt(["A", "B"], band.upperMs)
	const excluded = v.excluded.find((e) => e.clearanceId === second.id)
	if (!excluded) bothOrdersFail = false
	console.log(`  order ${label.padEnd(12)} at ${band.upperMs} ms -> ${second.id} ${excluded
		? `EXCLUDED "${excluded.reason}", missed by ${excluded.missedByMs.toFixed(0)} ms`
		: "still open"}`)
}

const concurrent = probeAt(["A", "B"], band.lowerMs)
const fastest = probeAt(["A", "B"], MIN_TURN_MS)
console.log(`\n  concurrent      at ${MIN_TURN_MS} ms -> both windows open, ` +
	`${fastest.hazards.length} hazard(s) found and ACTIONABLE   (fastest turn)`)
console.log(`  concurrent      at ${band.lowerMs} ms -> both windows open, ` +
	`${concurrent.hazards.length} hazard(s) found and ACTIONABLE   (SLOWEST turn — the worst case)`)

const lifetimeMs = hazardLifetimeMs()
console.log(`\n  The hazard has a LIFETIME: commit both later than ${(lifetimeMs / 1000).toFixed(1)}s and the aircraft`)
console.log(`  pass legally, so there is nothing left to catch. It must outlast the slowest`)
console.log(`  decision the architecture can make:`)
console.log(`     hazard lifetime      ${(lifetimeMs / 1000).toFixed(1)}s`)
console.log(`     slowest concurrent   ${(band.lowerMs / 1000).toFixed(2)}s   -> margin ${((lifetimeMs - band.lowerMs) / 1000).toFixed(1)}s`)
console.log(`     serialized second    ${(band.upperMs / 1000).toFixed(2)}s   -> ${lifetimeMs > band.upperMs ? "hazard STILL alive; the serialized arm fails on the window alone" : "hazard already gone"}`)

console.log("\n" + "-".repeat(78))
const serialized = probeAt(["A", "B"], band.upperMs)
const ok = bothOrdersFail && serialized.hazards.length === 0 && concurrent.hazards.length === 1
	&& fastest.hazards.length === 1 && lifetimeMs > band.lowerMs
console.log(`\n  ${ok ? "PASS" : "FAIL"}`)
console.log("\n  Validate-at-commit does not fail because it cannot see. It fails because by the")
console.log("  time it has committed and looked, the other aircraft's window is shut.")
console.log("\n  Both orders fail. If only one did, the hazard would be serializable and this")
console.log("  theorem would be false.\n")
process.exit(ok ? 0 : 1)
