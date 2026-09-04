import { describe, expect, it } from "@rstest/core"
import type { Tool } from "@mozaik-ai/core"
import { checkToolContract } from "../../src/support/tool-contract"

const tool = (name: string, invoke: Tool["invoke"], required: string[] = []): Tool => ({
	type: "function", name, description: name,
	parameters: {
		type: "object",
		properties: Object.fromEntries(required.map((r) => [r, { type: "string" }])),
		required, additionalProperties: false,
	},
	strict: true, invoke,
})

describe("tool contract", () => {
	it("flags a tool whose invoke resolves to undefined", async () => {
		const violations = await checkToolContract([tool("bad", async () => undefined)])
		expect(violations).toHaveLength(1)
		expect(violations[0]).toContain("resolved to undefined")
	})

	it("accepts ordinary serializable results", async () => {
		const violations = await checkToolContract([
			tool("ok", async () => ({ committed: true })),
			tool("zero", async () => 0),
			tool("empty", async () => ""),
		])
		expect(violations).toEqual([])
	})

	it("flags a result that is not JSON-serializable", async () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const violations = await checkToolContract([tool("cyclic", async () => cyclic)])
		expect(violations).toHaveLength(1)
	})

	it("tolerates a throwing tool — the runner catches and reports those", async () => {
		const violations = await checkToolContract([
			tool("throws", async () => { throw new Error("boom") }),
		])
		expect(violations).toEqual([])
	})

	it("builds sample args from the declared required properties", async () => {
		let seen: unknown
		await checkToolContract([tool("needs", async (a) => { seen = a; return { ok: true } }, ["callsign"])])
		expect(seen).toEqual({ callsign: "sample" })
	})
})
