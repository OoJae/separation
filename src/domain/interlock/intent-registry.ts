import type { PendingClearance } from "../airspace/encounter"

/**
 * Intents that have been ANNOUNCED but not yet committed.
 *
 * This is the thing `intent.forming` announces, made concrete. A controller writes here from
 * inside `propose_clearance`; the interlock desk reads here when a `commit_clearance` arrives
 * carrying only a clearanceId — which is all a model has to go on, since it proposed by id.
 *
 * It is deliberately NOT part of the world. A planner reading a world snapshot cannot see it
 * (observations.ts omits commanded state on purpose). Only the airlock and the proposer can.
 */
export class IntentRegistry {
	private readonly intents = new Map<string, PendingClearance>()

	announce(clearance: PendingClearance): void {
		this.intents.set(clearance.id, clearance)
	}

	resolve(clearanceId: string): PendingClearance | undefined {
		return this.intents.get(clearanceId)
	}

	withdraw(clearanceId: string): void {
		this.intents.delete(clearanceId)
	}

	size(): number {
		return this.intents.size
	}
}
