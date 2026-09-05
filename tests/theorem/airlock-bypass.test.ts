import { describe, expect, it } from "@rstest/core"
import { FunctionCallItem, ModelContext } from "@mozaik-ai/core"
import type { ExecutableTransition, SemanticEvent } from "@mozaik-ai/core"
import { IntentRegistry } from "../../src/domain/interlock/intent-registry"
import { InterlockDesk } from "../../src/participants/interlock-desk"
import { PremiseSentinel } from "../../src/participants/controller/premise-sentinel"
import { HORIZON_S, INITIAL, WINDOWS, clearanceA, narrowingCandidatesForA } from "../../src/scenarios/braid-2"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"

function harness() {
	const clock = new VirtualClock(0)
	const published: SemanticEvent[] = []
	const outbox = new OutboxDispatcher((e) => published.push(e), clock)
	const intents = new IntentRegistry()
	const desk = InterlockDesk.init({
		world: () => [...INITIAL], windows: WINDOWS, horizonSec: HORIZON_S, clock, outbox,
		settleMs: 50, intents,
		narrowingCandidates: (s) => (s.callsign === "AAL221" ? narrowingCandidatesForA() : []),
	})
	const sentinel = PremiseSentinel.init({ world: () => [...INITIAL], horizonSec: HORIZON_S, outbox })
	return { clock, desk, sentinel, intents, published }
}

const transitionFor = (args: string): ExecutableTransition => ({
	nextStateId: "function_call",
	input: {
		call: FunctionCallItem.rehydrate({ callId: "c1", name: "commit_clearance", args }),
		inferenceInput: { model: "x", context: new ModelContext("c", []), tools: [] },
	},
} as ExecutableTransition)

/**
 * THE HOLE PHASE 7 FOUND, as a regression test.
 *
 * `parse` used to return null for three different failures, and the call site did
 * `return transition` — so an unreadable commit passed through UNTOUCHED: no airlock hold, no
 * joint-hazard check, no premise check. A documented path around the mechanism this project is
 * named after, living in that mechanism's own file.
 *
 * Only two of the three failures are the bypass. The third is legitimate and had to survive.
 */
describe("a commit that cannot be read never routes around the airlock", () => {
	describe("malformed — refused", () => {
		it("refuses unparseable JSON instead of passing it through", async () => {
			const h = harness()
			const out = await h.desk.handler().handle(transitionFor("{not json at all"))

			expect(out.nextStateId).toBe("model_message")   // substituted, not passed through
			expect(h.desk.pendingSize()).toBe(0)            // and never entered the airlock
			const answer = (out.input as { answer: { content: { text: string } } }).answer
			expect(answer.content.text).toContain("could not be read")
		})

		it("refuses a commit with no clearanceId", async () => {
			const h = harness()
			const out = await h.desk.handler().handle(transitionFor(JSON.stringify({ callsign: "AAL221" })))
			expect(out.nextStateId).toBe("model_message")
		})

		it("ANNOUNCES the refusal — a boundary must announce what it enforces", async () => {
			const h = harness()
			await h.desk.handler().handle(transitionFor("{broken"))
			const rejected = h.published.find((e) => e.type === "world.command.rejected")
			expect(rejected).toBeDefined()
			expect(String((rejected!.payload as { reason: string }).reason)).toContain("malformed")
		})

		it("the premise sentinel had the same hole, and it is closed too", async () => {
			const h = harness()
			const out = await h.sentinel.handler().handle(transitionFor("{broken"))
			expect(out.nextStateId).toBe("model_message")
			const answer = (out.input as { answer: { content: { text: string } } }).answer
			expect(answer.content.text).toContain("premise could not be checked")
		})
	})

	describe("unresolved — still passes through, because the tool answers it", () => {
		/**
		 * The subtlety that decides whether this fix breaks the suite. A well-formed commit naming
		 * a clearance that was never proposed is NOT malformed — the tool itself replies
		 * "unknown clearance X — propose it first", which is a real refusal the model reads.
		 * Refusing it here as well would have broken a working path.
		 */
		it("lets a well-formed but unknown clearanceId reach the executor unchanged", async () => {
			const h = harness()
			const original = transitionFor(JSON.stringify({ clearanceId: "NEVER-PROPOSED" }))
			const out = await h.desk.handler().handle(original)

			expect(out.nextStateId).toBe("function_call")  // untouched
			expect(out).toBe(original)                      // literally the same transition
			expect(h.published.filter((e) => e.type === "world.command.rejected")).toHaveLength(0)
		})

		it("resolves a known clearanceId through the intent registry and holds it", async () => {
			const h = harness()
			h.intents.announce(clearanceA())
			const out = h.desk.handler().handle(transitionFor(JSON.stringify({ clearanceId: "A" })))

			expect(h.desk.pendingSize()).toBe(1)  // it DID enter the airlock
			h.clock.advance(60)
			await out
			expect(h.desk.isQuiescent()).toBe(true)
		})
	})
})
