import { describe, expect, it } from "@rstest/core"
import { checkAll, everyHoldGetsItsSettle, type RunObservation } from "../../src/retrace/invariants"

/**
 * THE DETECTOR STILL FIRES.
 *
 * RETRACE found one real bug — a commit arriving 30 ms after its peer was adjudicated on the peer's
 * earlier timer and got 20 ms of a promised 50 ms settle window. That bug is fixed, so the shipped
 * exploration now finds nothing, and **a bug-finding tool that finds nothing is indistinguishable
 * from a broken bug-finding tool**. Its only observable state became a reassuring zero.
 *
 * The honest guard is not to keep the bug around behind a flag — that would put a make-it-broken
 * switch in production code. It is to feed the detector the exact observation the historical bug
 * produced and assert it still fires.
 */
const clean: RunObservation = {
	events: [],
	settleGranted: new Map([["turn-1", 50], ["turn-2", 50]]),
	settleRequiredMs: 50,
	pendingAtEnd: 0,
}

describe("RETRACE's invariants still catch the bug RETRACE found", () => {
	it("fires on the historical shortened settle window, naming the loss", () => {
		// The observation the pre-fix desk produced: turn-2 arrived 30 ms late and was adjudicated
		// on turn-1's timer, so it received 20 ms of the promised 50.
		const historical: RunObservation = {
			...clean,
			settleGranted: new Map([["turn-1", 50], ["turn-2", 20]]),
		}
		const found = everyHoldGetsItsSettle(historical)
		expect(found).toHaveLength(1)
		expect(found[0]!.invariant).toBe("every-hold-gets-its-settle")
		expect(found[0]!.detail).toContain("turn-2")
		expect(found[0]!.detail).toContain("20ms")
		expect(found[0]!.detail).toContain("30ms of objection opportunity lost")
	})

	it("stays silent when every hold got its full window — no false positive", () => {
		expect(everyHoldGetsItsSettle(clean)).toEqual([])
		expect(checkAll(clean)).toEqual([])
	})

	it("catches a hold that got nothing at all", () => {
		const starved: RunObservation = { ...clean, settleGranted: new Map([["turn-1", 0]]) }
		expect(everyHoldGetsItsSettle(starved)).toHaveLength(1)
	})
})
