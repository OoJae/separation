import type { Tool } from "@mozaik-ai/core"
import type { AircraftState, Callsign } from "../../domain/airspace/aircraft-state"
import { isAdmissibleTurnRate, normaliseMdeg } from "../../domain/airspace/units"

/** Approach-speed envelope for the aircraft in this sector. Outside it, a clearance is nonsense. */
const MIN_GROUNDSPEED_KT = 120
const MAX_GROUNDSPEED_KT = 350
import { probe } from "../../domain/feasibility/prober"
import { DESCENT_FPM } from "../../scenarios/braid-2"
import type { IntentRegistry } from "../../domain/interlock/intent-registry"
import type { OutboxDispatcher } from "../../support/outbox"
import type { QueryDesk } from "./query-desk"
import { COMMIT_TOOL } from "../interlock-desk"

export const ControllerEvent = {
	INTENT_FORMING: "intent.forming",
	OBJECTION_RAISED: "objection.raised",
	PILOT_QUERIED: "pilot.queried",
} as const

export type IntentFormingPayload = {
	readonly controller: string
	readonly callsign: Callsign
	readonly clearanceId: string
	readonly command: AircraftState extends never ? never : { targetAltFt?: number; targetHeadingMdeg?: number }
	readonly plannedMarginNm: number
}

export type ControllerToolDeps = {
	readonly position: string
	readonly world: () => readonly AircraftState[]
	readonly generation: () => number
	readonly nowSec: () => number
	readonly outbox: OutboxDispatcher
	readonly participantId: () => string
	readonly horizonSec: number
	/** Announced-but-uncommitted intents, shared with the interlock desk. */
	readonly intents: IntentRegistry
	/** Ask-and-wait. Present only when pilots exist; without it, query_pilot is unavailable. */
	readonly queryDesk?: QueryDesk
}

/**
 * The multi-hop controller turn:
 *
 *   assess_traffic -> probe_feasible -> query_pilot? -> propose_clearance -> commit_clearance
 *
 * The shape is the point. A single-shot turn has ONE transition boundary; this one has five, and
 * each is a place the interlock or the sentinel can intervene. The dense boundaries are what make
 * a peer's objection land INSIDE a turn rather than after it.
 */
export function controllerTools(deps: ControllerToolDeps): Tool[] {
	const proposed = new Map<string, { callsign: Callsign; command: Record<string, number> }>()

	return [
		{
			type: "function",
			name: "assess_traffic",
			description: "Read the current traffic picture: every aircraft's position, altitude, heading and speed.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
			strict: true,
			invoke: async () => ({
				generation: deps.generation(),
				tSim: deps.nowSec(),
				traffic: deps.world().map((a) => ({
					callsign: a.callsign, x: a.x, y: a.y, altFt: a.altFt,
					headingDeg: a.headingMdeg / 1000, groundspeedKt: a.groundspeedKt,
				})),
			}),
		},
		{
			type: "function",
			name: "probe_feasible",
			description: "Get the separation-safe manoeuvre options for one aircraft, with their costs. This is a SET, not a ranking — the ordering is meaningless.",
			parameters: {
				type: "object",
				properties: { callsign: { type: "string" } },
				required: ["callsign"], additionalProperties: false,
			},
			strict: true,
			invoke: async ({ callsign }: { callsign: string }) => {
				const set = probe({
					subject: callsign, world: deps.world(), forGeneration: deps.generation(),
					horizonSec: deps.horizonSec, nowSec: deps.nowSec(),
				})
				return {
					ordering: set.ordering,
					options: set.options.map((o) => ({
						optionId: o.optionId, label: o.maneuver.label, axis: o.maneuver.axis,
						command: o.maneuver.command, margins: o.margins, cost: o.cost,
					})),
					excluded: set.excluded,
				}
			},
		},
		{
			type: "function",
			name: "query_pilot",
			description: "Ask a pilot a question in plain language and WAIT for the answer. Their reply may reveal constraints invisible from the ground — but waiting costs you part of your manoeuvre window.",
			parameters: {
				type: "object",
				properties: { callsign: { type: "string" }, question: { type: "string" } },
				required: ["callsign", "question"], additionalProperties: false,
			},
			strict: true,
			invoke: async ({ callsign, question }: { callsign: string; question: string }) => {
				deps.outbox.publish(ControllerEvent.PILOT_QUERIED, deps.participantId(), {
					controller: deps.position, callsign, question,
				})
				if (deps.queryDesk === undefined) {
					return { answered: false, reason: "no pilots are reachable in this configuration" }
				}

				// AWAITED. FunctionCallState.run awaits the tool (API-NOTES #7), so this parks the
				// whole controller turn for the length of a pilot's turn. Asking costs window —
				// that is the trade-off, not a bug to engineer around.
				const outcome = await deps.queryDesk.ask({
					askerId: deps.participantId(), fromController: deps.position,
					toCallsign: callsign, question,
				})
				if (!outcome.ok) {
					return { answered: false, reason: outcome.reason, waitedMs: outcome.waitedMs }
				}
				return {
					answered: true, callsign, reply: outcome.text,
					claims: outcome.claims, waitedMs: outcome.waitedMs,
				}
			},
		},
		{
			type: "function",
			name: "propose_clearance",
			description: "Announce the clearance you intend to issue, BEFORE committing it. Peers with overlapping standing may object.",
			parameters: {
				type: "object",
				properties: {
					clearanceId: { type: "string" },
					callsign: { type: "string" },
					targetAltFt: { type: "number" },
					targetHeadingDeg: { type: "number" },
					// The prober offers speed reductions and expedited turns. Until these two were
					// listed HERE the model could not name them: the handler read the fields but the
					// JSON Schema — which is what actually reaches the provider, and which carries
					// additionalProperties:false — did not advertise them. Eight of the eighteen
					// catalogue options were unissuable, and the recorded run shows the model
					// announcing "AAL221-slow-180" and then issuing its present heading and altitude.
					targetGroundspeedKt: { type: "number" },
					turnRateMdegPerS: { type: "number" },
					plannedMarginNm: { type: "number" },
				},
				required: ["clearanceId", "callsign", "plannedMarginNm"], additionalProperties: false,
			},
			strict: false,
			invoke: async (args: {
				clearanceId: string; callsign: string; targetAltFt?: number; targetHeadingDeg?: number
				targetGroundspeedKt?: number; turnRateMdegPerS?: number; plannedMarginNm: number
			}) => {
				const command: Record<string, number> = {}
				if (args.targetAltFt !== undefined && Number.isFinite(args.targetAltFt)) {
					command.targetAltFt = args.targetAltFt
					command.verticalRateFpm = DESCENT_FPM
				}
				if (args.targetHeadingDeg !== undefined && Number.isFinite(args.targetHeadingDeg)) {
					command.targetHeadingMdeg = normaliseMdeg(Math.round(args.targetHeadingDeg) * 1000)
				}
				// The catalogue offers speed reductions, so a controller has to be able to issue one.
				// It could not: this tool had no speed field, so an option the prober published was
				// literally unspeakable and the axis was unreachable from the decision.
				// Validated, not trusted. This is where MODEL OUTPUT becomes world state, and a
				// non-finite speed propagates straight into position: x becomes NaN, every
				// comparison against it is false, and loss of separation stops being detectable at
				// all. A negative speed flies the aircraft backwards. Out-of-envelope values are
				// dropped rather than clamped, so a nonsense clearance is a no-op on that axis
				// instead of a plausible-looking lie.
				if (args.targetGroundspeedKt !== undefined
					&& Number.isFinite(args.targetGroundspeedKt)
					&& args.targetGroundspeedKt >= MIN_GROUNDSPEED_KT
					&& args.targetGroundspeedKt <= MAX_GROUNDSPEED_KT) {
					command.targetGroundspeedKt = Math.round(args.targetGroundspeedKt)
				}
				if (args.turnRateMdegPerS !== undefined && isAdmissibleTurnRate(args.turnRateMdegPerS)) {
					// Guarded, not trusted: an inadmissible rate would leave a fractional milli-degree
					// per step and quietly destroy the exactness the determinism story rests on.
					command.turnRateMdegPerS = args.turnRateMdegPerS
				}
				proposed.set(args.clearanceId, { callsign: args.callsign, command })
				deps.intents.announce({
					id: args.clearanceId, callsign: args.callsign, command,
					committedTick: 0, effectiveTick: 0,
				})

				// THE MECHANISM. Published from INSIDE the tool, before any clearance exists — so a
				// peer can object into this turn while it is still open.
				deps.outbox.publish(ControllerEvent.INTENT_FORMING, deps.participantId(), {
					controller: deps.position,
					callsign: args.callsign,
					clearanceId: args.clearanceId,
					command,
					plannedMarginNm: args.plannedMarginNm,
				})
				return { announced: true, clearanceId: args.clearanceId }
			},
		},
		{
			type: "function",
			name: COMMIT_TOOL,
			description: "Commit a previously proposed clearance. It is held briefly with any peer's pending commit and may be narrowed before it executes.",
			parameters: {
				type: "object",
				properties: { clearanceId: { type: "string" } },
				required: ["clearanceId"], additionalProperties: true,
			},
			strict: false,
			invoke: async (args: { clearanceId: string; callsign?: string; command?: Record<string, number>; narrowedFrom?: string }) => {
				// If the desk narrowed us, the args already carry the narrowed clearance.
				const source = args.command !== undefined
					? { callsign: args.callsign ?? "", command: args.command }
					: proposed.get(args.clearanceId)
				if (!source) return { committed: false, reason: `unknown clearance ${args.clearanceId} — propose it first` }
				return {
					committed: true,
					clearanceId: args.clearanceId,
					callsign: source.callsign,
					command: source.command,
					narrowedFrom: args.narrowedFrom ?? null,
				}
			},
		},
	]
}
