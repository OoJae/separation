/** Phase 2's world vocabulary. Disjoint from mozaik's built-ins, so ours are identifiable. */
export const WorldEvent = {
	SNAPSHOT: "world.snapshot",
	PAIR_CLOSURE: "pair.closure",
	SEPARATION_LOST: "separation.lost",
	COMMAND_REJECTED: "world.command.rejected",
	COMMAND_ACCEPTED: "world.command.accepted",
	LEASE_GRANTED: "lease.granted",
	LEASE_DENIED: "lease.denied",
	DISCLOSURE_CONTRADICTED: "disclosure.contradicted",
	FEASIBILITY_PROBED: "feasibility.probed",
} as const

export type WorldEventType = (typeof WorldEvent)[keyof typeof WorldEvent]
