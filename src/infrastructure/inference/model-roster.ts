import { MIMO_MODEL_NAME, MIMO_PROVIDER } from "./mimo"

/**
 * THE THREE SEATS — and an honest account of what currently distinguishes them.
 *
 * The design called for one seat of final authority per VENDOR: Anthropic sequences the runway,
 * OpenAI protects the climb corridor, Google meters the fix. Remove a vendor and a specific
 * authority goes dark, so no adapter is a checkbox — and, importantly, a peer's objection comes
 * from a genuinely different prior rather than from the same model talking to itself.
 *
 * WE DO NOT HAVE THAT. One endpoint is configured (MiMo, Anthropic-protocol compatible), so all
 * three seats run the same model. What still differs is real: incommensurable OBJECTIVES,
 * different instructions, different standing, and different information. What no longer differs is
 * the prior.
 *
 * The consequence is stated rather than glossed: WHEN FLOW OBJECTS TO APPROACH, THAT IS ONE MODEL
 * DISAGREEING WITH ITSELF UNDER A DIFFERENT BRIEF. It is a real disagreement — the objection is
 * driven by a conflicting objective over contested authority, not by sampling noise — but it is
 * not independent evidence in the way two vendors would be. The claim "objections come from
 * different priors" is WITHDRAWN until a second endpoint exists.
 *
 * `MULTI_VENDOR` below is the machine-checked truth of that, not a comment. It is false, and a
 * test asserts the README says so.
 */
export type Position = "APPROACH" | "DEPARTURE" | "FLOW"

export type Seat = {
	readonly position: Position
	readonly authority: string
	readonly objective: string
	readonly model: string
	readonly provider: string
	/** Reserved for when a second endpoint exists — see the note above. */
	readonly intendedProvider: "anthropic" | "openai" | "google"
	readonly maxOutputTokens: number
}

export const ROSTER: readonly Seat[] = [
	{
		position: "APPROACH", authority: "runway sequencing",
		objective: "Land arrivals in the tightest safe order.",
		model: MIMO_MODEL_NAME, provider: MIMO_PROVIDER, intendedProvider: "anthropic", maxOutputTokens: 2_000,
	},
	{
		position: "DEPARTURE", authority: "climb corridor",
		objective: "Keep the departure corridor clear from the surface up.",
		model: MIMO_MODEL_NAME, provider: MIMO_PROVIDER, intendedProvider: "openai", maxOutputTokens: 2_000,
	},
	{
		position: "FLOW", authority: "metering interval",
		objective: "Hold the metered spacing at the fix, whatever it costs the sequence.",
		model: MIMO_MODEL_NAME, provider: MIMO_PROVIDER, intendedProvider: "google", maxOutputTokens: 2_000,
	},
]

/** FALSE today. The seats share a model; only their objectives and authority differ. */
export const MULTI_VENDOR = new Set(ROSTER.map((s) => s.provider)).size === ROSTER.length

/** TRUE, and it is what actually drives disagreement: the objectives are incommensurable. */
export const OBJECTIVES_ARE_DISTINCT = new Set(ROSTER.map((s) => s.objective)).size === ROSTER.length

/** TRUE: each seat holds a different final authority, so removing one darkens something specific. */
export const AUTHORITIES_ARE_DISTINCT = new Set(ROSTER.map((s) => s.authority)).size === ROSTER.length

export function seatFor(position: Position): Seat {
	const seat = ROSTER.find((s) => s.position === position)
	if (!seat) throw new Error(`no seat for ${position}`)
	return seat
}

/**
 * Resolve a requested effort against what THIS model actually supports.
 *
 * Finding #10: effort vocabularies are not uniform — `claude-sonnet-4-6` has no "none",
 * `claude-haiku-4-5` has no "max", Gemini has "minimal", and MiMo declares none at all. A
 * hardcoded ladder throws the moment a participant moves between models.
 */
export function resolveEffort(
	requested: string,
	spec: { readonly supportsReasoningEffort: boolean; readonly supportedReasoningEfforts: readonly string[] } | undefined,
): string | undefined {
	if (!spec || !spec.supportsReasoningEffort) return undefined
	const supported = spec.supportedReasoningEfforts
	if (supported.includes(requested)) return requested
	const ladder = ["max", "xhigh", "high", "medium", "low", "minimal", "none"]
	for (let i = Math.max(0, ladder.indexOf(requested)); i < ladder.length; i++) {
		if (supported.includes(ladder[i]!)) return ladder[i]
	}
	return supported[supported.length - 1]
}

/** Which endpoints are configured. Missing ones degrade a seat rather than failing the run. */
export function configuredProviders(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
	const out = new Set<string>()
	if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL) out.add(MIMO_PROVIDER)
	else if (env.ANTHROPIC_API_KEY) out.add("anthropic")
	if (env.OPENAI_API_KEY) out.add("openai")
	if (env.GEMINI_API_KEY || env.GOOGLE_API_KEY) out.add("google")
	return out
}
