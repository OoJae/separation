import { HEADING_TABLE_SIZE, MDEG_GRID, MDEG_PER_REV, normaliseMdeg, type Mdeg } from "./units"

/**
 * THE ONLY PLACE IN `src/` THAT EVALUATES A TRANSCENDENTAL.
 *
 * IEEE-754 mandates correct rounding for + - * / and sqrt, so those are bit-identical on every
 * platform. It mandates NOTHING for sin/cos/tan/atan2/pow/exp/log — those are
 * implementation-defined and may differ in the last bit between engines or versions. Measured
 * on this machine: Math.sin(1) = 0x3feaed548f090cee. Another V8 build is entitled to disagree.
 *
 * So the whole physics hot path uses only arithmetic and sqrt, and every heading is looked up
 * here instead of computed. The table is built ONCE at module load on a 20 mdeg grid — which is
 * exact for both the per-tick turn increment (3000 mdeg/s x 20 ms = 60 mdeg) and for
 * whole-degree clearance targets (1000 mdeg).
 *
 * We cannot GUARANTEE cross-version byte-identity. We can DETECT its loss: 720 golden triples
 * are checked in and asserted with Object.is, so a platform whose Math.sin differs fails the
 * suite loudly instead of producing a quietly divergent run. That is the honest form of the
 * claim, and it is what the README says.
 *
 * Aviation convention: heading 0 is North. x is East, y is North.
 *   east  = sin(heading)
 *   north = cos(heading)
 */

const east = new Float64Array(HEADING_TABLE_SIZE)
const north = new Float64Array(HEADING_TABLE_SIZE)

for (let i = 0; i < HEADING_TABLE_SIZE; i++) {
	const radians = (i * MDEG_GRID * Math.PI) / (MDEG_PER_REV / 2)
	east[i] = Math.sin(radians)
	north[i] = Math.cos(radians)
}

// Snap the four cardinals. Math.cos(PI/2) is 6.12e-17, not 0: a due-east heading would carry a
// spurious northward component, and -0 would leak into downstream arithmetic. A cardinal heading
// has exactly zero component on the other axis, so we say so rather than inheriting the residue.
const CARDINALS: readonly [number, number, number][] = [
	[0, 0, 1],
	[MDEG_PER_REV / 4 / MDEG_GRID, 1, 0],
	[MDEG_PER_REV / 2 / MDEG_GRID, 0, -1],
	[(3 * MDEG_PER_REV) / 4 / MDEG_GRID, -1, 0],
]
for (const [index, e, n] of CARDINALS) {
	east[index] = e
	north[index] = n
}

function indexOf(mdeg: Mdeg): number {
	const normalised = normaliseMdeg(mdeg)
	if (normalised % MDEG_GRID !== 0) {
		throw new Error(`heading ${mdeg} mdeg is off the ${MDEG_GRID} mdeg grid — headings must stay on grid`)
	}
	return normalised / MDEG_GRID
}

/** East (x) component of a unit heading vector. */
export function eastOf(mdeg: Mdeg): number {
	return east[indexOf(mdeg)]!
}

/** North (y) component of a unit heading vector. */
export function northOf(mdeg: Mdeg): number {
	return north[indexOf(mdeg)]!
}

export function unitVector(mdeg: Mdeg): { readonly east: number; readonly north: number } {
	const i = indexOf(mdeg)
	return { east: east[i]!, north: north[i]! }
}

/** Exposed for the golden-vector test and for regenerating `heading-table.golden.ts`. */
export function tableEntry(index: number): { readonly east: number; readonly north: number } {
	return { east: east[index]!, north: north[index]! }
}
