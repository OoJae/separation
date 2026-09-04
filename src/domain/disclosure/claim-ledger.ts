import type { Callsign } from "../airspace/aircraft-state"
import { testDifferential, type ContradictionVerdict } from "./contradiction"

export type FuelClaim = {
	readonly callsign: Callsign
	readonly claimedMg: number
	readonly atSimSec: number
	/** The burn integral reading when the claim was made — observable, unlike the fuel itself. */
	readonly burnIntegralMg: number
}

/**
 * Append-only ledger of what pilots have SAID, checked against what the world OBSERVED.
 *
 * Deliberately deterministic and non-LLM. If a model decided whether a pilot was lying, the whole
 * result would be one model's opinion of another model's output — the contradiction has to be
 * arithmetic for the finding to mean anything.
 */
export class ClaimLedger {
	private readonly claims: FuelClaim[] = []

	record(claim: FuelClaim): ContradictionVerdict | null {
		const previous = this.lastFor(claim.callsign)
		this.claims.push(claim)
		if (previous === undefined) return null

		return testDifferential({
			firstClaimMg: previous.claimedMg,
			secondClaimMg: claim.claimedMg,
			burnBetweenMg: claim.burnIntegralMg - previous.burnIntegralMg,
		})
	}

	lastFor(callsign: Callsign): FuelClaim | undefined {
		for (let i = this.claims.length - 1; i >= 0; i--) {
			if (this.claims[i]!.callsign === callsign) return this.claims[i]
		}
		return undefined
	}

	claimsFor(callsign: Callsign): readonly FuelClaim[] {
		return this.claims.filter((c) => c.callsign === callsign)
	}

	size(): number {
		return this.claims.length
	}
}
