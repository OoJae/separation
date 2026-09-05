import { describe, expect, it } from "@rstest/core"
import { SemanticEvent, RuntimeState, SituationSpecification, createHuman, defineRuntime } from "@mozaik-ai/core"
import type { SituationContext, SituationHandler } from "@mozaik-ai/core"
import {
	FifoPolicy, ScriptedPolicy, currentPolicy, resetPolicy, seam, withPolicy,
} from "../../src/retrace/schedule"
import { shrink, describe as describeSchedule } from "../../src/retrace/shrink"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"

class S extends RuntimeState {}

describe("the scheduling seam", () => {
	/**
	 * NON-INVASIVENESS IS THE FIRST REQUIREMENT. If installing the seam changed behaviour, the
	 * seam would be wrong — and every determinism claim made in Phases 2-5 would be suspect.
	 */
	describe("is non-invasive by default", () => {
		it("FifoPolicy delivers outbox events in exactly the previous FIFO order", () => {
			const clock = new VirtualClock(0)
			const seen: string[] = []
			const outbox = new OutboxDispatcher((e) => seen.push(e.type), clock)
			for (const t of ["a", "b", "c", "d"]) outbox.publish(t, "p", {})
			expect(seen).toEqual(["a", "b", "c", "d"])
		})

		it("FifoPolicy fires timers in exactly the previous (due, insertion) order", () => {
			const clock = new VirtualClock(0)
			const fired: string[] = []
			clock.at(50, () => fired.push("second"))
			clock.at(10, () => fired.push("first"))
			clock.at(50, () => fired.push("third"))
			clock.advance(100)
			expect(fired).toEqual(["first", "second", "third"])
		})

		/**
		 * The contract, not the timing. `seam()` is async, so awaiting it costs a microtask tick
		 * whatever the policy says — asserting otherwise would be testing JavaScript rather than
		 * this code. What matters is that the default policy declines every seam, and a scripted
		 * one takes only the seams it was given.
		 */
		it("the default policy declines every seam", () => {
			resetPolicy()
			expect(currentPolicy().shouldYield("broker:bid:before-read")).toBe(false)
			expect(currentPolicy().shouldYield("anything-at-all")).toBe(false)
			expect(new FifoPolicy().shouldYield()).toBe(false)
		})

		it("a scripted policy takes only the seams it was given", () => {
			const policy = new ScriptedPolicy([], new Set(["broker:bid:before-read"]))
			expect(policy.shouldYield("broker:bid:before-read")).toBe(true)
			expect(policy.shouldYield("some-other-seam")).toBe(false)
		})

		it("seam() resolves either way, so a declined seam is a no-op", async () => {
			resetPolicy()
			await expect(seam("broker:bid:before-read")).resolves.toBeUndefined()
		})
	})

	describe("is causally constrained by construction", () => {
		/**
		 * The check against theatre. If a policy could pick an event that had not been published,
		 * or a timer that was not due, the "exploration" would be a random number generator with a
		 * violation counter. Neither is expressible: the outbox only offers queued events and the
		 * clock only offers timers at the earliest due time.
		 */
		it("never offers a timer that is not yet due", async () => {
			const clock = new VirtualClock(0)
			const fired: number[] = []
			clock.at(10, () => fired.push(10))
			clock.at(500, () => fired.push(500))

			await withPolicy(new ScriptedPolicy([9, 9, 9, 9]), async () => {
				clock.advance(100) // only the 10ms timer is due
			})
			expect(fired).toEqual([10]) // the 500ms timer was never eligible, whatever the picks
		})

		it("only offers a choice when more than one item is eligible", async () => {
			const clock = new VirtualClock(0)
			const policy = new ScriptedPolicy([1, 1, 1])
			await withPolicy(policy, async () => {
				const outbox = new OutboxDispatcher(() => {}, clock)
				outbox.publish("solo", "p", {}) // a queue of one is not a decision
			})
			expect(policy.decisions().filter((d) => d.options > 1)).toHaveLength(0)
		})

		it("an out-of-range pick is clamped into the eligible set, never out of it", async () => {
			const clock = new VirtualClock(0)
			const seen: string[] = []
			const policy = new ScriptedPolicy([999, 999, 999])
			await withPolicy(policy, async () => {
				const outbox = new OutboxDispatcher((e) => seen.push(e.type), clock)
				const relay: SituationHandler = {
					specification: new (class extends SituationSpecification {
						isSatisfiedBy({ event }: SituationContext) { return event.type === "a" }
					})(),
					processor: { apply() { outbox.publish("nested", "p", {}) } },
				}
				const { initializeRuntime, join, sendEvent } = defineRuntime<S>()
				const h = createHuman({ name: "h", capabilities: [], handlers: [relay] })
				initializeRuntime({ state: new S() })
				join(h)
				const wired = new OutboxDispatcher((e, s) => { seen.push(e.type); sendEvent(e, s) }, clock)
				wired.publish("a", h.getId(), {})
			})
			// Whatever the picks, only events that were actually published ever appear.
			for (const t of seen) expect(["a", "nested"]).toContain(t)
		})
	})

	describe("a schedule is data", () => {
		it("records every decision it made, so a repro is replayable", async () => {
			const clock = new VirtualClock(0)
			const policy = new ScriptedPolicy([0, 1, 0])
			await withPolicy(policy, async () => {
				clock.at(10, () => {})
				clock.at(10, () => {})
				clock.advance(50)
			})
			expect(policy.decisions().length).toBeGreaterThan(0)
			expect(policy.decisions()[0]!.kind).toBe("timer")
		})

		it("restores the previous policy even when the body throws", async () => {
			resetPolicy()
			const before = currentPolicy()
			await expect(
				withPolicy(new ScriptedPolicy([1]), async () => { throw new Error("boom") }),
			).rejects.toThrow("boom")
			expect(currentPolicy()).toBe(before)
		})

		it("describes how much of a schedule is load-bearing", () => {
			expect(describeSchedule({ picks: [0, 0, 2, 0], yieldAt: ["x"] }))
				.toBe("4 decisions (1 non-default), 1 yield seam(s): x")
		})
	})
})
