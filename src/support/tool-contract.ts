import type { Tool } from "@mozaik-ai/core"

/**
 * Every tool's `invoke` MUST resolve to something JSON-serializable and not `undefined`.
 *
 * WHY: `DefaultFunctionCallRunner` does `FunctionCallOutputItem.create(callId,
 * JSON.stringify(result))`, and `JSON.stringify(undefined)` returns the VALUE `undefined`,
 * not the string "undefined". That undefined flows into `InputText` and poisons the context
 * ledger, which surfaces later as a provider error with no obvious cause.
 */
export async function checkToolContract(tools: readonly Tool[]): Promise<string[]> {
	const violations: string[] = []
	for (const tool of tools) {
		let result: unknown
		try {
			result = await tool.invoke(sampleArgsFor(tool))
		} catch {
			continue // throwing is fine: DefaultFunctionCallRunner catches and reports it
		}
		if (result === undefined) {
			violations.push(`${tool.name}: invoke() resolved to undefined`)
			continue
		}
		try {
			// JSON.stringify RETURNS undefined for functions/symbols and THROWS on cycles.
			// Both poison the ledger, so both are violations.
			if (JSON.stringify(result) === undefined) {
				violations.push(`${tool.name}: result is not JSON-serializable`)
			}
		} catch (error) {
			violations.push(`${tool.name}: result is not JSON-serializable (${(error as Error).message.split("\n")[0]})`)
		}
	}
	return violations
}

/** Minimal args satisfying a tool's declared required properties. */
function sampleArgsFor(tool: Tool): Record<string, unknown> {
	const parameters = tool.parameters as {
		properties?: Record<string, { type?: string }>
		required?: string[]
	}
	const args: Record<string, unknown> = {}
	for (const key of parameters.required ?? []) {
		switch (parameters.properties?.[key]?.type) {
			case "number": case "integer": args[key] = 0; break
			case "boolean": args[key] = false; break
			case "array": args[key] = []; break
			case "object": args[key] = {}; break
			default: args[key] = "sample"
		}
	}
	return args
}
