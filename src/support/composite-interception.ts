import type { ExecutableTransition, InterceptionHandler } from "@mozaik-ai/core"

/**
 * `runLoop` accepts exactly ONE InterceptionHandler, but three of our subsystems need that
 * seat simultaneously: the Recorder (observe every transition), the PremiseSentinel
 * (invalidate a dead premise) and the InterlockDesk (hold a commit in the airlock).
 *
 * So we fold them into one, in an explicit and documented priority order:
 *
 *   Recorder -> PremiseSentinel -> InterlockDesk
 *
 * Recorder first so it sees the transition as the model produced it. InterlockDesk last so
 * it holds whatever survived invalidation — there is no point queueing a commit whose
 * premise is already dead.
 *
 * Each handler transforms in turn, and every handler is re-tested against the CURRENT
 * transition, so a handler that only matches `function_call` still fires when an earlier
 * handler rewrote the transition into one.
 */
export function composeInterception(...handlers: readonly InterceptionHandler[]): InterceptionHandler {
	return {
		isSatisfiedBy(transition: ExecutableTransition): boolean {
			return handlers.some((h) => h.isSatisfiedBy(transition))
		},
		async handle(transition: ExecutableTransition): Promise<ExecutableTransition> {
			let current = transition
			for (const handler of handlers) {
				if (handler.isSatisfiedBy(current)) current = await handler.handle(current)
			}
			return current
		},
	}
}
