import { describe, expect, it } from "@rstest/core"
import { VirtualClock } from "../../src/support/ports"

describe("VirtualClock", () => {
	it("fires timers in due order", () => {
		const clock = new VirtualClock(0)
		const fired: string[] = []
		clock.at(30, () => fired.push("c"))
		clock.at(10, () => fired.push("a"))
		clock.at(20, () => fired.push("b"))
		clock.advance(100)
		expect(fired).toEqual(["a", "b", "c"])
	})

	it("breaks ties by insertion order, not by registration time", () => {
		const clock = new VirtualClock(0)
		const fired: string[] = []
		for (const name of ["first", "second", "third"]) clock.at(50, () => fired.push(name))
		clock.advance(100)
		expect(fired).toEqual(["first", "second", "third"])
	})

	it("runs a timer scheduled by a firing callback within the same advance", () => {
		const clock = new VirtualClock(0)
		const fired: string[] = []
		clock.at(10, () => {
			fired.push("outer")
			clock.at(20, () => fired.push("inner"))
		})
		clock.advance(100)
		expect(fired).toEqual(["outer", "inner"])
		expect(clock.nowMs()).toBe(100)
	})

	it("does not fire timers past the advance horizon", () => {
		const clock = new VirtualClock(0)
		const fired: string[] = []
		clock.at(500, () => fired.push("late"))
		clock.advance(100)
		expect(fired).toEqual([])
		expect(clock.pendingCount()).toBe(1)
	})

	it("cancels", () => {
		const clock = new VirtualClock(0)
		const fired: string[] = []
		const handle = clock.at(10, () => fired.push("x"))
		clock.cancel(handle)
		clock.advance(100)
		expect(fired).toEqual([])
	})

	it("is repeatable — two identical runs produce identical traces", () => {
		const run = () => {
			const clock = new VirtualClock(0)
			const trace: string[] = []
			clock.at(20, () => {
				trace.push(`b@${clock.nowMs()}`)
				clock.after(5, () => trace.push(`d@${clock.nowMs()}`))
			})
			clock.at(10, () => trace.push(`a@${clock.nowMs()}`))
			clock.at(20, () => trace.push(`c@${clock.nowMs()}`))
			clock.advance(50)
			return trace
		}
		expect(run()).toEqual(run())
		expect(run()).toEqual(["a@10", "b@20", "c@20", "d@25"])
	})
})
