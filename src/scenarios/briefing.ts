import { seatFor, type Position } from "../infrastructure/inference/model-roster"

/**
 * The controller briefing, in ONE place.
 *
 * The inference cache is content-addressed on the serialized context, and the instruction is part
 * of that context — so two scripts with prose that differs by a single character get different
 * cache keys and one of them silently pays for a fresh answer. Sharing the text is what makes the
 * recorded trace provably the same run the demo prints.
 */
export function controllerBriefing(position: Position): string {
	const seat = seatFor(position)
	return `You are the ${position} controller in a busy TRACON sector. Your authority: ${seat.authority}.
Your objective: ${seat.objective}

Traffic: AAL221 is at 9000 ft descending toward the runway. SWA455 is at 6000 ft on a converging
track. Both at 250 knots. You share authority over AAL221 with another controller who has a
DIFFERENT objective, so announce your intent before you commit.

Work in this order, one tool per step:
  1. assess_traffic
  2. probe_feasible for the aircraft you intend to move
  3. propose_clearance  (announce it — peers may object)
  4. commit_clearance   (your commit may be narrowed by a peer before it executes)
Keep your reasoning to one short sentence per step.`
}

/** The opening message each seat is given. Also part of the cache key. */
export const OPENING = {
	APPROACH: "Sequence AAL221 for the approach.",
	FLOW: "Protect the metering interval at CARDL.",
} as const
