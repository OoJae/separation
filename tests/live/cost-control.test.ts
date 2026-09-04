import { describe, expect, it } from "@rstest/core"
import { FunctionCallItem, ModelContext, ModelMessageItem, UserMessageItem, type InferenceInput } from "@mozaik-ai/core"
import { BudgetGuard } from "../../src/infrastructure/inference/budget-guard"
import { InferenceCache, cacheKeyFor } from "../../src/infrastructure/inference/inference-cache"
import { LiveInferenceRunner } from "../../src/infrastructure/inference/live-runner"
import { ROSTER, availableProviders, resolveEffort, vendorsAreDistinct } from "../../src/infrastructure/inference/model-roster"
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

	describe("model roster — one seat of authority per vendor", () => {
		it("puts every seat on a DIFFERENT vendor", () => {
			expect(vendorsAreDistinct()).toBe(true)
			expect(ROSTER.map((s) => s.provider).sort()).toEqual(["anthropic", "google", "openai"])
		})

		it("names a distinct authority per seat, so removing a vendor darkens something specific", () => {
			expect(new Set(ROSTER.map((s) => s.authority)).size).toBe(ROSTER.length)
		})

		/**
		 * Finding #10: effort vocabularies are not uniform. A hardcoded ladder throws when a
		 * participant changes model, so the literal is resolved against the shipped spec.
		 */
		it("resolves effort against each model's own vocabulary", () => {
			expect(resolveEffort("claude-opus-4-8", "high")).toBe("high")
			expect(resolveEffort("claude-opus-4-8", "none")).toBe("low")      // no "none" on opus
			expect(resolveEffort("claude-haiku-4-5", "max")).toBe("high")     // no "max" on haiku
			expect(resolveEffort("gemini-3.5-flash", "minimal")).toBe("minimal")
			expect(resolveEffort("no-such-model", "high")).toBeUndefined()
		})

		it("reports which providers have keys without failing on missing ones", () => {
			expect(availableProviders({})).toEqual(new Set())
			expect(availableProviders({ ANTHROPIC_API_KEY: "k" })).toEqual(new Set(["anthropic"]))
			expect(availableProviders({ GOOGLE_API_KEY: "k", OPENAI_API_KEY: "k" })).toEqual(new Set(["google", "openai"]))
		})
	})
})
