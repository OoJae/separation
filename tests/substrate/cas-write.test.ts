import { describe, expect, it } from "@rstest/core"
import type { SemanticEvent } from "@mozaik-ai/core"
import { VersionedCell } from "../../src/domain/cell/versioned-cell"
import { casWrite } from "../../src/state/cas-write"
import { EventType, type CasRejectedPayload } from "../../src/events/event-types"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"

function harness() {
	const published: SemanticEvent[] = []
	const outbox = new OutboxDispatcher((e) => { published.push(e) }, new VirtualClock(0))
	return { published, outbox }
}

describe("casWrite", () => {
	it("applies a write when the token matches, and bumps the token", () => {
		const { outbox, published } = harness()
		const cell = VersionedCell.init(10)
		const result = casWrite(cell, 0, (n) => n + 5, { path: "world.gen", byWhom: "APPROACH" }, outbox)

		expect(result).toEqual({ ok: true, token: 1 })
		expect(cell.value).toBe(15)
		expect(cell.token).toBe(1)
		expect(published).toHaveLength(0)
	})

	it("rejects a stale write and leaves the value untouched", () => {
		const { outbox } = harness()
		const cell = VersionedCell.init("DESCEND 6000")
		casWrite(cell, 0, () => "TURN 20L", { path: "clearances.UAL231", byWhom: "APPROACH" }, outbox)

		const stale = casWrite(cell, 0, () => "CLIMB 8000", { path: "clearances.UAL231", byWhom: "FLOW" }, outbox)

		expect(stale).toEqual({ ok: false, expected: 0, actual: 1 })
		expect(cell.value).toBe("TURN 20L") // the loser did not overwrite the winner
		expect(cell.token).toBe(1)
	})

	it("ANNOUNCES every rejection — a boundary must announce what it enforces", () => {
		const { outbox, published } = harness()
		const cell = VersionedCell.init(0)
		casWrite(cell, 0, (n) => n + 1, { path: "standing.UAL231", byWhom: "APPROACH" }, outbox)
		casWrite(cell, 0, (n) => n + 1, { path: "standing.UAL231", byWhom: "DEPARTURE", turnId: "t7:DEPARTURE" }, outbox)

		expect(published).toHaveLength(1)
		const event = published[0]!
		expect(event.type).toBe(EventType.CAS_REJECTED)
		const payload = event.payload as CasRejectedPayload
		expect(payload).toMatchObject({
			path: "standing.UAL231", expected: 0, actual: 1,
			byWhom: "DEPARTURE", turnId: "t7:DEPARTURE",
		})
	})

	it("never silently retries — the loser is told, and told who won the race", () => {
		const { outbox, published } = harness()
		const cell = VersionedCell.init(0)
		casWrite(cell, 0, (n) => n + 1, { path: "p", byWhom: "winner" }, outbox)
		const loser = casWrite(cell, 0, (n) => n + 100, { path: "p", byWhom: "loser" }, outbox)

		expect(loser.ok).toBe(false)
		expect(cell.value).toBe(1)
		expect((published[0]!.payload as CasRejectedPayload).actual).toBe(1)
	})

	it("supports a read-modify-CAS retry loop driven by the announced token", () => {
		const { outbox } = harness()
		const cell = VersionedCell.init(0)
		casWrite(cell, cell.token, (n) => n + 1, { path: "p", byWhom: "a" }, outbox)
		const retried = casWrite(cell, cell.token, (n) => n + 1, { path: "p", byWhom: "b" }, outbox)
		expect(retried).toEqual({ ok: true, token: 2 })
		expect(cell.value).toBe(2)
	})
})
