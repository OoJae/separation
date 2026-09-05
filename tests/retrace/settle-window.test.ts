import { describe, expect, it } from "@rstest/core"
import { FunctionCallItem, ModelContext } from "@mozaik-ai/core"
import type { ExecutableTransition } from "@mozaik-ai/core"
import { IntentRegistry } from "../../src/domain/interlock/intent-registry"
import { InterlockDesk } from "../../src/participants/interlock-desk"
import { everyHoldGetsItsSettle } from "../../src/retrace/invariants"
import { HORIZON_S, INITIAL, WINDOWS, clearanceA, clearanceB, narrowingCandidatesForA } from "../../src/scenarios/braid-2"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"

const SETTLE_MS = 50

function harness() {
	const clock = new VirtualClock(0)
	const outbox = new OutboxDispatcher(() => {}, clock)
	const desk = InterlockDesk.init({
		world: () => [...INITIAL], windows: WINDOWS, horizonSec: HORIZON_S, clock, outbox,
		settleMs: SETTLE_MS, intents: new IntentRegistry(),
		narrowingCandidates: (s) => (s.callsign === "AAL221" ? narrowingCandidatesForA() : []),
	})
	const handler = desk.handler()
	const commit = (callId: string, clearance: ReturnType<typeof clearanceA>) =>
		handler.handle({
			nextStateId: "function_call",
			input: {
				call: FunctionCallItem.rehydrate({
					callId, name: "commit_clearance",
					args: JSON.stringify({
						clearanceId: clearance.id, callsign: clearance.callsign, command: clearance.command,
					}),
				}),
				inferenceInput: { model: "x", context: new ModelContext("c", []), tools: [] },
			},
		} as ExecutableTransition)
	return { clock, desk, commit }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

/**
 * THE BUG RETRACE FOUND, as a regression test.
 *
 * `hold()` schedules a settle timer per turn, but `adjudicate()` used to drain the WHOLE pending
 * set on whichever timer fired first. So a commit arriving 30 ms after its peer was adjudicated on
 * the peer's earlier timer and received 20 ms of a promised 50 ms window — silently less objection
 * opportunity than the airlock advertises, and precisely when the sector is busy enough for two
 * commits to overlap, which is exactly when a peer is most likely to object.
 *
 * The shrinker's verdict is the interesting part: it reduced a 24-decision schedule with 18
 * non-default picks and a yield seam down to ONE decision, zero non-default, zero seams. This was
 * never a race. It reproduced on the plain FIFO schedule and had been sitting there the whole time.
 */
describe("every held commit gets its full settle window", () => {
	it("a late commit is not adjudicated on its peer's earlier timer", async () => {
		const h = harness()
		const first = h.commit("c1", clearanceA())
		h.clock.advance(30)
		const second = h.commit("c2", clearanceB())

		// The first turn's timer fires here. Before the fix it dragged the second turn with it.
		h.clock.advance(21)
		await tick()

		const windows = h.desk.settleWindows()
		expect(windows.get("turn-2")).toBeUndefined() // still waiting for its OWN timer

		h.clock.advance(30)
		await tick()
		await Promise.all([first, second])

		for (const [, granted] of h.desk.settleWindows()) {
			expect(granted).toBeGreaterThanOrEqual(SETTLE_MS)
		}
	})

	it("the invariant that caught it stays satisfied", async () => {
		const h = harness()
		const first = h.commit("c1", clearanceA())
		h.clock.advance(30)
		const second = h.commit("c2", clearanceB())
		h.clock.advance(SETTLE_MS + 60)
		await tick()
		await Promise.all([first, second])

		const violations = everyHoldGetsItsSettle({
			events: [], settleGranted: h.desk.settleWindows(),
			settleRequiredMs: SETTLE_MS, pendingAtEnd: h.desk.pendingSize(),
		})
		expect(violations).toEqual([])
	})

	it("still inspects the WHOLE pending set — a joint hazard ignores whose timer it is", async () => {
		const h = harness()
		const first = h.commit("c1", clearanceA())
		h.clock.advance(30)
		const second = h.commit("c2", clearanceB())
		h.clock.advance(SETTLE_MS + 60)
		await tick()
		await Promise.all([first, second])

		// Both were adjudicated, and the joint hazard between them was still found and narrowed.
		expect(h.desk.log()).toHaveLength(2)
		expect(h.desk.log().some((d) => d.outcome === "narrowed")).toBe(true)
		expect(h.desk.isQuiescent()).toBe(true)
	})
})
