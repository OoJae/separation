import { describe, expect, it } from "@rstest/core"
import {
	RuntimeState, SemanticEvent, SituationSpecification, createHuman, defineRuntime,
	type SituationContext, type SituationHandler,
} from "@mozaik-ai/core"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"

class TestState extends RuntimeState {}

class WhenType extends SituationSpecification {
	constructor(private readonly type: string) { super() }
	isSatisfiedBy({ event }: SituationContext): boolean { return event.type === this.type }
}

const recordAll = (into: string[]): SituationHandler => ({
	specification: new (class extends SituationSpecification {
		isSatisfiedBy({ event }: SituationContext) { return event.type === "a" || event.type === "b" }
	})(),
	processor: { apply({ event }) { into.push(event.type) } },
})

/**
 * These two tests are the justification for OutboxDispatcher existing at all, run against
 * the REAL mozaik runtime rather than a mock of it.
 *
 * `RuntimeService.publish` is a synchronous for-loop over participants. When a situation
 * processor publishes during that fan-out, publish RE-ENTERS depth-first, so a participant
 * positioned before the re-publisher sees the nested event BEFORE the outer one, while a
 * participant positioned after it sees them in the opposite order.
 */
describe("event ordering", () => {
	it("CONTROL: raw sendEvent makes two participants observe DIFFERENT orders", () => {
		const { initializeRuntime, join, sendEvent } = defineRuntime<TestState>()
		const first: string[] = []
		const second: string[] = []

		const observerOne = createHuman({ name: "ObserverOne", capabilities: [], handlers: [recordAll(first)] })
		const echo = createHuman({
			name: "Echo", capabilities: [],
			handlers: [{
				specification: new WhenType("a"),
				processor: {
					apply() {
						// re-entrant publish from inside a processor
						sendEvent(new SemanticEvent("b", echo.getId(), new Date(0), {}), echo.getId())
					},
				},
			}],
		})
		const observerTwo = createHuman({ name: "ObserverTwo", capabilities: [], handlers: [recordAll(second)] })

		initializeRuntime({ state: new TestState() })
		join(observerOne)
		join(echo)
		join(observerTwo)

		sendEvent(new SemanticEvent("a", echo.getId(), new Date(0), {}), echo.getId())

		expect(first).toEqual(["a", "b"])
		expect(second).toEqual(["b", "a"]) // <- the bug, reproduced
		expect(first).not.toEqual(second)
	})

	it("through the outbox, every participant observes ONE identical order", () => {
		const { initializeRuntime, join, sendEvent } = defineRuntime<TestState>()
		const first: string[] = []
		const second: string[] = []
		const clock = new VirtualClock(0)
		const outbox = new OutboxDispatcher((event, senderId) => sendEvent(event, senderId), clock)

		const observerOne = createHuman({ name: "ObserverOne", capabilities: [], handlers: [recordAll(first)] })
		const echo = createHuman({
			name: "Echo", capabilities: [],
			handlers: [{
				specification: new WhenType("a"),
				processor: { apply() { outbox.publish("b", echo.getId(), {}) } },
			}],
		})
		const observerTwo = createHuman({ name: "ObserverTwo", capabilities: [], handlers: [recordAll(second)] })

		initializeRuntime({ state: new TestState() })
		join(observerOne)
		join(echo)
		join(observerTwo)

		outbox.publish("a", echo.getId(), {})

		expect(first).toEqual(["a", "b"])
		expect(second).toEqual(["a", "b"])
		expect(first).toEqual(second)
	})

	it("stamps a monotonic seq into every payload", () => {
		const sent: SemanticEvent[] = []
		const outbox = new OutboxDispatcher((event) => { sent.push(event) }, new VirtualClock(0))
		outbox.publish("x", "p", {})
		outbox.publish("y", "p", { extra: 1 })
		expect(sent.map((e) => (e.payload as { seq: number }).seq)).toEqual([1, 2])
		expect((sent[1]!.payload as { extra: number }).extra).toBe(1)
	})

	it("uses injected clock time, never wall clock", () => {
		const sent: SemanticEvent[] = []
		const clock = new VirtualClock(1_700_000_000_000)
		const outbox = new OutboxDispatcher((event) => { sent.push(event) }, clock)
		clock.advance(500)
		outbox.publish("x", "p", {})
		expect(sent[0]!.occurredAt.getTime()).toBe(1_700_000_000_500)
	})
})
