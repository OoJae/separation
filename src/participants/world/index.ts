import { Participant, SituationSpecification } from "@mozaik-ai/core"
import type { SituationContext, SituationHandler } from "@mozaik-ai/core"
import type { Command } from "../../domain/airspace/aircraft-state"
import { WorldEvent } from "../../events/world-events"
import type { TickOutput, WorldEngine } from "../../infrastructure/simulation/world-engine"
import type { OutboxDispatcher } from "../../support/outbox"

/**
 * The World, as a participant.
 *
 * It is NOT a coordinator. It grants nothing, assigns nothing, and gates nobody's right to act —
 * it publishes observation and applies commands. That is the whole reason it has no model and no
 * loop: it exercises no authority, so it never needs a turn.
 *
 * Every processor here is SYNCHRONOUS and never throws. `EventProcessor.process` has no `await`
 * and no `try/catch` (docs/API-NOTES.md #15), so a throwing processor would escape into whoever
 * published and starve every participant after it in the fan-out. A rejected command is therefore
 * an EVENT, not an exception.
 */
export class WorldParticipant extends Participant {
	private constructor(
		handlers: SituationHandler[],
		private readonly engine: WorldEngine,
		private readonly outbox: OutboxDispatcher,
	) {
		super(
			{ id: "world", name: "world", role: "agent", capabilities: ["airspace.truth"] },
			handlers,
		)
	}

	static init(deps: { engine: WorldEngine; outbox: OutboxDispatcher }): WorldParticipant {
		const world = new WorldParticipant([], deps.engine, deps.outbox)
		world.setHandlers([world.commandHandler()])
		return world
	}

	/** Publish everything one tick produced. Called by the driver, not by the bus. */
	publishTick(output: TickOutput): void {
		for (const closure of output.closures) {
			this.outbox.publish(WorldEvent.PAIR_CLOSURE, this.getId(), closure)
		}
		if (output.snapshot !== null) {
			this.outbox.publish(WorldEvent.SNAPSHOT, this.getId(), output.snapshot)
		}
		for (const loss of output.losses) {
			this.outbox.publish(WorldEvent.SEPARATION_LOST, this.getId(), loss)
		}
	}

	private commandHandler(): SituationHandler {
		const world = this
		class WhenCommandIssued extends SituationSpecification {
			isSatisfiedBy({ event }: SituationContext): boolean {
				return event.type === WorldEvent.COMMAND_ISSUED
			}
		}
		return {
			specification: new WhenCommandIssued(),
			processor: {
				apply({ event }) {
					// Structural read, never `instanceof` — payloads lose their prototype in
					// transit through the loop visitor (API-NOTES #12, #17).
					const payload = event.payload as { callsign?: string; command?: Command }
					const callsign = payload.callsign
					if (typeof callsign !== "string" || payload.command === undefined) {
						world.outbox.publish(WorldEvent.COMMAND_REJECTED, world.getId(), {
							reason: "malformed command payload",
						})
						return
					}
					const result = world.engine.command(callsign, payload.command)
					if (result.ok) {
						world.outbox.publish(WorldEvent.COMMAND_ACCEPTED, world.getId(), { callsign })
					} else {
						world.outbox.publish(WorldEvent.COMMAND_REJECTED, world.getId(), {
							callsign, reason: result.reason,
						})
					}
				},
			},
		}
	}
}
