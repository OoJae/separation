import { describe, expect, it } from "@rstest/core"
import { readFileSync } from "node:fs"

/**
 * THE SITE AND THE VIEWER MUST AGREE ABOUT COLOUR.
 *
 * `viewer/index.html` carries its own copy of the design tokens rather than linking
 * `site/app.css`, and that duplication is deliberate: the viewer is inlined whole into the published
 * artifact, so it has to be self-contained. Deliberate duplication still drifts — this repo has
 * already shipped a README whose headline output existed in no run, and a notebook that had to be
 * brought under the same test for the same reason.
 *
 * So the copy is checked rather than trusted.
 */
function tokens(path: string): Map<string, string> {
	const block = /:root\s*\{([\s\S]*?)\}/.exec(readFileSync(path, "utf8"))
	expect(block, `${path} has no :root token block`).not.toBeNull()
	const out = new Map<string, string>()
	for (const m of block![1]!.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) {
		out.set(m[1]!, m[2]!.trim().toLowerCase())
	}
	return out
}

describe("the site and the viewer share one palette", () => {
	const site = tokens("site/app.css")
	const viewer = tokens("viewer/index.html")

	it("defines the tokens the pages actually use", () => {
		for (const t of ["--void", "--scope", "--chart", "--phosphor", "--ra", "--rule", "--dim"]) {
			expect(site.has(t), `site/app.css is missing ${t}`).toBe(true)
		}
		expect(viewer.size).toBeGreaterThan(6)
	})

	it("gives every shared token the same value in both files", () => {
		const shared = [...viewer.keys()].filter((k) => site.has(k))
		expect(shared.length).toBeGreaterThan(6)
		const drift = shared
			.filter((k) => site.get(k) !== viewer.get(k))
			.map((k) => `${k}: site ${site.get(k)} vs viewer ${viewer.get(k)}`)
		expect(drift).toEqual([])
	})

	it("leaves no hardcoded colour outside the token block in the viewer", () => {
		const html = readFileSync("viewer/index.html", "utf8")
		const body = html.replace(/:root\s*\{[\s\S]*?\}/, "")
		// Canvas reads tokens through T()/A(); CSS uses var(). Neither should name a colour directly.
		const stray = [...body.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([\d.,\s]+\)/g)].map((m) => m[0])
		expect(stray).toEqual([])
	})
})
