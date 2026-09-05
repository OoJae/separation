/**
 * Reproduces every BRAID-2 headline number FROM THE SHIPPED INTEGRATOR.
 * Zero tokens, no network. `npm run verify:braid-2`
 */
import { flyEncounter } from "../src/domain/airspace/encounter"
import { admissibleBandMs } from "../src/domain/interlock/band"
import { WINDOW_A, WINDOW_B } from "../src/scenarios/braid-2"
import { HORIZON_S, INITIAL_ARMED, clearanceA, clearanceB } from "../src/scenarios/braid-2"

const cases = [
	["baseline", []],
	["[A] alone  (vertical)", [clearanceA()]],
	["[B] alone  (lateral)", [clearanceB()]],
	["[A,B] together", [clearanceA(), clearanceB()]],
] as const

console.log("BRAID-2 — measured by the shipped 50 Hz integrator\n")
console.log("  case                     minH(NM)   at(s)    dZ@min(ft)  lateral<3nm      vertical<1000ft   LOSS")
console.log("  " + "-".repeat(104))

const rows = cases.map(([label, clearances]) => {
	const r = flyEncounter(INITIAL_ARMED, clearances, HORIZON_S)
	const iv = (i: { fromS: number; toS: number } | null) =>
		i === null ? "none".padEnd(16) : `(${i.fromS.toFixed(2)}, ${i.toS.toFixed(2)})`.padEnd(16)
	console.log(
		`  ${label.padEnd(24)} ${r.minHorizontalNm.toFixed(4).padStart(8)} ${r.atSeconds.toFixed(2).padStart(8)} ` +
		`${r.verticalAtMinFt.toFixed(0).padStart(11)}  ${iv(r.lateralBreach)} ${iv(r.verticalBreach)} ` +
		`${r.loss === null ? "none" : `${r.lossSeconds.toFixed(2)}s`}`,
	)
	return { label, r }
})

const [, aOnly, bOnly, both] = rows
console.log()
const ok =
	aOnly!.r.loss === null && bOnly!.r.loss === null && both!.r.loss !== null
console.log(`  A alone safe : ${aOnly!.r.loss === null}`)
console.log(`  B alone safe : ${bOnly!.r.loss === null}`)
console.log(`  A+B hazard   : ${both!.r.loss !== null}`)
console.log(`\n  ${ok ? "PASS" : "FAIL"} — individually safe, jointly unsafe`)
let serializationHolds = false

// ─────────────────────────────────────────────────────────────────────────────────────────
// ROBUSTNESS. A knife-edge construction reads as rigged, so measure the neighbourhood and
// report whatever comes back.
// ─────────────────────────────────────────────────────────────────────────────────────────
import type { AircraftState } from "../src/domain/airspace/aircraft-state"
import { AAL221_ARMED, SWA455, COMMAND_LAG_S } from "../src/scenarios/braid-2"
import { degreesToMdeg, secondsToTick, tickToSeconds } from "../src/domain/airspace/units"

const hazard = (init: readonly [AircraftState, AircraftState], cs: Parameters<typeof flyEncounter>[1]) =>
	flyEncounter(init, cs, HORIZON_S).loss !== null

console.log("\n" + "=".repeat(106))
console.log("ROBUSTNESS\n")

// 1. Commit time — the only thing controller latency actually varies.
{
	// Spans the REAL decision range (22.6-34.6 s measured), not the assumed one it used to.
	const grid = [0, 5, 10, 15, 20, 25, 30, 34.58, 40]
	let hit = 0
	let minH = Infinity, maxH = -Infinity, minLoss = Infinity, maxLoss = -Infinity
	for (const ta of grid) for (const tb of grid) {
		const r = flyEncounter(INITIAL_ARMED, [clearanceA(ta), clearanceB(tb)], HORIZON_S)
		if (r.loss !== null) {
			hit++
			minH = Math.min(minH, r.minHorizontalNm); maxH = Math.max(maxH, r.minHorizontalNm)
			minLoss = Math.min(minLoss, r.lossSeconds); maxLoss = Math.max(maxLoss, r.lossSeconds)
		}
	}
	console.log(`  1. commit-time grid 9x9 over [${grid[0]}, ${grid[grid.length - 1]}]s : ${hit}/81 produce the joint hazard`)
	console.log(`     min horizontal ${minH.toFixed(4)}-${maxH.toFixed(4)} NM, loss ${minLoss.toFixed(2)}-${maxLoss.toFixed(2)}s`)
}

// 2. Initial-condition jitter.
{
	const dxs = [-0.1, 0, 0.1], dys = [-0.1, 0, 0.1], dvs = [-1, 0, 1], dzs = [-20, 0, 20]
	let hit = 0, total = 0, singles = 0
	let minH = Infinity, maxH = -Infinity
	for (const dx of dxs) for (const dy of dys) for (const dv of dvs) for (const dz of dzs) {
		for (const dx2 of dxs) for (const dy2 of dys) {
			total++
			const a: AircraftState = { ...AAL221_ARMED, x: AAL221_ARMED.x + dx, y: AAL221_ARMED.y + dy, groundspeedKt: 250 + dv, altFt: 9000 + dz }
			const b: AircraftState = { ...SWA455, x: SWA455.x + dx2, y: SWA455.y + dy2 }
			const init = [a, b] as const
			const r = flyEncounter(init, [clearanceA(), clearanceB()], HORIZON_S)
			if (r.loss !== null) { hit++; minH = Math.min(minH, r.minHorizontalNm); maxH = Math.max(maxH, r.minHorizontalNm) }
			if (hazard(init, [clearanceA()]) || hazard(init, [clearanceB()])) singles++
		}
	}
	console.log(`\n  2. initial jitter +-0.1NM / +-1kt / +-20ft : ${hit}/${total} produce the joint hazard`)
	console.log(`     min horizontal ${minH.toFixed(4)}-${maxH.toFixed(4)} NM`)
	console.log(`     single clearances hazardous in the same envelope: ${singles}/${total}`)
}

// 3. The action set — is the structure legible, or is one magic pair?
{
	const headings = [320, 330, 340, 350, 0, 10, 20, 30, 40]
	const targets = [3000, 4000, 5000, 6000, 7000, 8000]
	let joint = 0, total = 0
	const safeTargets = new Set<number>(), hazardTargets = new Set<number>()
	for (const h of headings) for (const t of targets) {
		total++
		const A = { ...clearanceA(), command: { targetAltFt: t } }
		const B = { ...clearanceB(), command: { targetHeadingMdeg: degreesToMdeg(h) } }
		if (flyEncounter(INITIAL_ARMED, [A, B], HORIZON_S).loss !== null) { joint++; hazardTargets.add(t) }
		else safeTargets.add(t)
	}
	let singles = 0
	for (const h of headings) if (hazard(INITIAL_ARMED, [{ ...clearanceB(), command: { targetHeadingMdeg: degreesToMdeg(h) } }])) singles++
	for (const t of targets) if (hazard(INITIAL_ARMED, [{ ...clearanceA(), command: { targetAltFt: t } }])) singles++
	console.log(`\n  3. action set ${headings.length} headings x ${targets.length} descent targets : ${joint}/${total} jointly hazardous`)
	console.log(`     single clearances hazardous over the same range: ${singles}/${headings.length + targets.length}`)
	console.log(`     descent targets that can produce a hazard: ${[...hazardTargets].sort((a,b)=>a-b).join(", ")}`)
}

// 4. Serialization — both orders must miss their window.
{
	// DERIVED, not hardcoded. These used to be four string literals carrying the pre-measurement
	// values (W_A 9.8s, serialized 12.4s) and sitting outside the `ok` flag, so this section could
	// never fail and contradicted verify:theorem by 4.5x on adjacent README lines.
	const band = admissibleBandMs()
	const wA = WINDOW_A.windowMs, wB = WINDOW_B.windowMs
	// Commit instants are integer 10 ms ticks, so the serialized commit lands on the tick at or
	// before band.upperMs. Quantising here is what makes this agree to the millisecond with
	// verify:theorem, which goes through real clearances rather than raw window arithmetic.
	const committedMs = tickToSeconds(secondsToTick(band.upperMs / 1000)) * 1000
	const missA = committedMs - wA, missB = committedMs - wB
	console.log(`\n  4. windows: W_A=${(wA / 1000).toFixed(2)}s  W_B=${(wB / 1000).toFixed(2)}s`)
	console.log(`     concurrent commit  <= ${band.lowerMs}ms  -> A ${band.lowerMs <= wA ? "makes it" : "MISSES"}, B ${band.lowerMs <= wB ? "makes it" : "MISSES"}`)
	console.log(`     serialized commit  >= ${band.upperMs}ms  -> A MISSES by ${missA.toFixed(0)}ms, B MISSES by ${missB.toFixed(0)}ms`)
	console.log(`     => both orders miss. If only one missed, the hazard would be serializable.`)
	serializationHolds = band.lowerMs <= wA && band.lowerMs <= wB && missA > 0 && missB > 0
}

console.log(`\n  ${ok && serializationHolds ? "PASS" : "FAIL"} — geometry and window arithmetic both hold`)
process.exit(ok && serializationHolds ? 0 : 1)
