import { FunctionCallItem } from "@mozaik-ai/core"
import type { ExecutableTransition, InferenceInput, InterceptionHandler } from "@mozaik-ai/core"
import type { AircraftState } from "../../domain/airspace/aircraft-state"
import type { PendingClearance } from "../../domain/airspace/encounter"
import { evaluateJoint, narrowToSafe, type JointHazard } from "../../domain/interlock/joint-prober"
import type { ManeuverWindow } from "../../domain/airspace/maneuver-window"
import { WorldEvent } from "../../events/world-events"
import type { OutboxDispatcher } from "../../support/outbox"
import type { Clock } from "../../support/ports"
import { PendingSet } from "./pending-set"

export const COMMIT_TOOL = "commit_clearance"

export type DeskDecision = {
	readonly turnId: string
	readonly outcome: "clean" | "narrowed" | "deferred"
	readonly committed: PendingClearance
	readonly hazard: JointHazard | null
}

export type InterlockDeskDeps = {
	readonly world: () => readonly AircraftState[]
	readonly windows: ReadonlyMap<string, ManeuverWindow>
	readonly horizonSec: number
	readonly clock: Clock
	readonly outbox: OutboxDispatcher
	/**
	 * How long the desk holds a commit waiting for a peer's to arrive. This is the ONE genuine
	 * serialization point in the design and it is deliberately short: it bounds inspection of the
	 * set, never anyone's deliberation.
	 */
	readonly settleMs: number
	/** Alternatives to try when a joint hazard is found, most useful first. */
	readonly narrowingCandidates: (subject: PendingClearance) => readonly PendingClearance[]
}

/**
 * InterlockDesk — an InterceptionHandler that HOLDS a pending `commit_clearance` mid-turn.
 *
 * The holding is real, not a metaphor. `AgentLoop.run` awaits `handle()` inside its loop, so
 * awaiting here suspends THAT agent while every other participant carries on — verified
 * end-to-end before this was written. The controller is frozen between deciding and acting, which
 * is the only interval in which a peer's half-formed intention can still change its mind.
 *
 * On a joint hazard the desk does NOT refuse. It resumes the call with NARROWED ARGUMENTS via
 * `FunctionCallItem.rehydrate`, and because mozaik's own transition rule appends the
 * POST-interception call to context, the controller's next inference sees that it was narrowed
 * and reasons about it. A refusal would make this a veto with extra steps; a narrowing keeps the
 * aircraft's objective reachable.
 */
export class InterlockDesk {
	private readonly pending = new PendingSet()
	private readonly decisions: DeskDecision[] = []
	private counter = 0

	constructor(private readonly deps: InterlockDeskDeps) {}

	pendingSize(): number {
		return this.pending.size()
	}

	log(): readonly DeskDecision[] {
		return this.decisions
	}

	/** Quiescence: nothing is half-committed. */
	isQuiescent(): boolean {
		return this.pending.isEmpty()
	}

	handler(): InterceptionHandler {
		const desk = this
		return {
			isSatisfiedBy(transition: ExecutableTransition): boolean {
				if (transition.nextStateId !== "function_call") return false
				const { call } = transition.input as { call: FunctionCallItem }
				return call.name === COMMIT_TOOL
			},

			async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
				const { call, inferenceInput } = transition.input as {
					call: FunctionCallItem
					inferenceInput: InferenceInput
				}
				const clearance = desk.parse(call)
				if (clearance === null) return transition

				const turnId = `turn-${++desk.counter}`
				desk.deps.outbox.publish(WorldEvent.COMMAND_ACCEPTED, "interlock-desk", {
					event: "interlock.held", turnId, clearanceId: clearance.id, pendingSetSize: desk.pending.size() + 1,
				})

				// THE AIRLOCK. Awaiting here suspends this controller and nobody else.
				const outcome = await desk.hold(turnId, clearance)

				if (outcome.id === clearance.id) return transition

				// Narrowed: rebuild the pending call so the REWRITTEN one is what executes and
				// what lands in the agent's context.
				return {
					nextStateId: "function_call",
					input: {
						call: FunctionCallItem.rehydrate({
							callId: call.callId,
							name: call.name,
							args: JSON.stringify({
								clearanceId: outcome.id,
								callsign: outcome.callsign,
								command: outcome.command,
								narrowedFrom: clearance.id,
							}),
						}),
						inferenceInput,
					},
				}
			},
		}
	}

	private hold(turnId: string, clearance: PendingClearance): Promise<PendingClearance> {
		return new Promise<PendingClearance>((resolve) => {
			this.pending.add({ turnId, clearance, heldAtMs: this.deps.clock.nowMs(), release: resolve })
			// Give a peer's commit a chance to arrive, then inspect the whole set at once.
			this.deps.clock.after(this.deps.settleMs, () => this.adjudicate())
		})
	}

	/** Inspect the WHOLE pending set at once — the one thing that must be serialized. */
	private adjudicate(): void {
		const held = this.pending.entries()
		if (held.length === 0) return

		const verdict = evaluateJoint({
			world: this.deps.world(),
			pending: held.map((h) => h.clearance),
			windows: this.deps.windows,
			atMs: this.deps.clock.nowMs(),
			horizonSec: this.deps.horizonSec,
		})

		for (const turn of held) {
			const hazard = verdict.hazards.find((h) => h.clearanceIds.includes(turn.clearance.id)) ?? null
			let outcome: DeskDecision["outcome"] = "clean"
			let committed = turn.clearance

			if (hazard !== null) {
				const others = held.filter((h) => h.turnId !== turn.turnId).map((h) => h.clearance)
				const narrowed = narrowToSafe({
					world: this.deps.world(),
					others,
					subject: turn.clearance,
					candidates: this.deps.narrowingCandidates(turn.clearance),
					horizonSec: this.deps.horizonSec,
				})
				if (narrowed !== null) {
					outcome = "narrowed"
					committed = narrowed
					this.deps.outbox.publish(WorldEvent.COMMAND_ACCEPTED, "interlock-desk", {
						event: "interlock.narrowed", turnId: turn.turnId,
						from: turn.clearance.id, to: narrowed.id,
					})
				} else {
					outcome = "deferred"
				}
			}

			this.decisions.push({ turnId: turn.turnId, outcome, committed, hazard })
			this.pending.remove(turn.turnId)
			turn.release(committed)
		}
	}

	/** Structural read — event and tool payloads lose their prototype (API-NOTES #12). */
	private parse(call: FunctionCallItem): PendingClearance | null {
		try {
			const args = JSON.parse(call.args) as {
				clearanceId?: string
				callsign?: string
				command?: PendingClearance["command"]
				committedTick?: number
				effectiveTick?: number
			}
			if (typeof args.clearanceId !== "string" || typeof args.callsign !== "string" || args.command === undefined) {
				return null
			}
			return {
				id: args.clearanceId,
				callsign: args.callsign,
				command: args.command,
				committedTick: args.committedTick ?? 0,
				effectiveTick: args.effectiveTick ?? 0,
			}
		} catch {
			return null
		}
	}
}
