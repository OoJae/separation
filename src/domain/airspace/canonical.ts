/**
 * Canonical form for anything written to a trace or hashed.
 *
 * Two doubles can be numerically equal yet serialise differently (`-0` prints as `0` via
 * `String` but as `-0` via `JSON.stringify`… and `Object.is(-0, 0)` is false). Since replay
 * compares traces byte-for-byte, every value crossing that boundary is normalised here.
 */

/** Collapse -0 to +0. Everything else passes through untouched. */
export function normaliseZero(value: number): number {
	return value === 0 ? 0 : value
}

/**
 * Exact powers of ten, as literals. `10 ** n` and `Math.pow` are implementation-defined, and
 * this module is not the heading table, so it gets no transcendental exemption.
 */
const POW10 = [1, 10, 100, 1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000] as const

/** Round to `decimals` places for the human-readable trace. Never used inside physics. */
export function quantise(value: number, decimals = 6): number {
	if (!Number.isFinite(value)) return value
	const factor = POW10[decimals]
	if (factor === undefined) throw new Error(`quantise: unsupported precision ${decimals}`)
	return normaliseZero(Math.round(value * factor) / factor)
}

/**
 * FNV-1a over the raw IEEE-754 bits of a number sequence.
 *
 * The quantised trace proves two runs *look* identical; this proves they *are* identical, down
 * to the last bit, with no rounding to hide behind. Both are asserted — a run that passes the
 * first and fails the second has drifted below the print precision, which is exactly the
 * failure mode a quantised diff would miss.
 */
export class StateHash {
	private hash = 0x811c9dc5
	private readonly view = new DataView(new ArrayBuffer(8))

	pushNumber(value: number): void {
		this.view.setFloat64(0, normaliseZero(value))
		for (let i = 0; i < 8; i++) {
			this.hash = Math.imul(this.hash ^ this.view.getUint8(i), 0x01000193)
		}
	}

	pushInt(value: number): void {
		this.hash = Math.imul(this.hash ^ (value | 0), 0x01000193)
	}

	pushString(value: string): void {
		for (let i = 0; i < value.length; i++) {
			this.hash = Math.imul(this.hash ^ value.charCodeAt(i), 0x01000193)
		}
	}

	digest(): string {
		return (this.hash >>> 0).toString(16).padStart(8, "0")
	}
}
