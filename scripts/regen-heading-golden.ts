/**
 * Regenerates src/domain/airspace/heading-table.golden.ts.
 * Run ONLY when you intend to change the heading table itself.
 */
import { writeFileSync } from "node:fs"
import { tableEntry } from "../src/domain/airspace/heading-table"
import { HEADING_TABLE_SIZE, MDEG_GRID } from "../src/domain/airspace/units"

const STEP = 25 // every 25th entry = 500 mdeg = 0.5 degrees -> 720 triples
const rows: string[] = []
for (let i = 0; i < HEADING_TABLE_SIZE; i += STEP) {
	const { east, north } = tableEntry(i)
	rows.push(`\t[${i * MDEG_GRID}, ${east}, ${north}],`)
}

const out = `/**
 * Golden vectors for the heading table — ${rows.length} (mdeg, east, north) triples, one every 0.5 degrees.
 *
 * Generated once on Node v26 / V8, checked in, and asserted with Object.is by
 * tests/world/heading-table.test.ts. IEEE-754 does not mandate correct rounding for Math.sin or
 * Math.cos, so a different engine or version is entitled to differ in the last bit. If that ever
 * happens, this test fails LOUDLY instead of letting a run diverge in silence.
 *
 * Regenerate only when you intend to change the table:  npx tsx scripts/regen-heading-golden.ts
 */
export const HEADING_GOLDEN: readonly (readonly [number, number, number])[] = [
${rows.join("\n")}
]
`
writeFileSync("src/domain/airspace/heading-table.golden.ts", out)
console.log(`wrote ${rows.length} golden triples`)
