/**
 * How long a controller takes to decide.
 *
 * This lives in the DOMAIN, not in infrastructure, because it is a fact about the system being
 * modelled rather than about how we happen to run it. The theorem's admissible band is derived
 * from these numbers, so they are load-bearing rather than incidental.
 *
 * Modelled as eleven integer deciles with integer interpolation: no Math.log, no Math.exp, no
 * Box-Muller. A lognormal would have needed all three, and the transcendental ban applies here
 * too. Sampling a checked-in empirical shape is also more honest than asserting a parametric
 * family we have not measured.
 *
 * CHOSEN, pending Phase 4 replacing them with timings measured from real providers.
 */
export const ROUND_MS_DECILES = [1_100, 1_250, 1_400, 1_550, 1_720, 1_900, 2_150, 2_500, 3_000, 3_700, 4_500] as const

/** A controller turn is two rounds: probe the feasible set, then commit. */
export const ROUNDS_PER_TURN = 2

export const MIN_ROUND_MS: number = ROUND_MS_DECILES[0]
export const MAX_ROUND_MS: number = ROUND_MS_DECILES[ROUND_MS_DECILES.length - 1]! - 1

export const MIN_TURN_MS = MIN_ROUND_MS * ROUNDS_PER_TURN
export const MAX_TURN_MS = MAX_ROUND_MS * ROUNDS_PER_TURN
