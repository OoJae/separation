/**
 * THE TRIPWIRE. Runs N live controller turns, records the real latency distribution, and
 * compares it to the assumed deciles the admissible band was derived from.
 *
 * If reality falls outside the assumption, the band shifts and the gates must be RE-DERIVED from
 * measured timings — never clamped to fit. The Phase 3 theorem test already fails loudly in that
 * case; this script tells you why, before you get there.
 *
 * Live: needs keys in .env. Bounded by --calls (default 6) so a run costs cents.
 */
import "dotenv/config"
import { ModelContext, UserMessageItem, supportedModels } from "@mozaik-ai/core"
import { admissibleBandMs } from "../src/domain/interlock/band"
import { MAX_ROUND_MS, MIN_ROUND_MS, ROUND_MS_DECILES } from "../src/domain/interlock/decision-latency"
import { BudgetGuard } from "../src/infrastructure/inference/budget-guard"
import { InferenceCache } from "../src/infrastructure/inference/inference-cache"
import { LiveInferenceRunner } from "../src/infrastructure/inference/live-runner"
import { mimoFromEnv } from "../src/infrastructure/inference/mimo"
import { SystemClock } from "../src/support/ports"

const calls = Number(process.argv.find((a) => a.startsWith("--calls="))?.split("=")[1] ?? 10)

const mimo = mimoFromEnv()
if (mimo === null) {
	console.log("No model configured. Set ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL in .env.")
	process.exit(2)
}

const runner = new LiveInferenceRunner({
	scripted: () => { throw new Error("unreachable") },
	isSynthetic: () => false,
	cache: new InferenceCache(null), // measuring latency: a cache hit would report 0ms
	budget: new BudgetGuard(calls),
	clock: new SystemClock(),
	measure: () => performance.now(),
	extraModels: [mimo],
})

const PROMPT = `You are an approach controller in a busy TRACON sector.
AAL221 is at 9000 ft descending toward the runway; SWA455 is at 6000 ft climbing on a converging
track. Both are at 250 knots. In two sentences, say which aircraft you would move first and why.`

console.log(`Measuring ${calls} live rounds against ${mimo.specification.name}\n`)
const latencies: number[] = []
for (let i = 0; i < calls; i++) {
	const started = performance.now()
	await runner.run({
		model: mimo.specification.name,
		maxOutputTokens: 400,
		context: new ModelContext(`m${i}`, [UserMessageItem.create(`${PROMPT} (scenario variant ${i})`)]),
		tools: [],
	})
	const ms = Math.round(performance.now() - started)
	latencies.push(ms)
	console.log(`  round ${String(i + 1).padStart(2)}: ${String(ms).padStart(6)} ms`)
}

latencies.sort((a, b) => a - b)
const band = admissibleBandMs()
const min = latencies[0]!
const max = latencies[latencies.length - 1]!
const pct = (p: number) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))]!

console.log(`\n  measured: [${min}, ${max}] ms   p50 ${pct(50)}   p90 ${pct(90)}   n=${latencies.length}`)
console.log(`  assumed:  [${MIN_ROUND_MS}, ${MAX_ROUND_MS}] ms`)

const inside = min >= MIN_ROUND_MS && max <= MAX_ROUND_MS
console.log(`\n  ${inside ? "PASS" : "TRIPWIRE FIRED"} — measured latency ${inside ? "fits" : "does NOT fit"} the assumed distribution`)

if (!inside) {
	// Build honest deciles from the measurement, by linear interpolation over the sorted sample.
	const deciles: number[] = []
	for (let d = 0; d <= 10; d++) {
		const pos = (d / 10) * (latencies.length - 1)
		const lo = Math.floor(pos), hi = Math.ceil(pos)
		deciles.push(Math.round(latencies[lo]! + (latencies[hi]! - latencies[lo]!) * (pos - lo)))
	}
	const minTurn = deciles[0]! * 2
	const maxTurn = (deciles[10]! - 1) * 2
	const newUpper = minTurn + 8_000 + minTurn
	console.log(`\n  The admissible band was derived from the ASSUMED deciles. Re-derive, do not clamp.\n`)
	console.log(`  measured deciles:  [${deciles.join(", ")}]`)
	console.log(`  turn (2 rounds):   [${minTurn}, ${maxTurn}] ms`)
	console.log(`  old band:          (${band.lowerMs}, ${band.upperMs}) ms   width ${band.widthMs}`)
	console.log(`  NEW band:          (${maxTurn}, ${newUpper}) ms   width ${newUpper - maxTurn}`)

	const V = 250 / 3600
	const gate = (durationS: number, windowMs: number) => ((windowMs / 1000 + durationS + 13) * V).toFixed(4)
	console.log(`\n  re-derived gate ranges:`)
	console.log(`    BAYLR (A, 150.00s manoeuvre): [${gate(150, maxTurn)}, ${gate(150, newUpper)}] NM`)
	console.log(`    CARDL (B,  31.93s manoeuvre): [${gate(31.93, maxTurn)}, ${gate(31.93, newUpper)}] NM`)
}
process.exit(inside ? 0 : 1)
