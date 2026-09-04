import { supportedModels } from "@mozaik-ai/core"

/**
 * ONE SEAT OF FINAL AUTHORITY PER VENDOR.
 *
 * Anthropic sequences the runway. OpenAI protects the climb corridor. Google meters the fix.
 * Remove any vendor and a specific authority goes dark — so no adapter is a checkbox, and the
 * "four inference dialects on one bus" claim is load-bearing rather than decorative.
 *
 * A second reason it matters: a peer objection from a DIFFERENT prior is not self-agreement.
 * Two seats on the same vendor could be one model talking to itself.
 */
export type Position = "APPROACH" | "DEPARTURE" | "FLOW"

export type Seat = {
	readonly position: Position
	readonly authority: string
	readonly model: string
	readonly provider: string
	readonly requestedEffort: "high" | "medium" | "low"
	readonly maxOutputTokens: number
}

export const ROSTER: readonly Seat[] = [
	{ position: "APPROACH", authority: "runway sequencing", model: "claude-opus-4-8", provider: "anthropic", requestedEffort: "high", maxOutputTokens: 1_200 },
	{ position: "DEPARTURE", authority: "climb corridor", model: "gpt-5.5", provider: "openai", requestedEffort: "high", maxOutputTokens: 1_200 },
	{ position: "FLOW", authority: "metering interval", model: "gemini-3.1-pro-preview", provider: "google", requestedEffort: "high", maxOutputTokens: 1_200 },
]

export function seatFor(position: Position): Seat {
	const seat = ROSTER.find((s) => s.position === position)
	if (!seat) throw new Error(`no seat for ${position}`)
	return seat
}

/**
 * Resolve a requested effort against what THIS model actually supports.
 *
 * Finding #10: the effort vocabularies are not uniform. `claude-sonnet-4-6` has no "none",
 * `claude-haiku-4-5` has no "max", Gemini has "minimal". A hardcoded ladder throws the moment a
 * participant moves between models, so the literal is read off the shipped spec at call time.
 */
export function resolveEffort(model: string, requested: string): string | undefined {
	const spec = supportedModels.find((m) => m.specification.name === model)?.specification
	if (!spec || !spec.supportsReasoningEffort) return undefined
	const supported = spec.supportedReasoningEfforts
	if (supported.includes(requested)) return requested
	// Fall back to the nearest supported rung rather than throwing.
	const ladder = ["max", "xhigh", "high", "medium", "low", "minimal", "none"]
	const start = ladder.indexOf(requested)
	for (let i = start; i < ladder.length; i++) {
		const rung = ladder[i]!
		if (supported.includes(rung)) return rung
	}
	return supported[supported.length - 1]
}

/** Which vendor keys are present. Missing ones degrade that seat rather than failing the run. */
export function availableProviders(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
	const out = new Set<string>()
	if (env.ANTHROPIC_API_KEY) out.add("anthropic")
	if (env.OPENAI_API_KEY) out.add("openai")
	if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) out.add("google")
	return out
}

/** Every seat is a different vendor. Asserted by test — this is the invariant. */
export function vendorsAreDistinct(): boolean {
	return new Set(ROSTER.map((s) => s.provider)).size === ROSTER.length
}
