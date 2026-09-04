import type { ExecutableTransition, InterceptionHandler, SemanticEvent } from "@mozaik-ai/core"
import type { IdentityBook } from "../identity-book"
import type { Clock } from "../../support/ports"
import { LoopAlias } from "./loop-alias"

export type TapeEntry =
	| {
			readonly kind: "transition"
			readonly obs: number
			readonly tSim: number
			readonly nextStateId: string
			readonly digest: string
	  }
	| {
			readonly kind: "event"
			readonly obs: number
			readonly tSim: number
			readonly type: string
			readonly producer: string
			readonly seq: number | null
			readonly loopId: string | null
	  }

/**
 * Recorder — the RETRACE seat (Phase 6 grows replay and schedule exploration on top).
 *
 * The interception handler's `isSatisfiedBy` returns TRUE FOR EVERY TRANSITION. That is the
 * whole trick: because `handle()` is awaited inside `AgentLoop.run`, a handler that matches
 * everything sees — and could order — every state change in the system. Phase 1 only
 * observes and returns the transition unchanged.
 *
 * It also stamps an observation seq on framework loop events. Those are published directly
 * by mozaik's EventPublisherLoopVisitor and never pass through our outbox, so this is the
 * only place they get a monotonic order. We record what we observed, and say so.
 */
export class Recorder {
	private readonly entries: TapeEntry[] = []
	private readonly loopAlias = new LoopAlias()
	private obs = 0

	constructor(
		private readonly deps: { readonly clock: Clock; readonly identity: IdentityBook },
	) {}

	interception(): InterceptionHandler {
		return {
			isSatisfiedBy: () => true,
			handle: async (transition: ExecutableTransition) => {
				this.entries.push({
					kind: "transition",
					obs: ++this.obs,
					tSim: this.deps.clock.nowMs(),
					nextStateId: transition.nextStateId,
					digest: digestOf(transition),
				})
				return transition
			},
		}
	}

	observe(event: SemanticEvent): void {
		const payload = event.payload as { seq?: number; loopId?: string } | undefined
		this.entries.push({
			kind: "event",
			obs: ++this.obs,
			tSim: this.deps.clock.nowMs(),
			type: event.type,
			producer: this.deps.identity.nameOf(event.producerId),
			seq: typeof payload?.seq === "number" ? payload.seq : null,
			// Aliased, never raw: AgentLoop.create mints a crypto.randomUUID() per loop, so a
			// raw loopId would make the tape differ on every run. See loop-alias.ts.
			loopId: typeof payload?.loopId === "string" ? this.loopAlias.aliasFor(payload.loopId) : null,
		})
	}

	tape(): readonly TapeEntry[] {
		return this.entries
	}

	toJsonl(): string {
		return this.entries.map((e) => JSON.stringify(e)).join("\n")
	}
}

/**
 * A stable, bounded description of a transition. Never `JSON.stringify` the whole thing:
 * `inferenceInput.context` holds the entire conversation, so a naive digest would grow
 * quadratically over a run.
 */
function digestOf(transition: ExecutableTransition): string {
	const input = transition.input as Record<string, unknown> | undefined
	if (transition.nextStateId === "function_call") {
		const call = input?.call as { name?: string; callId?: string } | undefined
		return `call:${call?.name ?? "?"}#${call?.callId ?? "?"}`
	}
	if (transition.nextStateId === "model_message") {
		const answer = input?.answer as { content?: { text?: string } } | undefined
		return `answer:${(answer?.content?.text ?? "").slice(0, 40)}`
	}
	if (transition.nextStateId === "message_received") {
		const content = input?.content
		return `msg:${String(content ?? "").slice(0, 40)}`
	}
	const model = input?.model
	return `model:${String(model ?? "?")}`
}
