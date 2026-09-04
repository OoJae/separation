import { ModelContext, type Agent, type InferenceInput, type InterceptionHandler, type SemanticEvent } from "@mozaik-ai/core"
import { EventType, type TurnLifecyclePayload } from "../../events/event-types"
import type { IdentityBook } from "../../participants/identity-book"
import type { Clock } from "../../support/ports"
import type { OutboxDispatcher } from "../../support/outbox"
import { ContextLedger } from "./context-ledger"
import { isWellPaired, repairContextItems } from "./orphan-repair"

export type RunLoopFn = (
	agentId: string,
	message: string,
	inferenceInput: InferenceInput,
	interceptionHandler?: InterceptionHandler,
) => void

export type BeginResult =
	| { readonly ok: true; readonly turnId: string }
	| { readonly ok: false; readonly reason: "already-in-flight" | "halted" }

type Turn = {
	readonly turnId: string
	readonly agentId: string
	readonly agentName: string
	readonly context: ModelContext
	readonly startedAtMs: number
	loopId: string | null
}

/**
 * TurnScheduler — turn lifecycle, context ownership, and the quiescence set.
 *
 * Three problems solved at once, all forced by the shipped runtime:
 *
 * 1. CONTEXT OWNERSHIP (API-NOTES #4). Every turn gets a fresh, unshared
 *    `new ModelContext(turnId, ledger.snapshot())`. Sharing `agent.getMemory().getContext()`
 *    across concurrent turns corrupts tool-call pairing and 400s the provider.
 *
 * 2. turnId <-> loopId CORRELATION. `runLoop` returns `void` and never exposes its loopId,
 *    which appears to make turn-level tracking impossible. But every event mozaik publishes
 *    carries `loopId` in its payload. So by enforcing AT MOST ONE in-flight loop per agent,
 *    the first event observed for that agent after `begin()` binds turnId <-> loopId
 *    unambiguously. That single trick is what makes this class — and the quiescence proof —
 *    possible at all.
 *
 * 3. QUIESCENCE (API-NOTES #13). In-flight is keyed on TURN lifecycle, never on
 *    `function_call.started`/`completed` pairing: an unknown tool name publishes `started`
 *    and then returns early WITHOUT publishing `completed`, so a pairing-based counter would
 *    leak and the quiescence proof would hang forever.
 */
export class TurnScheduler {
	private readonly ledgers = new Map<string, ContextLedger>()
	private readonly turnsById = new Map<string, Turn>()
	private readonly turnByAgent = new Map<string, Turn>()
	private readonly loopToTurn = new Map<string, string>()
	private readonly halted = new Set<string>()
	private counter = 0

	constructor(
		private readonly deps: {
			readonly runLoop: RunLoopFn
			readonly outbox: OutboxDispatcher
			readonly clock: Clock
			readonly identity: IdentityBook
		},
	) {}

	ledgerFor(agent: Agent): ContextLedger {
		let ledger = this.ledgers.get(agent.getId())
		if (!ledger) {
			ledger = ContextLedger.forAgent(agent)
			this.ledgers.set(agent.getId(), ledger)
		}
		return ledger
	}

	/** Start a turn. Refuses if this agent already has one in flight — that is the invariant. */
	begin(
		agent: Agent,
		message: string,
		template: Omit<InferenceInput, "context">,
		interception?: InterceptionHandler,
	): BeginResult {
		const agentId = agent.getId()
		if (this.halted.has(agentId)) return { ok: false, reason: "halted" }
		if (this.turnByAgent.has(agentId)) return { ok: false, reason: "already-in-flight" }

		const turnId = `t${++this.counter}:${agent.getManifest().name}`
		const context = this.ledgerFor(agent).freshContext(turnId)
		const turn: Turn = {
			turnId,
			agentId,
			agentName: agent.getManifest().name,
			context,
			startedAtMs: this.deps.clock.nowMs(),
			loopId: null,
		}

		this.turnsById.set(turnId, turn)
		this.turnByAgent.set(agentId, turn)

		this.deps.outbox.publish<TurnLifecyclePayload>(EventType.TURN_STARTED, agentId, {
			turnId,
			agentName: turn.agentName,
		})

		this.deps.runLoop(agentId, message, { ...template, context }, interception)
		return { ok: true, turnId }
	}

	/**
	 * Feed every observed event here (from a catch-all situation handler). Binds loopId on
	 * first sight and closes the turn on `model.answer`.
	 */
	observe(event: SemanticEvent): void {
		const payload = event.payload as { loopId?: string } | undefined
		const loopId = payload?.loopId
		if (typeof loopId !== "string") return

		let turnId = this.loopToTurn.get(loopId)
		if (turnId === undefined) {
			// First event for this loop: bind it to whichever turn this agent has in flight.
			const turn = this.turnByAgent.get(event.producerId)
			if (!turn || turn.loopId !== null) return
			turn.loopId = loopId
			this.loopToTurn.set(loopId, turn.turnId)
			turnId = turn.turnId
		}

		if (event.type === "model.answer") this.end(turnId, "completed")
	}

	/** Close a turn: harvest the context, repair orphans, adopt into the ledger. */
	end(turnId: string, reason: string): void {
		const turn = this.turnsById.get(turnId)
		if (!turn) return

		const harvested = turn.context.getItems()
		const repaired = repairContextItems(harvested, `[turn ${reason}: ${turnId}]`)
		const ledger = this.ledgers.get(turn.agentId)
		if (ledger) ledger.adopt(repaired)

		this.turnsById.delete(turnId)
		this.turnByAgent.delete(turn.agentId)
		if (turn.loopId) this.loopToTurn.delete(turn.loopId)

		this.deps.outbox.publish<TurnLifecyclePayload>(EventType.TURN_ENDED, turn.agentId, {
			turnId,
			agentName: turn.agentName,
			reason,
		})
	}

	/** Preempt a turn. The reason lands in the agent's context as a function_call_output. */
	abort(turnId: string, reason: string): void {
		this.end(turnId, `aborted: ${reason}`)
	}

	markHalted(agentId: string): void {
		this.halted.add(agentId)
		const turn = this.turnByAgent.get(agentId)
		if (turn) this.end(turn.turnId, "halted")
	}

	inflight(): readonly string[] {
		return [...this.turnsById.keys()]
	}

	turnFor(agentId: string): string | null {
		return this.turnByAgent.get(agentId)?.turnId ?? null
	}

	/** Quiescence is PROVED over an empty in-flight set, never declared. */
	isQuiescent(): boolean {
		return this.turnsById.size === 0
	}

	/** Debug aid for tests: is this agent's ledger internally consistent? */
	ledgerWellPaired(agent: Agent): boolean {
		const ledger = this.ledgers.get(agent.getId())
		return ledger ? isWellPaired(ledger.snapshot()) : true
	}
}
