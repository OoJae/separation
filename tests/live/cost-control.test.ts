import { describe, expect, it } from "@rstest/core"
import { FunctionCallItem, ModelContext, ModelMessageItem, UserMessageItem, type InferenceInput } from "@mozaik-ai/core"
import { BudgetGuard } from "../../src/infrastructure/inference/budget-guard"
import { InferenceCache, cacheKeyFor } from "../../src/infrastructure/inference/inference-cache"
import { LiveInferenceRunner } from "../../src/infrastructure/inference/live-runner"
import {
	AUTHORITIES_ARE_DISTINCT, MULTI_VENDOR, OBJECTIVES_ARE_DISTINCT, ROSTER,
	configuredProviders, resolveEffort,
} from "../../src/infrastructure/inference/model-roster"
import { mimoModel } from "../../src/infrastructure/inference/mimo"
import { supportedModels } from "@mozaik-ai/core"
import { VirtualClock } from "../../src/support/ports"

const input = (model: string, text: string): InferenceInput => ({
	model, context: new ModelContext("c", [UserMessageItem.create(text)]), tools: [],
})

describe("cost control — built before the first live call", () => {
	describe("budget guard", () => {
		it("authorizes up to the cap, then refuses as a VALUE — never a throw", () => {
			const guard = new BudgetGuard(2)
			expect(guard.authorize().ok).toBe(true)
			expect(guard.authorize().ok).toBe(true)
			const third = guard.authorize()
			expect(third.ok).toBe(false)
			if (third.ok) return
			expect(third.reason).toBe("budget-exhausted")
			expect(third.spent).toBe(2)
			expect(guard.used()).toBe(2) // a refusal does not consume
		})
	})

	describe("inference cache", () => {
		it("keys on model, context and tools — a repeat run is a hit", () => {
			const a = cacheKeyFor(input("claude-opus-4-8", "hold AAL221"))
			const b = cacheKeyFor(input("claude-opus-4-8", "hold AAL221"))
			const c = cacheKeyFor(input("claude-opus-4-8", "hold SWA455"))
			const d = cacheKeyFor(input("gpt-5.5", "hold AAL221"))
			expect(a).toBe(b)
			expect(a).not.toBe(c)
			expect(a).not.toBe(d)
		})

		it("round-trips a function call and a message through serialization", () => {
			const cache = new InferenceCache(null)
			const req = input("claude-opus-4-8", "x")
			cache.put(req, {
				items: [
					FunctionCallItem.rehydrate({ callId: "c1", name: "commit_clearance", args: '{"clearanceId":"A"}' }),
					ModelMessageItem.rehydrate({ text: "done" }),
				],
				tokenUsage: undefined, rowResponse: {},
			}, 1_234)
			const hit = cache.get(req)!
			expect(hit).not.toBeNull()
			expect(hit.items.map((i) => i.getType())).toEqual(["function_call", "message"])
			expect((hit.items[0] as unknown as { args: string }).args).toBe('{"clearanceId":"A"}')
			expect(cache.stats()).toEqual({ hits: 1, misses: 0, size: 1 })
			expect(cache.latencies()).toEqual([1_234])
		})

		it("misses on an unseen input", () => {
			const cache = new InferenceCache(null)
			expect(cache.get(input("claude-opus-4-8", "never seen"))).toBeNull()
			expect(cache.stats().misses).toBe(1)
		})
	})

	describe("live runner multiplexing", () => {
		const clock = new VirtualClock(0)
		const scripted = () => ({ items: [ModelMessageItem.rehydrate({ text: "synthetic" })], tokenUsage: undefined, rowResponse: {} })

		it("short-circuits synthetic ids with zero live calls and zero budget", async () => {
			const budget = new BudgetGuard(0)
			const runner = new LiveInferenceRunner({
				scripted, isSynthetic: (m) => m.startsWith("synthetic/"), cache: new InferenceCache(null),
				budget, clock, measure: () => 0,
			})
			const out = await runner.run(input("synthetic/x", "hi"))
			expect((out.items[0] as unknown as { content: { text: string } }).content.text).toBe("synthetic")
			expect(budget.used()).toBe(0)
			expect(runner.log()).toEqual([])
		})

		it("serves a cached real-model answer without touching the budget", async () => {
			const cache = new InferenceCache(null)
			const req = input("claude-opus-4-8", "cached")
			cache.put(req, scripted(), 900)
			const budget = new BudgetGuard(0)
			const runner = new LiveInferenceRunner({
				scripted, isSynthetic: () => false, cache, budget, clock, measure: () => 0,
			})
			await runner.run(req)
			expect(budget.used()).toBe(0)
			expect(runner.log()).toEqual([{ model: "claude-opus-4-8", latencyMs: 0, cached: true }])
		})

		it("refuses past the budget as a readable message, without calling any provider", async () => {
			const runner = new LiveInferenceRunner({
				scripted, isSynthetic: () => false, cache: new InferenceCache(null),
				budget: new BudgetGuard(0), clock, measure: () => 0,
			})
			const out = await runner.run(input("claude-opus-4-8", "unseen"))
			const text = (out.items[0] as unknown as { content: { text: string } }).content.text
			expect(text).toContain("inference refused")
			expect(text).toContain("budget exhausted")
			expect(out.rowResponse).toMatchObject({ refused: true })
		})
	})

	describe("model roster — what actually distinguishes the seats", () => {
		/**
		 * The design wanted one vendor per seat, so a peer's objection would come from a different
		 * prior. Only one endpoint is configured, so it does not. This asserts the LIMITATION,
		 * because a test that quietly passed either way would be worthless.
		 */
		it("is NOT multi-vendor today, and says so", () => {
			expect(MULTI_VENDOR).toBe(false)
			expect(new Set(ROSTER.map((s) => s.model)).size).toBe(1)
		})

		it("still distinguishes the seats by authority and objective, which is what drives disagreement", () => {
			expect(AUTHORITIES_ARE_DISTINCT).toBe(true)
			expect(OBJECTIVES_ARE_DISTINCT).toBe(true)
			expect(ROSTER).toHaveLength(3)
		})

		it("records the intended vendor per seat, so restoring the claim is a config change", () => {
			expect(ROSTER.map((s) => s.intendedProvider).sort()).toEqual(["anthropic", "google", "openai"])
		})

		it("resolves effort against each model's own vocabulary", () => {
			const spec = (name: string) => supportedModels.find((m) => m.specification.name === name)?.specification
			expect(resolveEffort("high", spec("claude-opus-4-8"))).toBe("high")
			expect(resolveEffort("none", spec("claude-opus-4-8"))).toBe("low")   // no "none" on opus
			expect(resolveEffort("max", spec("claude-haiku-4-5"))).toBe("high")  // no "max" on haiku
			expect(resolveEffort("high", undefined)).toBeUndefined()
		})

		it("declares no reasoning effort for MiMo — it thinks unprompted and the config costs budget", () => {
			const mimo = mimoModel({ baseURL: "https://example.invalid", apiKey: "x" })
			expect(mimo.specification.supportsReasoningEffort).toBe(false)
			expect(resolveEffort("high", mimo.specification)).toBeUndefined()
		})

		it("reports configured endpoints without failing on missing ones", () => {
			expect(configuredProviders({})).toEqual(new Set())
			expect(configuredProviders({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "u" })).toEqual(new Set(["mimo"]))
			expect(configuredProviders({ ANTHROPIC_API_KEY: "k" })).toEqual(new Set(["anthropic"]))
		})
	})
})
