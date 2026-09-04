/**
 * Deterministic PRNG. `Math.random()` is banned everywhere in `src/`.
 *
 * sfc32 — small, fast, passes PractRand, and uses only uint32 operations, so it is
 * bit-identical on every platform. Seeded from a string so scenarios are named, not numbered.
 */
export class Rng {
	private a: number
	private b: number
	private c: number
	private d: number

	private constructor(a: number, b: number, c: number, d: number) {
		this.a = a >>> 0
		this.b = b >>> 0
		this.c = c >>> 0
		this.d = d >>> 0
	}

	static fromSeed(seed: string): Rng {
		// FNV-1a over the seed, four times with different offsets, so the state is well mixed.
		let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b
		for (let i = 0; i < seed.length; i++) {
			const c = seed.charCodeAt(i)
			h1 = Math.imul(h1 ^ c, 0x01000193)
			h2 = Math.imul(h2 ^ c, 0x85ebca6b)
			h3 = Math.imul(h3 ^ c, 0xc2b2ae35)
			h4 = Math.imul(h4 ^ c, 0x27d4eb2f)
		}
		const rng = new Rng(h1, h2, h3, h4)
		for (let i = 0; i < 12; i++) rng.nextUint32() // discard the warm-up
		return rng
	}

	nextUint32(): number {
		const t = (this.a + this.b | 0) + this.d | 0
		this.d = this.d + 1 | 0
		this.a = this.b ^ (this.b >>> 9)
		this.b = this.c + (this.c << 3) | 0
		this.c = (this.c << 21) | (this.c >>> 11)
		this.c = this.c + t | 0
		return t >>> 0
	}

	/** Uniform in [0, 1). Exact: a uint32 divided by 2^32 is representable. */
	nextFloat(): number {
		return this.nextUint32() / 4294967296
	}

	/** Uniform integer in [lo, hi] inclusive. Rejection-free modulo bias is acceptable here. */
	nextInt(lo: number, hi: number): number {
		return lo + (this.nextUint32() % (hi - lo + 1))
	}

	/** Uniform pick, biased-free enough for scenario jitter. */
	pick<T>(items: readonly T[]): T {
		if (items.length === 0) throw new Error("pick() from an empty array")
		return items[this.nextUint32() % items.length]!
	}
}
