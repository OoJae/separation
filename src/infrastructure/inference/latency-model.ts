import type { Rng } from "../../support/rng"

/**
 * Controller decision latency, modelled as DATA rather than as a distribution.
 *
 * Eleven integer deciles with integer linear interpolation between them. No `Math.log`, no
 * `Math.exp`, no Box-Muller — the transcendental ban applies here too, and a lognormal would have
 * needed all three. Sampling a checked-in empirical shape is also more honest than asserting a
 * parametric family we have not measured.
 *
 * CHOSEN, pending Phase 4 replacing them with timings measured from real providers.
 */
export const ROUND_MS_DECILES = [1_100, 1_250, 1_400, 1_550, 1_720, 1_900, 2_150, 2_500, 3_000, 3_700, 4_500] as const

/** A controller turn is two rounds: probe, then commit. */
export const ROUNDS_PER_TURN = 2

export function drawRoundMs(rng: Rng): number {
	const u = rng.nextInt(0, 9_999)
	const bucket = Math.floor(u / 1_000)
	const fraction = u % 1_000
	const lo = ROUND_MS_DECILES[bucket]!
	const hi = ROUND_MS_DECILES[bucket + 1]!
	return lo + Math.floor(((hi - lo) * fraction) / 1_000)
}

export function drawTurnMs(rng: Rng): number {
	let total = 0
	for (let i = 0; i < ROUNDS_PER_TURN; i++) total += drawRoundMs(rng)
	return total
}

export const MIN_TURN_MS = ROUND_MS_DECILES[0]! * ROUNDS_PER_TURN
export const MAX_TURN_MS = (ROUND_MS_DECILES[ROUND_MS_DECILES.length - 1]! - 1) * ROUNDS_PER_TURN
