/**
 * SEPARATION's event vocabulary — deliberately disjoint from mozaik's built-ins
 * (`participant.*`, `message.sent`, `message_received.*`, `inference.*`,
 * `function_call.*`, `model.answer`, `interception.*`), so a reader can tell at a
 * glance which events are ours and which are the framework's.
 */
export const EventType = {
	// substrate
	CAS_REJECTED: "cas.rejected",
	PARTICIPANT_HALTED: "participant.halted",
	TURN_STARTED: "turn.started",
	TURN_ENDED: "turn.ended",

	// preemption — three distinct mechanisms, never conflated (see README)
	TRANSITION_REWRITTEN: "transition.rewritten",
	TRANSITION_SUBSTITUTED: "transition.substituted",
	RUNNER_ABORT: "runner.abort",
	PREMISE_INVALIDATED: "premise.invalidated",
} as const

export type EventTypeValue = (typeof EventType)[keyof typeof EventType]

export type CasRejectedPayload = {
	path: string
	expected: number
	actual: number
	byWhom: string
	turnId: string | null
}

export type ParticipantHaltedPayload = {
	agentName: string
	cause: string
	lastTurnId: string | null
}

export type TurnLifecyclePayload = {
	turnId: string
	agentName: string
	reason?: string
}

export type QuiescedPayload = {
	tSim: number
	inflight: number
	pending: number
}
