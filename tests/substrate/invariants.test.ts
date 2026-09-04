import { describe, expect, it } from "@rstest/core"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

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
