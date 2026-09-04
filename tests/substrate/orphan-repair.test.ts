import { describe, expect, it } from "@rstest/core"
import {
	FunctionCallItem, FunctionCallOutputItem, ModelMessageItem, ReasoningItem, UserMessageItem,
} from "@mozaik-ai/core"
import { isWellPaired, repairContextItems } from "../../src/infrastructure/scheduling/orphan-repair"

const types = (items: readonly { getType(): string }[]) => items.map((i) => i.getType())

describe("orphan repair", () => {
	it("synthesizes an output for a dangling function_call", () => {
		const items = [
			UserMessageItem.create("hold"),
			FunctionCallItem.rehydrate({ callId: "c1", name: "commit_clearance", args: "{}" }),
		]
		expect(isWellPaired(items)).toBe(false)

		const repaired = repairContextItems(items, "[aborted: premise invalidated]")
		expect(isWellPaired(repaired)).toBe(true)
		expect(types(repaired)).toEqual(["message", "function_call", "function_call_output"])
	})

	it("places the synthesized output immediately after its call", () => {
		const items = [
			FunctionCallItem.rehydrate({ callId: "c1", name: "a", args: "{}" }),
			FunctionCallItem.rehydrate({ callId: "c2", name: "b", args: "{}" }),
		]
		const repaired = repairContextItems(items, "r")
		expect(types(repaired)).toEqual([
			"function_call", "function_call_output", "function_call", "function_call_output",
		])
		expect((repaired[1] as unknown as { callId: string }).callId).toBe("c1")
		expect((repaired[3] as unknown as { callId: string }).callId).toBe("c2")
	})

	it("leaves already-paired calls untouched", () => {
		const items = [
			FunctionCallItem.rehydrate({ callId: "c1", name: "a", args: "{}" }),
			FunctionCallOutputItem.create("c1", "done"),
		]
		expect(repairContextItems(items, "r")).toHaveLength(2)
	})

	it("carries the reason, so being overruled becomes reasoning material", () => {
		const items = [FunctionCallItem.rehydrate({ callId: "c1", name: "a", args: "{}" })]
		const repaired = repairContextItems(items, "[L0 reflex seized the actuator at 3.2nm]")
		const output = repaired[1] as unknown as { output: { text: string } }
		expect(output.output.text).toContain("reflex seized")
	})

	it("strips reasoning items — Anthropic 400s on an empty thinking signature", () => {
		const items = [
			UserMessageItem.create("x"),
			ReasoningItem.rehydrate({ content: undefined, encryptedContent: undefined, summary: [] }),
			ModelMessageItem.rehydrate({ text: "y" }),
		]
		expect(types(repairContextItems(items, "r"))).toEqual(["message", "message"])
	})
})
