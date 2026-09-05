import type { Callsign } from "../domain/airspace/aircraft-state"

/**
 * The pilot vocabulary.
 *
 * Moved here from the pilot participant so that a PUBLISHER other than the pilot can name these
 * without importing a participant. That was not a stylistic problem: `clearance.issued` had a
 * listener and no publisher precisely because the only module that could name it was the module
 * that listens for it. The interlock desk is the natural publisher, and now it can say so.
 */
export const PilotEvent = {
	QUERY: "controller.query",
	REPLY: "pilot.reply",
	UNABLE: "pilot.unable",
	CLEARANCE_ISSUED: "clearance.issued",
} as const

export type PilotEventType = (typeof PilotEvent)[keyof typeof PilotEvent]

export type QueryPayload = {
	readonly queryId: string
	readonly toCallsign: Callsign
	readonly fromController: string
	readonly question: string
}

export type ReplyPayload = {
	readonly queryId: string
	readonly callsign: Callsign
	readonly toController: string
	readonly text: string
	/** Structured claims the DisclosureLedger can actually test. Prose alone is not evidence. */
	readonly claims: readonly { readonly field: "fuelMg"; readonly value: number }[]
}

export type UnablePayload = {
	readonly callsign: Callsign
	readonly clearanceId: string
	readonly reason: string
	readonly counterProposal: string | null
}
