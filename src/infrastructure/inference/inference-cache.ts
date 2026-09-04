import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { ContextItem, InferenceInput, InferenceOutput } from "@mozaik-ai/core"
import {
	FunctionCallItem, FunctionCallOutputItem, ModelMessageItem,
} from "@mozaik-ai/core"
import { StateHash } from "../../domain/airspace/canonical"

/**
 * Content-addressed inference cache. A repeat run costs ZERO.
 *
 * The key is a hash of everything that determines a model's answer: model id, reasoning effort,
 * the serialized context items, and the tool names. Two calls with the same key would get the
 * same answer from a deterministic model, and we treat them as identical from a
 * non-deterministic one — which is the honest position, since the alternative is paying to
 * observe sampling noise.
 *
 * Committed to the repo, so the demo and the tests replay free and a judge with no key can still
 * run a live-shaped scenario against real recorded answers.
 */
export type CachedEntry = {
	readonly key: string
	readonly model: string
	readonly items: readonly SerializedItem[]
	readonly latencyMs: number
}

type SerializedItem =
	| { readonly type: "message"; readonly text: string }
	| { readonly type: "function_call"; readonly callId: string; readonly name: string; readonly args: string }

export function cacheKeyFor(input: InferenceInput): string {
	const hash = new StateHash()
	hash.pushString(input.model)
	hash.pushString(input.reasoningEffort ?? "")
	for (const item of input.context.getItems()) hash.pushString(describeItem(item))
	for (const tool of input.tools ?? []) hash.pushString(tool.name)
	return hash.digest()
}

function describeItem(item: ContextItem): string {
	const any = item as unknown as Record<string, unknown>
	const type = item.getType()
	if (type === "message") {
		const content = any.content as { text?: string } | undefined
		return `${type}:${String(any.role ?? "")}:${content?.text ?? ""}`
	}
	if (type === "function_call") return `${type}:${String(any.name)}:${String(any.args)}`
	if (type === "function_call_output") {
		const output = any.output as { text?: string } | undefined
		return `${type}:${String(any.callId)}:${output?.text ?? ""}`
	}
	return type
}

export function serialize(output: InferenceOutput): SerializedItem[] {
	const out: SerializedItem[] = []
	for (const item of output.items) {
		const any = item as unknown as Record<string, unknown>
		if (item.getType() === "function_call") {
			out.push({ type: "function_call", callId: String(any.callId), name: String(any.name), args: String(any.args) })
		} else if (item.getType() === "message") {
			const content = any.content as { text?: string } | undefined
			out.push({ type: "message", text: content?.text ?? "" })
		}
		// reasoning items are deliberately dropped — see orphan-repair.ts
	}
	return out
}

export function deserialize(items: readonly SerializedItem[]): InferenceOutput {
	return {
		items: items.map((i) =>
			i.type === "function_call"
				? FunctionCallItem.rehydrate({ callId: i.callId, name: i.name, args: i.args })
				: ModelMessageItem.rehydrate({ text: i.text }),
		),
		tokenUsage: undefined,
		rowResponse: { cached: true },
	}
}

export class InferenceCache {
	private readonly entries = new Map<string, CachedEntry>()
	private hits = 0
	private misses = 0

	constructor(private readonly path: string | null) {
		if (path && existsSync(path)) {
			for (const line of readFileSync(path, "utf8").split("\n")) {
				if (!line.trim()) continue
				const entry = JSON.parse(line) as CachedEntry
				this.entries.set(entry.key, entry)
			}
		}
	}

	get(input: InferenceInput): InferenceOutput | null {
		const entry = this.entries.get(cacheKeyFor(input))
		if (!entry) {
			this.misses += 1
			return null
		}
		this.hits += 1
		return deserialize(entry.items)
	}

	put(input: InferenceInput, output: InferenceOutput, latencyMs: number): void {
		const entry: CachedEntry = {
			key: cacheKeyFor(input), model: input.model, items: serialize(output), latencyMs,
		}
		this.entries.set(entry.key, entry)
		if (this.path) {
			mkdirSync(dirname(this.path), { recursive: true })
			writeFileSync(this.path, [...this.entries.values()].map((e) => JSON.stringify(e)).join("\n") + "\n")
		}
	}

	stats(): { readonly hits: number; readonly misses: number; readonly size: number } {
		return { hits: this.hits, misses: this.misses, size: this.entries.size }
	}

	/** Every recorded latency — the raw material for the tripwire. */
	latencies(): readonly number[] {
		return [...this.entries.values()].map((e) => e.latencyMs).filter((l) => l > 0)
	}
}

export { FunctionCallOutputItem }
