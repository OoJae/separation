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
import { ROSTER, availableProviders, resolveEffort } from "../src/infrastructure/inference/model-roster"
import { SystemClock } from "../src/support/ports"

const calls = Number(process.argv.find((a) => a.startsWith("--calls="))?.split("=")[1] ?? 6)
const available = availableProviders()
const seats = ROSTER.filter((s) => available.has(s.provider))

if (seats.length === 0) {
	console.log("No provider keys found. Add ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY to .env.")
	process.exit(2)
}

const runner = new LiveInferenceRunner({
	scripted: () => { throw new Error("unreachable") },
	isSynthetic: () => false,
	cache: new InferenceCache("traces/latency-cache.jsonl"),
	budget: new BudgetGuard(calls),
	clock: new SystemClock(),
	measure: () => performance.now(),
})

const PROMPT = `You are an approach controller. AAL221 is at 9000 ft descending, SWA455 at 6000 ft, converging.
In two sentences, state which aircraft you would move first and why. Do not call any tool.`

console.log(`Measuring ${calls} live rounds across ${seats.map((s) => s.provider).join(", ")}\n`)
const latencies: number[] = []
for (let i = 0; i < calls; i++) {
	const seat = seats[i % seats.length]!
	const spec = supportedModels.find((m) => m.specification.name === seat.model)
	if (!spec) { console.log(`  ${seat.model}: not in supportedModels`); continue }
	const started = performance.now()
	await runner.run({
		model: seat.model,
		reasoningEffort: resolveEffort(seat.model, "low"),
		maxOutputTokens: 200,
		context: new ModelContext(`m${i}`, [UserMessageItem.create(`${PROMPT} (round ${i})`)]),
		tools: [],
	})
	const ms = Math.round(performance.now() - started)
	latencies.push(ms)
	console.log(`  ${seat.provider.padEnd(10)} ${seat.model.padEnd(24)} ${String(ms).padStart(6)} ms`)
}

latencies.sort((a, b) => a - b)
const band = admissibleBandMs()
const min = latencies[0]!, max = latencies[latencies.length - 1]!
console.log(`\n  measured one-round latency: [${min}, ${max}] ms  (n=${latencies.length})`)
console.log(`  assumed deciles:            [${MIN_ROUND_MS}, ${MAX_ROUND_MS}] ms`)
console.log(`  deciles: ${ROUND_MS_DECILES.join(", ")}`)

const inside = min >= MIN_ROUND_MS && max <= MAX_ROUND_MS
console.log(`\n  ${inside ? "PASS" : "TRIPWIRE"} — measured latency ${inside ? "fits" : "does NOT fit"} the assumed distribution`)
if (!inside) {
	console.log(`  The admissible band (${band.lowerMs}, ${band.upperMs}) ms was derived from the assumed`)
	console.log(`  deciles. Re-derive ROUND_MS_DECILES from these measurements, then re-derive the`)
	console.log(`  gates in src/scenarios/braid-2.ts. Do NOT clamp the distribution to fit.`)
}
process.exit(inside ? 0 : 1)
