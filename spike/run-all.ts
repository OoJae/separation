/**
 * Phase 0 spike runner. Regenerates spike/RESULTS.md.
 *
 * Every assertion here runs with NO network and NO API key. This is the artifact that
 * says: we verified against the shipped package, not against the docs.
 */
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"

const SPIKES = [
	["00-imports.ts", "Export surface + model registry of @mozaik-ai/core@4.0.5"],
	["01-rewrite-readback.ts", "UNKNOWN (a)+(b): custom runner multiplex, and a peer's objection landing as rewritten function_call args inside a still-open turn"],
	["02-cancellation.ts", "Can an InterceptionHandler halt a turn? (corrected finding + the honest alternative)"],
	["03-abort.ts", "UNKNOWN (c): aborting a streaming turn mid-generation without killing the process"],
]

const out: string[] = [
	"# Phase 0 — spike results",
	"",
	"Regenerate with `npm run spike`. Every assertion below runs with **no network and no API key**.",
	"",
	`Package under test: \`@mozaik-ai/core@4.0.5\`  ·  Node \`${process.version}\``,
	"",
]

let failed = 0
for (const [file, desc] of SPIKES) {
	let stdout = "", ok = true
	try {
		stdout = execFileSync("npx", ["tsx", `spike/${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
	} catch (e: any) {
		stdout = (e.stdout ?? "") + (e.stderr ?? ""); ok = false; failed++
	}
	const clean = stdout.split("\n").filter(l => !l.includes("mozaik cloud:")).join("\n").trim()
	out.push(`## \`${file}\` — ${ok ? "PASS" : "FAIL"}`, "", `_${desc}_`, "", "```", clean, "```", "")
	console.log(`${ok ? "✓" : "✗"} ${file}`)
}

writeFileSync("spike/RESULTS.md", out.join("\n"))
console.log(`\nwrote spike/RESULTS.md — ${SPIKES.length - failed}/${SPIKES.length} passing`)
process.exit(failed ? 1 : 0)
