import { ModelMessageItem, Participant } from "@mozaik-ai/core"
import type { ExecutableTransition, FunctionCallItem, InterceptionHandler } from "@mozaik-ai/core"
import type { AircraftState } from "../../domain/airspace/aircraft-state"
import { flyEncounter } from "../../domain/airspace/encounter"
import { LATERAL_MINIMUM_NM } from "../../domain/airspace/separation-standard"
import { EventType } from "../../events/event-types"
import type { OutboxDispatcher } from "../../support/outbox"
import { COMMIT_TOOL } from "../interlock-desk"

/**
 * PremiseSentinel — invalidate a premise that has ACTUALLY died, and only then.
 *
 * It intercepts a pending commit and re-checks the margin the controller was reasoning toward.
 * If that margin has genuinely gone negative — because the world moved while the controller was
 * thinking — the commit is SUBSTITUTED with a model_message before it can become an action.
 *
 * MARGIN-BASED, NEVER GENERATION-BASED. The original design preempted on world-generation delta,
 * which measures the AGE of a premise, not its VALIDITY. Age is not invalidity: a controller
 * reasoning about a slowly-evolving situation would have been preempted constantly for no reason.
 * That was the tuning cliff. Re-checking the actual margin removes it entirely.
 *
 * Substitution, not halting: an InterceptionHandler cannot halt a turn (API-NOTES #1).
 */
export class PremiseSentinel extends Participant {
	private invalidated = 0

	private constructor(
		private readonly deps: {
			readonly world: () => readonly AircraftState[]
			readonly horizonSec: number
			readonly outbox: OutboxDispatcher
		},
	) {
		super({ id: "premise-sentinel", name: "premise-sentinel", role: "agent", capabilities: ["premise.check"] }, [])
	}

	static init(deps: {
		readonly world: () => readonly AircraftState[]
		readonly horizonSec: number
		readonly outbox: OutboxDispatcher
	}): PremiseSentinel {
		return new PremiseSentinel(deps)
	}

	invalidations(): number {
		return this.invalidated
	}

	handler(): InterceptionHandler {
		const sentinel = this
		return {
			isSatisfiedBy(transition: ExecutableTransition): boolean {
				if (transition.nextStateId !== "function_call") return false
				const { call } = transition.input as { call: FunctionCallItem }
				return call.name === COMMIT_TOOL
			},
			async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
				const { call } = transition.input as { call: FunctionCallItem }
				const premise = sentinel.parse(call)
				if (premise === null) return transition

				const subject = sentinel.deps.world().find((a) => a.callsign === premise.callsign)
				if (!subject) return transition

				// Re-fly THIS clearance against the world AS IT IS NOW.
				let worstMargin = Number.POSITIVE_INFINITY
				for (const other of sentinel.deps.world()) {
					if (other.callsign === premise.callsign) continue
					const r = flyEncounter([subject, other], [{
						id: premise.clearanceId, callsign: premise.callsign, command: premise.command,
						committedTick: 0, effectiveTick: 0,
					}], sentinel.deps.horizonSec)
					if (r.loss !== null) worstMargin = Math.min(worstMargin, r.minHorizontalNm - LATERAL_MINIMUM_NM)
				}

				if (worstMargin >= 0) return transition // premise still holds — do nothing

				sentinel.invalidated += 1
				sentinel.deps.outbox.publish(EventType.PREMISE_INVALIDATED, sentinel.getId(), {
					clearanceId: premise.clearanceId, callsign: premise.callsign, marginNm: worstMargin,
				})
				sentinel.deps.outbox.publish(EventType.TRANSITION_SUBSTITUTED, sentinel.getId(), {
					clearanceId: premise.clearanceId, discardedFrom: "function_call", replacedWith: "model_message",
				})
				return {
					nextStateId: "model_message",
					input: {
						answer: ModelMessageItem.rehydrate({
							text: `[premise invalidated] The margin for ${premise.clearanceId} on ${premise.callsign} has gone negative (${worstMargin.toFixed(2)} NM) while you were deciding. Reassess before committing.`,
						}),
					},
				}
			},
		}
	}

	private parse(call: FunctionCallItem): { clearanceId: string; callsign: string; command: AircraftState extends never ? never : Record<string, number> } | null {
		try {
			const args = JSON.parse(call.args) as { clearanceId?: string; callsign?: string; command?: Record<string, number> }
			if (typeof args.clearanceId !== "string" || typeof args.callsign !== "string" || !args.command) return null
			return { clearanceId: args.clearanceId, callsign: args.callsign, command: args.command }
		} catch {
			return null
		}
	}
}
