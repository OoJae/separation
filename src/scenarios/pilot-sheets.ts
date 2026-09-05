import type { PilotSheet } from "../domain/disclosure/pilot-sheet"

const KG = 1_000_000 // milligrams per kilogram

/**
 * The sector's private information.
 *
 * Eight aircraft reconcile. Two do not — and neither of those two is lying in the sense of a model
 * deciding to deceive. One carries a fuel figure that does not match its observed burn (INJECTED,
 * so the discrepancy has a known answer and the detection is measurable); the other carries a
 * genuine, honest, entirely private constraint that changes what the right clearance is.
 *
 * A controller can read none of this from the world. `world.snapshot` deliberately omits commanded
 * state, and nothing here appears in a `FeasibleSet`. The only route to it is `query_pilot`, which
 * parks the controller for the length of a pilot's turn — so asking costs window.
 */
export const PILOT_SHEETS: readonly PilotSheet[] = [
	{
		callsign: "AAL221",
		reportedFuelMg: 4_200 * KG,
		constraint: null,
		refuses: [{ refuseDescentAtOrBelowFt: 3_000, reason: "terrain in the arrival sector below 3000" }],
	},
	{
		callsign: "SWA455",
		reportedFuelMg: 3_800 * KG,
		constraint: null,
		refuses: [{ refuseTurnOfAtLeastDeg: 45, reason: "passengers still seated after turbulence" }],
	},
	{
		/**
		 * THE DECISIVE ONE. A deteriorating passenger — honest, and invisible from the ground.
		 * The geometrically safest option for AAL77 is a wide vector; the right one is the
		 * shortest path. No solver reaches that, because the fact is not in the solver's input.
		 */
		callsign: "AAL77",
		reportedFuelMg: 5_100 * KG,
		constraint: {
			kind: "medical",
			detail: "a passenger is deteriorating; we need the shortest track to the runway",
			wantsShortestPath: true,
		},
		refuses: [{ refuseTurnOfAtLeastDeg: 25, reason: "medical on board, minimise track miles" }],
	},
	{
		/**
		 * THE UNRECONCILABLE ONE. Reports 2100 kg. Its observed burn integral says otherwise.
		 * Injected deliberately so the ledger's finding is measurable against ground truth, and
		 * reported as `cause: "unexplained"` — a gauge fault, a leak and a shaded figure are
		 * indistinguishable from outside, and we do not pretend otherwise.
		 */
		callsign: "UAL231",
		reportedFuelMg: 2_100 * KG,
		constraint: {
			kind: "fuel",
			detail: "we are comfortable on fuel but would prefer no extended vectoring",
			wantsShortestPath: true,
		},
		refuses: [],
	},
	{ callsign: "DAL512", reportedFuelMg: 6_400 * KG, constraint: null, refuses: [] },
	{ callsign: "JBU88", reportedFuelMg: 3_300 * KG, constraint: null, refuses: [] },
	{ callsign: "ASA612", reportedFuelMg: 4_900 * KG, constraint: null, refuses: [] },
	{
		callsign: "SKW4410",
		reportedFuelMg: 1_900 * KG,
		constraint: { kind: "crew-duty", detail: "we are close to a duty limit", wantsShortestPath: false },
		refuses: [],
	},
	{ callsign: "FDX1266", reportedFuelMg: 8_800 * KG, constraint: null, refuses: [] },
	{ callsign: "NKS201", reportedFuelMg: 2_700 * KG, constraint: null, refuses: [] },
]

/** GROUND TRUTH for the injected discrepancy — the test's known answer, never given to a pilot. */
export const UAL231_TRUE_FUEL_MG = 1_450 * KG
export const UNRECONCILABLE_CALLSIGN = "UAL231"
export const MEDICAL_CALLSIGN = "AAL77"

export function sheetFor(callsign: string): PilotSheet | undefined {
	return PILOT_SHEETS.find((s) => s.callsign === callsign)
}
