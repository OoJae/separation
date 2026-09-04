/**
 * Does TCAS resolve BRAID-2 for us?
 *
 * If it does, the headline result evaporates: the "joint hazard" would just be an encounter the
 * safety net already handles, and no amount of architecture would matter. This script answers it
 * by flying the scenario and running the real advisory test at 20 Hz on every pair.
 */
import { WorldEngine } from "../src/infrastructure/simulation/world-engine"
import { testAdvisory } from "../src/domain/reflex/advisory"
import { sensitivityFor } from "../src/domain/reflex/constants"
import { AAL221, HORIZON_S, SWA455, clearanceA, clearanceB } from "../src/scenarios/braid-2"
import { secondsToTick } from "../src/domain/airspace/units"
import type { PendingClearance } from "../src/domain/airspace/encounter"

function run(label: string, clearances: readonly PendingClearance[]) {
	const world = WorldEngine.init([AAL221, SWA455])
	const horizon = secondsToTick(HORIZON_S)
	let worstRaTau = Number.POSITIVE_INFINITY
	let minRangeNm = Number.POSITIVE_INFINITY
	let minVerticalAtClosest = Number.POSITIVE_INFINITY
	let ras = 0
	let tas = 0
	const applied = new Set<string>()

	for (let tick = 1; tick <= horizon; tick++) {
		for (const c of clearances) {
			if (tick >= c.effectiveTick && !applied.has(c.id)) {
				applied.add(c.id)
				world.command(c.callsign, c.command)
			}
		}
		const out = world.step()
		for (const closure of out.closures) {
			const a = world.stateOf(closure.a)!
			const b = world.stateOf(closure.b)!
			for (const own of [a, b]) {
				const test = testAdvisory(closure, own.altFt)
				if (test.kind === "resolution") ras++
				else if (test.kind === "traffic") tas++
				if (Number.isFinite(test.tauModS)) worstRaTau = Math.min(worstRaTau, test.tauModS)
			}
			const range = Math.sqrt(closure.rangeSqNm2)
			if (range < minRangeNm) {
				minRangeNm = range
				minVerticalAtClosest = closure.verticalSeparationFt
			}
		}
	}

	const row = sensitivityFor(6_000)
	console.log(
		`  ${label.padEnd(22)} RA=${String(ras).padStart(4)}  TA=${String(tas).padStart(4)}  ` +
		`minRange=${minRangeNm.toFixed(4)}nm  dZ@closest=${minVerticalAtClosest.toFixed(0)}ft  ` +
		`bestRAtau=${worstRaTau === Number.POSITIVE_INFINITY ? "never closing" : worstRaTau.toFixed(1) + "s"}`,
	)
	return { ras, tas, minRangeNm, row }
}

console.log("Is BRAID-2's joint hazard visible to TCAS?\n")
const results = [
	run("baseline", []),
	run("[A] alone", [clearanceA()]),
	run("[B] alone", [clearanceB()]),
	run("[A,B] together", [clearanceA(), clearanceB()]),
]

const row = results[0]!.row
console.log(`\n  At 5000-10000 ft (SL${row.level}): RA DMOD = ${row.raDmodNm} NM, RA tau = ${row.raTauS}s,`)
console.log(`  TA DMOD = ${row.taDmodNm} NM, TA tau = ${row.taTauS}s, RA ZTHR = ${row.raZthrFt} ft.`)
console.log(`  Closest approach in the joint case is ${results[3]!.minRangeNm.toFixed(4)} NM — ` +
	`${(results[3]!.minRangeNm / row.raDmodNm).toFixed(1)}x the RA DMOD.`)

const silent = results.every((r) => r.ras === 0 && r.tas === 0)
console.log(`\n  ${silent ? "PASS" : "FAIL"} — TCAS is ${silent ? "SILENT" : "NOT silent"} throughout.`)
console.log(silent
	? "  The joint hazard is a CONTROLLER problem. The safety net never sees it."
	: "  The safety net resolves this encounter, which would delete the headline result.")
process.exit(silent ? 0 : 1)
