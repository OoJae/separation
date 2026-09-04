/**
 * Runs the whole scenario twice and proves the two runs are identical.
 *
 * Two witnesses, deliberately. The quantised trace is what a human can read; the raw-bit state
 * hash catches drift below print precision, which a quantised diff would silently pass.
 */
import { runScenario, SCENARIOS } from "../src/main"

let failures = 0
console.log("Determinism: same scenario, twice.\n")
console.log("  arm        ticks  events  stateHash  identical")
console.log("  " + "-".repeat(52))

for (const [name, clearances] of Object.entries(SCENARIOS)) {
	const first = runScenario({ clearances })
	const second = runScenario({ clearances })
	const traceMatch = JSON.stringify(first.trace) === JSON.stringify(second.trace)
	const hashMatch = first.stateHash === second.stateHash
	const ok = traceMatch && hashMatch
	if (!ok) failures++
	console.log(
		`  ${name.padEnd(10)} ${String(first.ticks).padStart(5)}  ${String(first.events).padStart(6)}  ` +
		`${first.stateHash}   ${ok ? "yes" : `NO (trace=${traceMatch} hash=${hashMatch})`}`,
	)
}

console.log(`\n  ${failures === 0 ? "PASS" : "FAIL"} — ${Object.keys(SCENARIOS).length - failures}/${Object.keys(SCENARIOS).length} arms reproduce exactly`)
process.exit(failures === 0 ? 0 : 1)
