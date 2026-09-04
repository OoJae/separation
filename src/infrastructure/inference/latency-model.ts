import type { Rng } from "../../support/rng"
import {
	MAX_TURN_MS, MIN_TURN_MS, ROUND_MS_DECILES, ROUNDS_PER_TURN,
} from "../../domain/interlock/decision-latency"

/**
 * DRAWING from the controller-latency model.
 *
 * The constants themselves live in `src/domain/interlock/decision-latency.ts` — they are a fact
 * about the modelled world, and the theorem's admissible band is derived from them. This module
 * only knows how to sample them.
 */
export { MAX_TURN_MS, MIN_TURN_MS, ROUND_MS_DECILES, ROUNDS_PER_TURN }

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
