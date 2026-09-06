import { describe, expect, it } from "@rstest/core"
import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * THE README MUST BE TRUE.
 *
 * This test exists because it caught us. The README's headline transcript showed a clearance
 * (`CARDL-meter-AAL221-slow`, `{"targetGroundspeedKt":210}`) that existed in no run and nowhere in
 * `fixtures/money-shot.json` — a live model had chosen differently on a re-record and the block was
 * never regenerated. The prose beneath it made a claim that was false against the shipped artifact.
 *
 * In a project whose entire product is that its numbers can be checked, a fabricated headline output
 * taxes every other number in the document. Nothing else in the repo was watching the README, because
 * the evidence lives in the scripts and the prose lives here, and no test spanned the two.
 *
 * Any fenced block preceded by `<!-- reproduced-by: <npm script> -->` is now run and compared.
 */
const SCRIPT_MARKER = /<!--\s*reproduced-by:\s*([\w:-]+)\s*-->\s*\n```\n([\s\S]*?)```/g

function claimedBlocks(): { script: string; lines: string[] }[] {
	const readme = readFileSync("README.md", "utf8")
	return [...readme.matchAll(SCRIPT_MARKER)].map((m) => ({
		script: m[1]!,
		lines: m[2]!.split("\n").map((l) => l.trim()).filter((l) => l !== ""),
	}))
}

describe("every reproducible block in the README reproduces", () => {
	const blocks = claimedBlocks()

	it("finds at least one block claiming to be reproducible", () => {
		expect(blocks.length).toBeGreaterThan(0)
	})

	for (const { script, lines } of blocks) {
		it(`\`npm run ${script}\` still prints what the README says it prints`, () => {
			// Keyless: every reproducible script replays from the committed cache.
			const out = execSync(`npm run --silent ${script}`, {
				encoding: "utf8",
				env: { ...process.env, ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "" },
				stdio: ["ignore", "pipe", "ignore"],
			})
			const printed = out.split("\n").map((l) => l.trim())
			const missing = lines.filter((claimed) => !printed.includes(claimed))
			// Name them: a bare "expected [ …(2) ] to equal []" is useless when this fires months later.
			expect(missing, `README claims these lines but \`npm run ${script}\` did not print them:\n  ${missing.join("\n  ")}`).toEqual([])
		}, 120_000)
	}
})
