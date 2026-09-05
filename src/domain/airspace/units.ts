/**
 * Units. Every quantity that accumulates over time is an INTEGER, because floating-point
 * accumulation drifts and the whole replay guarantee rests on it not drifting.
 *
 * Measured, and the reason these are integers:
 *   sum(0.02, 20000 times)                       = 399.99999999992616   (not 400)
 *   1500 ticks of 0.06 degrees added from 090.0  = 180.00000000000341   (not 180)
 *
 * So: time is an integer tick count, heading is integer milli-degrees, and fuel is integer
 * milligrams. Position and altitude stay double — no integer unit makes 250 kt or 2000 fpm an
 * exact per-tick delta — but neither of them accumulates a *rate that was itself derived from
 * an angle*, which is where the drift above comes from.
 */

/** Simulation time, in 10 ms master ticks. `tickToSeconds` is computed fresh, never accumulated. */
export type Tick = number

/** Heading, integer milli-degrees, always normalised to [0, 360000). */
export type Mdeg = number

export const MASTER_TICK_MS = 10
export const TICKS_PER_SECOND = 100

/** Integrate at 50 Hz — every 2nd master tick. */
export const INTEGRATE_EVERY = 2
/** Pair-closure telemetry and the reflex layer at 20 Hz — every 5th. */
export const CLOSURE_EVERY = 5
/** World snapshot to planners at 1 Hz — every 100th. */
export const SNAPSHOT_EVERY = 100

export const INTEGRATE_DT_S = 0.02

export const MDEG_PER_REV = 360_000
/** The heading table's resolution. 3000 mdeg/s x 20 ms = exactly 60 mdeg/tick, a multiple of 20. */
export const MDEG_GRID = 20
export const HEADING_TABLE_SIZE = MDEG_PER_REV / MDEG_GRID // 18000

/** Standard rate turn, ICAO: 3 degrees per second. */
export const TURN_RATE_MDEG_PER_S = 3_000
/**
 * An expedited turn — twice standard rate. Steeper bank, so a higher load factor, but it reaches
 * the new heading sooner and therefore costs fewer track miles.
 *
 * DETERMINISM RULE: a turn rate is only admissible if `rate * INTEGRATE_DT_S` is a whole number of
 * milli-degrees, so the aircraft lands exactly on its target on a determinate tick with no residue.
 * 3000 -> exactly 60, 6000 -> exactly 120. `isAdmissibleTurnRate` enforces it and
 * tests/world/integrator.test.ts asserts it for every rate the catalogue can produce.
 */
export const EXPEDITE_TURN_RATE_MDEG_PER_S = 6_000

/** Does this turn rate divide the integration step exactly? See EXPEDITE_TURN_RATE_MDEG_PER_S. */
export function isAdmissibleTurnRate(rateMdegPerS: number): boolean {
	const step = rateMdegPerS * INTEGRATE_DT_S
	return Number.isInteger(step) && step > 0
}

/** Knots to NM per second. 250 kt = 0.0694444... NM/s */
export const KT_TO_NM_PER_S = 1 / 3600
/** Knots to metres per second (1 NM = 1852 m exactly, by definition). */
export const KT_TO_M_PER_S = 1852 / 3600
/** Standard gravity, m/s^2 — CGPM 1901, exact by definition. */
export const G_M_PER_S2 = 9.80665
/** Degrees to radians. A CONSTANT, not a call: Math.PI is a number, and the ban is on functions. */
export const DEG_TO_RAD = Math.PI / 180
/** Feet per minute to feet per second. */
export const FPM_TO_FPS = 1 / 60

export function tickToSeconds(tick: Tick): number {
	return tick * (MASTER_TICK_MS / 1000)
}

export function secondsToTick(seconds: number): Tick {
	return Math.round(seconds * TICKS_PER_SECOND)
}

/** Normalise any milli-degree value into [0, 360000). Integer in, integer out. */
export function normaliseMdeg(mdeg: Mdeg): Mdeg {
	const wrapped = mdeg % MDEG_PER_REV
	return wrapped < 0 ? wrapped + MDEG_PER_REV : wrapped
}

/** Signed shortest angular difference from `from` to `to`, in (-180000, +180000]. */
export function mdegDelta(from: Mdeg, to: Mdeg): number {
	const raw = normaliseMdeg(to) - normaliseMdeg(from)
	if (raw > MDEG_PER_REV / 2) return raw - MDEG_PER_REV
	if (raw <= -MDEG_PER_REV / 2) return raw + MDEG_PER_REV
	return raw
}

export function degreesToMdeg(degrees: number): Mdeg {
	return normaliseMdeg(Math.round(degrees * 1000))
}
