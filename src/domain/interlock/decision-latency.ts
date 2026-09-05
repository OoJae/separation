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
 * MEASURED, 2026-09-05, against mimo-v2.5-pro over the Anthropic-compatible endpoint.
 * `npm run measure:latency` regenerates these; `scripts/measure-latency.ts` is the tripwire.
 *
 * These REPLACE an earlier assumed set of [1100 .. 4499] ms. The tripwire fired on the first live
 * run: real rounds are roughly 3x slower than assumed. We re-derived the distribution and the
 * gates from the measurement rather than clamping the measurement to fit the gates.
 *
 * The correction made the theorem MORE robust, not less. Because a serialized decision pays two
 * full turns plus the radio, a slower model widens the gap between "one turn" and "two turns plus
 * 8 s of readback": the admissible band went from 3402 ms wide to 18 552 ms, and the tolerance on
 * gate placement went from +-0.12 NM to +-0.64 NM.
 *
 * Sample size is n=10, which is honest but small. The deciles are an empirical shape, not a
 * fitted distribution, and the tripwire re-checks them on every measured run.
 */
export const ROUND_MS_DECILES = [11_283, 12_196, 12_356, 12_512, 12_589, 12_900, 13_217, 13_848, 15_453, 16_322, 17_291] as const

/** A controller turn is two rounds: probe the feasible set, then commit. */
export const ROUNDS_PER_TURN = 2

export const MIN_ROUND_MS: number = ROUND_MS_DECILES[0]
export const MAX_ROUND_MS: number = ROUND_MS_DECILES[ROUND_MS_DECILES.length - 1]! - 1

export const MIN_TURN_MS = MIN_ROUND_MS * ROUNDS_PER_TURN
export const MAX_TURN_MS = MAX_ROUND_MS * ROUNDS_PER_TURN
