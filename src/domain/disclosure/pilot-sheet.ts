import type { Callsign } from "../airspace/aircraft-state"

/**
 * A pilot's private constraint sheet — the TYPE only.
 *
 * Values live in the pilot participant's closure and nowhere else. Nothing under
 * `src/domain/feasibility/**` may even name this file; that ban is machine-checked in
 * `tests/substrate/invariants.test.ts`, because "the prober cannot see this" has to be a fact
 * about the code rather than a promise.
 *
 * This is the whole answer to the thin-agency charge. The FeasibleSet gives geometry, and geometry
 * defines the region of safe options. What it never does is CHOOSE inside that region, because the
 * information that decides between them is here — and here is only reachable by asking, in natural
 * language, while the clock runs.
 */
export type PilotSheet = {
	readonly callsign: Callsign

	/**
	 * What the crew's gauges read, in milligrams.
	 *
	 * DELIBERATELY NOT ground truth. For most aircraft this reconciles with the observed burn
	 * integral. For one it does not — injected, so the discrepancy is measurable against a known
	 * answer. We do not model a pilot CHOOSING to under-report: pilot and controller are the same
	 * model here, so a "caught the liar" result would be self-play. What is claimed is narrower
	 * and sound — the ledger detects a story that does not reconcile, and `cause: "unexplained"`
	 * because a leak and a lie look identical from outside the aircraft.
	 */
	readonly reportedFuelMg: number

	/** An operational constraint the ground cannot observe. Decisive when present. */
	readonly constraint: PilotConstraint | null

	/** Manoeuvres this aircraft will refuse, and why. Drives `pilot.unable`. */
	readonly refuses: readonly RefusalRule[]
}

export type PilotConstraint =
	| { readonly kind: "medical"; readonly detail: string; readonly wantsShortestPath: true }
	| { readonly kind: "fuel"; readonly detail: string; readonly wantsShortestPath: true }
	| { readonly kind: "crew-duty"; readonly detail: string; readonly wantsShortestPath: false }

export type RefusalRule = {
	/** Refuse a descent whose target is at or below this. */
	readonly refuseDescentAtOrBelowFt?: number
	/** Refuse a turn of at least this many degrees. */
	readonly refuseTurnOfAtLeastDeg?: number
	/**
	 * Refuse a speed reduction to at or below this.
	 *
	 * Without this an aircraft whose constraint is literally `wantsShortestPath` could refuse a
	 * 30-degree turn costing 3.5 track miles while having to accept a speed reduction costing it
	 * two and a half MINUTES — the rule vocabulary could not express the constraint the sheet
	 * declared.
	 */
	readonly refuseSpeedBelowKt?: number
	readonly reason: string
}

/** Does this sheet refuse the given command? Pure — the pilot agent explains it in prose. */
export function refusalFor(
	sheet: PilotSheet,
	command: {
		readonly targetAltFt?: number
		readonly turnMagnitudeDeg?: number
		readonly targetGroundspeedKt?: number
	},
): RefusalRule | null {
	for (const rule of sheet.refuses) {
		if (rule.refuseDescentAtOrBelowFt !== undefined
			&& command.targetAltFt !== undefined
			&& command.targetAltFt <= rule.refuseDescentAtOrBelowFt) return rule
		if (rule.refuseTurnOfAtLeastDeg !== undefined
			&& command.turnMagnitudeDeg !== undefined
			&& Math.abs(command.turnMagnitudeDeg) >= rule.refuseTurnOfAtLeastDeg) return rule
		if (rule.refuseSpeedBelowKt !== undefined
			&& command.targetGroundspeedKt !== undefined
			&& command.targetGroundspeedKt <= rule.refuseSpeedBelowKt) return rule
	}
	return null
}
