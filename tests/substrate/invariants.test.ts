import { describe, expect, it } from "@rstest/core"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { HEADING_TABLE_SIZE } from "../../src/domain/airspace/units"

function sourceFiles(dir: string): string[] {
	const out: string[] = []
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry)
		if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
		else if (entry.endsWith(".ts")) out.push(path)
	}
	return out
}

const FILES = sourceFiles("src")
const read = (path: string) => readFileSync(path, "utf8")
/** Strip comments so documentation about a banned pattern isn't mistaken for a use of it. */
const code = (path: string) =>
	read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("repo invariants (machine-checked, not asserted in prose)", () => {
	it("finds the source tree", () => {
		expect(FILES.length).toBeGreaterThan(8)
	})

	/**
	 * Determinism (docs/API-NOTES.md #9). `SemanticEvent.create` stamps `new Date()`
	 * internally, so replay requires the public constructor with injected clock time.
	 * The Clock adapters in support/ports.ts are the ONE place wall time may be read.
	 */
	it("nothing outside the clock adapter reads wall-clock time", () => {
		const offenders: string[] = []
		for (const file of FILES) {
			if (file === join("src", "support", "ports.ts")) continue
			const body = code(file)
			for (const pattern of ["Date.now(", "new Date(", "performance.now(", "SemanticEvent.create"]) {
				if (body.includes(pattern)) offenders.push(`${file}: ${pattern}`)
			}
		}
		expect(offenders).toEqual([])
	})

	/**
	 * One write path. `VersionedCell` can only be mutated by whoever holds the SWAP symbol,
	 * and only cas-write.ts may import it — so "there is exactly one mutation path for shared
	 * state" is verifiable with a grep rather than trusted.
	 */
	it("only cas-write.ts imports the SWAP symbol", () => {
		const allowed = new Set([
			join("src", "state", "cas-write.ts"),
			join("src", "domain", "cell", "swap.ts"),
			join("src", "domain", "cell", "versioned-cell.ts"),
		])
		const offenders = FILES.filter((f) => !allowed.has(f) && /\bSWAP\b/.test(code(f)))
		expect(offenders).toEqual([])
	})

	/**
	 * THE DETERMINISM BAN. IEEE-754 mandates correct rounding for + - * / and sqrt, so those are
	 * bit-identical everywhere. It mandates nothing for the transcendentals, so a different engine
	 * or version may differ in the last bit. The physics hot path therefore uses arithmetic and
	 * sqrt only, and every angle is a table lookup.
	 *
	 * This test must exist BEFORE the first geometry file, not after — that is the difference
	 * between a determinism claim that is provable and one that is retrofitted.
	 */
	it("no transcendental is evaluated at runtime outside the heading table", () => {
		const BANNED = [
			"Math.sin", "Math.cos", "Math.tan", "Math.asin", "Math.acos", "Math.atan",
			"Math.atan2", "Math.hypot", "Math.pow", "Math.exp", "Math.log", "Math.log2",
			"Math.log10", "Math.log1p", "Math.expm1", "Math.cbrt", "Math.sinh", "Math.cosh",
			"Math.tanh", "Math.random",
		]
		const EXEMPT = join("src", "domain", "airspace", "heading-table.ts")

		const offenders: string[] = []
		for (const file of FILES) {
			if (file === EXEMPT) continue
			const body = code(file)
			for (const banned of BANNED) if (body.includes(banned)) offenders.push(`${file}: ${banned}`)
			// The ** operator shares Math.pow's implementation-defined semantics. Comments are
			// already stripped by code(), so a JSDoc opener cannot false-positive here.
			if (/[^*]\*\*[^*]/.test(body)) offenders.push(`${file}: ** operator`)
		}
		expect(offenders).toEqual([])
	})

	it("the heading table is the single exemption, and it is genuinely used", () => {
		const table = read(join("src", "domain", "airspace", "heading-table.ts"))
		expect(table).toContain("Math.sin")
		expect(table).toContain("Math.cos")
		expect(HEADING_TABLE_SIZE).toBe(18_000)
	})

	it("nothing reads Math.random — scenarios draw from the seeded Rng", () => {
		expect(FILES.filter((f) => code(f).includes("Math.random"))).toEqual([])
	})

	/**
	 * THE THIN-AGENCY INVARIANT.
	 *
	 * "What did the language models decide that a solver could not?" is the most dangerous
	 * question this project faces. The answer is that the feasibility layer emits genuinely
	 * unrankable option sets — and that has to be a fact about the code, not a promise in a
	 * README. If any of these words appear, a solver could take an argmax and the models would
	 * be decorative.
	 */
	it("the feasibility layer contains no ranking vocabulary whatsoever", () => {
		const BANNED = ["score", "rank", "best", "recommended", "utility", "sortKey", "preference", "priority"]
		const offenders: string[] = []
		for (const file of FILES) {
			if (!file.startsWith(join("src", "domain", "feasibility"))) continue
			const body = code(file)
			for (const word of BANNED) {
				if (new RegExp(`\\b${word}`, "i").test(body)) offenders.push(`${file}: ${word}`)
			}
		}
		expect(offenders).toEqual([])
	})

	/**
	 * The decisive information — fuel state, a deteriorating passenger, a crew duty limit — is
	 * private to the aircraft and obtainable only by asking, in natural language, while the clock
	 * runs. That must be STRUCTURAL. If the prober could import a PilotSheet, the whole argument
	 * would collapse into "we politely chose not to look".
	 */
	it("nothing in the feasibility layer can reach a PilotSheet", () => {
		/**
		 * The token list used to be ["PilotSheet", "private-sheet", "participants/pilot"], and it
		 * caught none of the routes that actually exist. There is no file called `private-sheet`
		 * anywhere in the repo, and the two real doors — `../disclosure/pilot-sheet` for
		 * `refusalFor`, and `../../scenarios/pilot-sheets` for `sheetFor` and `PILOT_SHEETS` —
		 * matched nothing on the list. An auditor imported the sheet straight into the prober and
		 * this test stayed green. A ban that a one-line import walks through is not machine-checked,
		 * it is decorative, and this one was load-bearing for the whole thin-agency answer.
		 *
		 * Now it bans the MODULES by path and the symbols by name, so both doors are shut.
		 */
		const FORBIDDEN_MODULES = [/pilot-sheet/i, /participants\/pilot/i, /disclosure\//i]
		const FORBIDDEN_SYMBOLS = [
			"PilotSheet", "PilotConstraint", "RefusalRule", "refusalFor",
			"sheetFor", "PILOT_SHEETS", "reportedFuelMg", "wantsShortestPath",
		]
		const offenders: string[] = []
		for (const file of FILES) {
			if (!file.startsWith(join("src", "domain", "feasibility"))) continue
			const body = code(file)
			for (const spec of body.matchAll(/from\s+["']([^"']+)["']/g)) {
				const module = spec[1]!
				if (FORBIDDEN_MODULES.some((re) => re.test(module))) offenders.push(`${file}: imports ${module}`)
			}
			for (const symbol of FORBIDDEN_SYMBOLS) {
				if (new RegExp(`\\b${symbol}\\b`).test(body)) offenders.push(`${file}: names ${symbol}`)
			}
		}
		expect(offenders).toEqual([])
	})

	/**
	 * The FeasibilityProber sees the world as flown; Phase 3's JointProber will additionally see
	 * clearances formed but not committed. Those are different computations, and keeping the
	 * signatures distinct is what stops them quietly becoming the same one.
	 */
	it("the feasibility prober takes no pending-clearance parameter", () => {
		const prober = code(join("src", "domain", "feasibility", "prober.ts"))
		expect(/pending\s*[:?]/.test(prober)).toBe(false)
	})

	/**
	 * A comment that says "this is machine-checked, go look" is worth less than nothing when the
	 * path it names does not exist — it invites a reader to verify and then wastes their time, and
	 * it hides that the check may not exist either. Five such references had rotted:
	 * tests/feasibility/prober.ts, tests/substrate/no-wall-clock.test.ts (twice),
	 * tests/substrate/single-writer.test.ts and tests/theorem/window-band.test.ts.
	 */
	it("every test file a source comment points at actually exists", () => {
		const dangling: string[] = []
		for (const file of [...FILES, ...sourceFiles("scripts")]) {
			for (const ref of read(file).matchAll(/tests\/[A-Za-z0-9_./-]*\.ts/g)) {
				if (!existsSync(ref[0])) dangling.push(`${file} -> ${ref[0]}`)
			}
		}
		expect(dangling).toEqual([])
	})

	it("domain code never imports the framework", () => {
		const offenders = FILES.filter(
			(f) => f.startsWith(join("src", "domain")) && read(f).includes("@mozaik-ai/core"),
		)
		expect(offenders).toEqual([])
	})

	it("no source file imports rstest", () => {
		expect(FILES.filter((f) => read(f).includes("@rstest/core"))).toEqual([])
	})

	/**
	 * Event payloads lose their prototype in transit (docs/API-NOTES.md #12):
	 * EventPublisherLoopVisitor does `{...payload, loopId}`, so `instanceof` and `getType()`
	 * are gone by the time we see them. Payloads must be read structurally.
	 */
	it("never uses instanceof on an event payload", () => {
		const offenders = FILES.filter((f) => /payload\s+instanceof/.test(code(f)))
		expect(offenders).toEqual([])
	})
})
