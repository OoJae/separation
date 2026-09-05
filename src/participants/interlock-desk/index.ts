import { FunctionCallItem, ModelMessageItem, Participant } from "@mozaik-ai/core"
import type { ExecutableTransition, InferenceInput, InterceptionHandler } from "@mozaik-ai/core"
import type { AircraftState } from "../../domain/airspace/aircraft-state"
import type { PendingClearance } from "../../domain/airspace/encounter"
import { evaluateJoint, narrowToSafe, type JointHazard } from "../../domain/interlock/joint-prober"
import type { ManeuverWindow } from "../../domain/airspace/maneuver-window"
import type { IntentRegistry } from "../../domain/interlock/intent-registry"
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
	/** Announced intents, so a commit carrying only a clearanceId can be resolved. */
	readonly intents: IntentRegistry
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
export type Objection = {
	readonly by: string
	readonly clearanceId: string
	readonly reason: string
	readonly suggestTargetAltFt?: number
}

export class InterlockDesk extends Participant {
	private readonly pending = new PendingSet()
	private readonly decisions: DeskDecision[] = []
	private readonly objections = new Map<string, Objection>()
	private counter = 0
	/** turnId -> ms of settle actually granted before adjudication. RETRACE checks this. */
	private readonly settleGranted = new Map<string, number>()

	/**
	 * A participant, because it announces — held, narrowed, released — and `sendEvent` refuses a
	 * sender that has not joined. It also makes the thesis literal: everything that matters is on
	 * the bus, the airlock included. No loop, no model: it exercises authority over TIMING only.
	 */
	private constructor(private readonly deps: InterlockDeskDeps) {
		super({ id: "interlock-desk", name: "interlock-desk", role: "agent", capabilities: ["airlock"] }, [])
	}

	static init(deps: InterlockDeskDeps): InterlockDesk {
		return new InterlockDesk(deps)
	}

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

	/**
	 * A peer's objection against a clearance that may still be forming. Recorded now, applied at
	 * adjudication — which is why it can land INSIDE a turn: the objected-to controller is
	 * suspended in the airlock at that moment, and its commit has not executed yet.
	 */
	object(objection: Objection): void {
		this.objections.set(objection.clearanceId, objection)
	}

	objectionsSeen(): number {
		return this.objections.size
	}

	/** How long each held commit actually waited before it was adjudicated. */
	settleWindows(): ReadonlyMap<string, number> {
		return this.settleGranted
	}

	settleMs(): number {
		return this.deps.settleMs
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
				const parsed = desk.parse(call)

				if (parsed === "malformed") {
					// An instruction nobody can read must never reach the aircraft by skipping the
					// checks that exist to catch it. SUBSTITUTE rather than pass through — an
					// InterceptionHandler cannot halt a turn (API-NOTES #1), so the honest refusal
					// is to replace the action with a message the controller then reasons about.
					desk.deps.outbox.publish(WorldEvent.COMMAND_REJECTED, desk.getId(), {
						reason: "malformed commit_clearance — refused before the airlock",
						callId: call.callId,
					})
					return {
						nextStateId: "model_message",
						input: {
							answer: ModelMessageItem.rehydrate({
								text: "[refused] Your commit_clearance could not be read, so it was not issued. Re-issue it with a clearanceId you have already proposed.",
							}),
						},
					}
				}

				// "unresolved" is a legitimate outcome: the tool answers "unknown clearance X —
				// propose it first", which is a real refusal the model reads. Passing it through
				// preserves that path.
				if (parsed === "unresolved") return transition
				const clearance = parsed

				const turnId = `turn-${++desk.counter}`
				desk.deps.outbox.publish(WorldEvent.COMMAND_ACCEPTED, desk.getId(), {
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

	/**
	 * Inspect the pending set — the one thing that must be serialized.
	 *
	 * FIXED (Phase 6, found by RETRACE). This used to drain the WHOLE set on whichever timer fired
	 * first, so a commit arriving 30 ms after its peer was adjudicated on the peer's earlier timer
	 * and got 20 ms of a promised 50 ms settle window. It silently received less objection
	 * opportunity than the airlock advertises — and precisely when the sector is busiest, which is
	 * exactly when a peer is most likely to object.
	 *
	 * Only turns whose OWN settle has elapsed are adjudicated; the rest wait for their own timer.
	 * The joint inspection is preserved, because a turn that is ready is still evaluated against
	 * every clearance currently pending, ready or not.
	 */
	private adjudicate(): void {
		const nowMs = this.deps.clock.nowMs()
		const all = this.pending.entries()
		const held = all.filter((t) => nowMs - t.heldAtMs >= this.deps.settleMs)
		if (held.length === 0) return

		const verdict = evaluateJoint({
			world: this.deps.world(),
			// Every pending clearance, not just the ready ones: a hazard living in the
			// intersection does not care whose settle window has elapsed.
			pending: all.map((h) => h.clearance),
			windows: this.deps.windows,
			atMs: this.deps.clock.nowMs(),
			horizonSec: this.deps.horizonSec,
		})

		for (const turn of held) {
			this.settleGranted.set(turn.turnId, nowMs - turn.heldAtMs)
			const hazard = verdict.hazards.find((h) => h.clearanceIds.includes(turn.clearance.id)) ?? null
			const objection = this.objections.get(turn.clearance.id) ?? null
			let outcome: DeskDecision["outcome"] = "clean"
			let committed = turn.clearance

			if (hazard !== null || objection !== null) {
				const others = all.filter((h) => h.turnId !== turn.turnId).map((h) => h.clearance)
				// A peer's counter-proposal is tried FIRST — the objector said what it would accept.
				const candidates = [
					...(objection?.suggestTargetAltFt !== undefined
						? [{ ...turn.clearance, id: `${turn.clearance.id}/peer-${objection.suggestTargetAltFt}`,
							command: { ...turn.clearance.command, targetAltFt: objection.suggestTargetAltFt } }]
						: []),
					...this.deps.narrowingCandidates(turn.clearance),
				]
				const narrowed = narrowToSafe({
					world: this.deps.world(),
					others,
					subject: turn.clearance,
					candidates,
					horizonSec: this.deps.horizonSec,
				})
				if (narrowed !== null) {
					outcome = "narrowed"
					committed = narrowed
					this.deps.outbox.publish(WorldEvent.COMMAND_ACCEPTED, this.getId(), {
						event: "interlock.narrowed", turnId: turn.turnId,
						from: turn.clearance.id, to: narrowed.id,
					})
				} else {
					outcome = "deferred"
				}
			}

			this.decisions.push({ turnId: turn.turnId, outcome, committed, hazard })
			this.objections.delete(turn.clearance.id)
			this.pending.remove(turn.turnId)
			turn.release(committed)
		}
	}

	/**
	 * Read a pending commit. THREE outcomes, not two — and the distinction is load-bearing.
	 *
	 * This used to return `null` for all three failures, and the call site did `return transition`,
	 * so an unreadable commit passed through UNTOUCHED: no airlock hold, no joint-hazard check, no
	 * premise check. A path around the mechanism this project is named after, in that mechanism's
	 * own file.
	 *
	 *   "malformed"   unparseable JSON, or no clearanceId. Nobody can act on this. REFUSE it.
	 *   "unresolved"  well-formed, but names a clearance never proposed. LEGITIMATE — the tool
	 *                 itself answers "unknown clearance X — propose it first", which is a real
	 *                 refusal the model reads. Refusing here too would break that path.
	 *   a clearance   hold it in the airlock, as designed.
	 *
	 * A commit may also carry the full clearance (after a narrowing rewrote it) or only a
	 * clearanceId, since a model proposes by id and commits by id — hence the intent registry.
	 * Structural reads throughout: payloads lose their prototype in transit (API-NOTES #12).
	 */
	private parse(call: FunctionCallItem): PendingClearance | "malformed" | "unresolved" {
		let args: {
			clearanceId?: string
			callsign?: string
			command?: PendingClearance["command"]
			committedTick?: number
			effectiveTick?: number
		}
		try {
			args = JSON.parse(call.args)
		} catch {
			return "malformed"
		}
		if (typeof args.clearanceId !== "string") return "malformed"

		if (typeof args.callsign === "string" && args.command !== undefined) {
			return {
				id: args.clearanceId,
				callsign: args.callsign,
				command: args.command,
				committedTick: args.committedTick ?? 0,
				effectiveTick: args.effectiveTick ?? 0,
			}
		}
		return this.deps.intents.resolve(args.clearanceId) ?? "unresolved"
	}
}
