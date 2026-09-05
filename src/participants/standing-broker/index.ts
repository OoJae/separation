import { Participant, SituationSpecification } from "@mozaik-ai/core"
import type { SituationContext, SituationHandler } from "@mozaik-ai/core"
import type { Callsign } from "../../domain/airspace/aircraft-state"
import { VersionedCell } from "../../domain/cell/versioned-cell"
import { standingKey } from "../../domain/lease/lease-key"
import { emptyRegistry, holdersOf, withGrant, type RegistryState } from "../../domain/lease/lease-registry"
import { casWrite } from "../../state/cas-write"
import { WorldEvent } from "../../events/world-events"
import type { OutboxDispatcher } from "../../support/outbox"
import type { Clock } from "../../support/ports"
import { seam } from "../../retrace/schedule"

export const StandingEvent = {
	BID: "standing.bid",
	GRANTED: "standing.granted",
	DENIED: "standing.denied",
} as const

export type BidPayload = {
	readonly controller: string
	readonly callsign: Callsign
	readonly objective: string
	readonly durationMs: number
}

/**
 * The authority market.
 *
 * Standing is MULTIPLY HELD: two controllers legally hold one callsign under different objectives,
 * because objectives are different lease keys (Phase 2's one-mechanism-two-scopes registry). That
 * overlap is not a bug being tolerated — it is what puts two language models on the same aircraft
 * at the same time, which is the whole point.
 *
 * Every grant AND every denial is announced. Whatever a boundary enforces, it must also announce.
 * The registry is mutated only through casWrite, so a stale bid is rejected and announced too.
 */
export class StandingBroker extends Participant {
	private readonly registries = new Map<Callsign, VersionedCell<RegistryState>>()

	private constructor(
		handlers: SituationHandler[],
		private readonly outbox: OutboxDispatcher,
		private readonly clock: Clock,
	) {
		super({ id: "standing-broker", name: "standing-broker", role: "agent", capabilities: ["authority.market"] }, handlers)
	}

	static init(deps: { outbox: OutboxDispatcher; clock: Clock }): StandingBroker {
		const broker = new StandingBroker([], deps.outbox, deps.clock)
		broker.setHandlers([broker.bidHandler()])
		return broker
	}

	holdersOver(callsign: Callsign): readonly string[] {
		const cell = this.registries.get(callsign)
		return cell ? holdersOf(cell.value, this.clock.nowMs()) : []
	}

	holds(controller: string, callsign: Callsign): boolean {
		const cell = this.registries.get(callsign)
		if (!cell) return false
		const now = this.clock.nowMs()
		return cell.value.leases.some(
			(l) => l.holder.kind === "controller" && l.holder.controller === controller
				&& (l.expiresAtMs === null || now < l.expiresAtMs),
		)
	}

	/**
	 * Bid directly — used by tools, tests, and the composition root before the bus is live.
	 *
	 * ASYNC, and therefore the path where an interleaving is actually possible. The situation-
	 * processor path below is synchronous and stays synchronous, because a processor may never be
	 * async (docs/API-NOTES.md #15). So the read-compute-write in `processBid` is protected there
	 * by a structural rule, and exposed HERE, where a caller can await either side of it.
	 *
	 * The `seam` is a no-op under the default schedule. RETRACE turns it into a real yield to find
	 * out what happens when two bids interleave across the read-compute-write.
	 */
	async bid(payload: BidPayload): Promise<void> {
		await seam("broker:bid:before-read")
		this.processBid(payload)
	}

	/** Synchronous entry point, for the processor path where async is forbidden. */
	bidSync(payload: BidPayload): void {
		this.processBid(payload)
	}

	private registryFor(callsign: Callsign): VersionedCell<RegistryState> {
		let cell = this.registries.get(callsign)
		if (!cell) {
			cell = VersionedCell.init(emptyRegistry(callsign))
			this.registries.set(callsign, cell)
		}
		return cell
	}

	private processBid(payload: BidPayload): void {
		const cell = this.registryFor(payload.callsign)
		// Read the token BEFORE computing the grant. Previously this was read at the moment of the
		// write, i.e. compared against itself — a tautology that could never fail. RETRACE showed
		// the site is currently unreachable (withGrant denies a conflicting bid first, so the CAS
		// is dead code rather than a live defect), but a safety mechanism that cannot fire is not
		// a safety mechanism, and the next maintainer to add an await here deserves a real one.
		const expectedToken = cell.token
		const now = this.clock.nowMs()
		const key = standingKey(payload.callsign, payload.objective)
		const grant = withGrant(cell.value, {
			key,
			holder: { kind: "controller", controller: payload.controller, clearanceId: "" },
			nowMs: now,
			expiresAtMs: now + payload.durationMs,
		})

		if (!grant.ok) {
			this.outbox.publish(StandingEvent.DENIED, this.getId(), {
				controller: payload.controller, callsign: payload.callsign, objective: payload.objective,
				reason: grant.reason, ...(grant.reason === "already-held" ? { heldBy: grant.holder } : {}),
			})
			return
		}

		// THE single write path. A stale token is rejected and announced, never retried silently.
		//
		const written = casWrite(cell, expectedToken, () => grant.next,
			{ path: `standing.${payload.callsign}`, byWhom: payload.controller }, this.outbox)
		if (!written.ok) {
			// A losing writer must be TOLD. Previously this returned silently, so a bidder that
			// lost a CAS would wait forever on a reply that never came — and in a system where
			// silence is read as consent, that is the worst available failure.
			this.outbox.publish(StandingEvent.DENIED, this.getId(), {
				controller: payload.controller, callsign: payload.callsign, objective: payload.objective,
				reason: "cas-rejected", expectedToken, actualToken: written.actual,
			})
			return
		}

		this.outbox.publish(StandingEvent.GRANTED, this.getId(), {
			controller: payload.controller, callsign: payload.callsign, objective: payload.objective,
			leaseId: grant.lease.leaseId, generation: grant.lease.generation, expiresAtMs: grant.lease.expiresAtMs,
			nowHolding: holdersOf(grant.next, now),
		})
	}

	private bidHandler(): SituationHandler {
		const broker = this
		class WhenBid extends SituationSpecification {
			isSatisfiedBy({ event }: SituationContext): boolean { return event.type === StandingEvent.BID }
		}
		return {
			specification: new WhenBid(),
			processor: {
				apply({ event }) {
					const p = event.payload as Partial<BidPayload>
					if (typeof p.controller !== "string" || typeof p.callsign !== "string" || typeof p.objective !== "string") {
						broker.outbox.publish(WorldEvent.COMMAND_REJECTED, broker.getId(), { reason: "malformed bid" })
						return
					}
					broker.bidSync({ controller: p.controller, callsign: p.callsign, objective: p.objective, durationMs: p.durationMs ?? 10_000 })
				},
			},
		}
	}
}
