import { describe, expect, it } from "@rstest/core"
import { refusalFor, type PilotSheet } from "../../src/domain/disclosure/pilot-sheet"
import { BurnIntegral } from "../../src/domain/disclosure/burn-model"
import { ClaimLedger } from "../../src/domain/disclosure/claim-ledger"
import { testAnchored } from "../../src/domain/disclosure/contradiction"
import { probe } from "../../src/domain/feasibility/prober"
import {
	MEDICAL_CALLSIGN, PILOT_SHEETS, UAL231_TRUE_FUEL_MG, UNRECONCILABLE_CALLSIGN, sheetFor,
} from "../../src/scenarios/pilot-sheets"
import { AAL221, HORIZON_S, INITIAL, SWA455 } from "../../src/scenarios/braid-2"
import { QueryDesk } from "../../src/participants/controller/query-desk"
import { OutboxDispatcher } from "../../src/support/outbox"
import { VirtualClock } from "../../src/support/ports"

const KG = 1_000_000

describe("private information", () => {
	describe("the sheet is unreachable from geometry", () => {
		/**
		 * The thin-agency answer, as a fact about the code. If the prober could see any of this,
		 * a solver could take the argmax and the models would be decorative.
		 */
		/**
		 * Precisely: no SHEET VALUE leaks. The set legitimately carries `fuelBurnMg` — the fuel a
		 * manoeuvre would COST, which is public geometry. What must never appear is fuel ON BOARD,
		 * or any private constraint. Conflating the two would be the easy mistake, and asserting
		 * "the word fuel never appears" would fail for the wrong reason.
		 */
		it("no FeasibleSet leaks a sheet value — not fuel on board, not a constraint, not a refusal", () => {
			const set = probe({
				subject: "AAL221", world: [...INITIAL], forGeneration: 1, horizonSec: HORIZON_S, nowSec: 0,
			})
			const serialized = JSON.stringify(set)

			for (const sheet of PILOT_SHEETS) {
				expect(serialized).not.toContain(String(sheet.reportedFuelMg))
				if (sheet.constraint) expect(serialized).not.toContain(sheet.constraint.detail)
				for (const rule of sheet.refuses) expect(serialized).not.toContain(rule.reason)
			}
			expect(serialized).not.toContain("medical")
			expect(serialized).not.toContain("duty limit")

			// ...but the public cost axis IS there, because a manoeuvre's fuel cost is geometry.
			expect(set.options.length).toBeGreaterThan(0)
			expect(set.options[0]!.cost.fuelBurnMg).not.toBe(0) // signed: a descent saves, a turn costs
		})

		it("every sheet holds something the world cannot show", () => {
			for (const sheet of PILOT_SHEETS) {
				expect(sheet.reportedFuelMg).toBeGreaterThan(0)
			}
			expect(PILOT_SHEETS.filter((s) => s.constraint !== null).length).toBeGreaterThanOrEqual(3)
		})
	})

	describe("the decisive constraint", () => {
		it("AAL77 carries a medical the ground cannot observe", () => {
			const sheet = sheetFor(MEDICAL_CALLSIGN)!
			expect(sheet.constraint).not.toBeNull()
			expect(sheet.constraint!.kind).toBe("medical")
			expect(sheet.constraint!.wantsShortestPath).toBe(true)
		})

		/**
		 * The beat this phase exists for. The geometrically safest option is a wide vector; the
		 * RIGHT one is the shortest track. Geometry defines the region and cannot choose inside it.
		 */
		it("its constraint inverts what the widest-margin option would be", () => {
			const sheet = sheetFor(MEDICAL_CALLSIGN)!
			const wideVector = refusalFor(sheet, { turnMagnitudeDeg: 30 })
			const shallowTurn = refusalFor(sheet, { turnMagnitudeDeg: 10 })
			expect(wideVector).not.toBeNull()          // the wide, safe-looking vector is refused
			expect(wideVector!.reason).toContain("medical")
			expect(shallowTurn).toBeNull()             // the tighter track is accepted
		})
	})

	describe("the unreconcilable fuel claim", () => {
		/**
		 * Injected, not modelled as deception. Pilot and controller are the same weights here, so
		 * a "model caught a lying model" result would be self-play. What IS claimed is that the
		 * arithmetic detects a story that does not reconcile — measurable, because we know the
		 * ground truth we injected.
		 */
		it("UAL231's reported fuel does not reconcile with its observed burn", () => {
			const sheet = sheetFor(UNRECONCILABLE_CALLSIGN)!
			const burn = new BurnIntegral()
			for (let i = 0; i < 20_000; i++) burn.accumulate("cruise", 20) // 400 s of cruise

			const verdict = testAnchored({
				filedFuelMg: UAL231_TRUE_FUEL_MG + burn.totalMilligrams(),
				burnSinceFiledMg: burn.totalMilligrams(),
				claimedNowMg: sheet.reportedFuelMg,
			})
			expect(verdict.contradicted).toBe(true)
			expect(verdict.marginMg).toBeGreaterThan(0)
		})

		it("reports the cause as unexplained — a leak and a lie look identical from outside", () => {
			const ledger = new ClaimLedger()
			ledger.record({ callsign: "UAL231", claimedMg: 2_100 * KG, atSimSec: 0, burnIntegralMg: 0 })
			const verdict = ledger.record({
				callsign: "UAL231", claimedMg: 2_100 * KG, atSimSec: 400, burnIntegralMg: 500 * KG,
			})!
			expect(verdict.contradicted).toBe(true)
			expect(verdict.cause).toBe("unexplained")
			expect(Object.keys(verdict)).not.toContain("probability")
		})

		it("leaves the eight honest sheets alone", () => {
			const honest = PILOT_SHEETS.filter(
				(s) => s.callsign !== UNRECONCILABLE_CALLSIGN && s.callsign !== MEDICAL_CALLSIGN,
			)
			expect(honest).toHaveLength(8)
			for (const sheet of honest) expect(sheet.reportedFuelMg).toBeGreaterThan(1_000 * KG)
		})
	})

	describe("pilot.unable", () => {
		it("refuses a descent below the terrain floor, with a reason", () => {
			const refusal = refusalFor(sheetFor("AAL221")!, { targetAltFt: 2_500 })
			expect(refusal).not.toBeNull()
			expect(refusal!.reason).toContain("terrain")
		})

		it("accepts a descent above it", () => {
			expect(refusalFor(sheetFor("AAL221")!, { targetAltFt: 4_000 })).toBeNull()
		})

		it("refuses a hard turn when passengers are unseated", () => {
			expect(refusalFor(sheetFor("SWA455")!, { turnMagnitudeDeg: 50 })).not.toBeNull()
			expect(refusalFor(sheetFor("SWA455")!, { turnMagnitudeDeg: 20 })).toBeNull()
		})
	})

	describe("asking costs window", () => {
		function desk(timeoutMs = 20_000) {
			const clock = new VirtualClock(0)
			const published: { type: string; payload: unknown }[] = []
			const outbox = new OutboxDispatcher((e) => published.push({ type: e.type, payload: e.payload }), clock)
			return { clock, published, desk: new QueryDesk({ outbox, clock, timeoutMs }) }
		}

		it("publishes the query and parks until the reply arrives", async () => {
			const h = desk()
			const pending = h.desk.ask({
				askerId: "APPROACH", fromController: "APPROACH", toCallsign: "AAL77",
				question: "say fuel and any constraints",
			})
			expect(h.published[0]!.type).toBe("controller.query")
			expect(h.desk.pendingQueries()).toBe(1)

			const queryId = (h.published[0]!.payload as { queryId: string }).queryId
			h.clock.advance(13_000) // a pilot turn
			h.desk.receive({
				queryId, callsign: "AAL77", toController: "APPROACH",
				text: "we have a medical on board, request shortest track",
				claims: [{ field: "fuelMg", value: 5_100 * KG }],
			}, 13_000, 0)

			const outcome = await pending
			expect(outcome.ok).toBe(true)
			if (!outcome.ok) return
			expect(outcome.text).toContain("medical")
			expect(outcome.waitedMs).toBe(13_000)   // the window this cost
			expect(h.desk.pendingQueries()).toBe(0)
		})

		/**
		 * ~13 s of pilot latency against a ~44 s manoeuvre window. Asking is affordable but not
		 * free, and a controller has to judge whether it can spend it — on information whose value
		 * it cannot know until it has it.
		 */
		it("costs a real fraction of the manoeuvre window", async () => {
			const WINDOW_MS = 44_360
			const PILOT_TURN_MS = 13_000
			expect(PILOT_TURN_MS / WINDOW_MS).toBeGreaterThan(0.25)
			expect(PILOT_TURN_MS).toBeLessThan(WINDOW_MS)
		})

		it("reports a timeout as an outcome rather than throwing", async () => {
			const h = desk(5_000)
			const pending = h.desk.ask({
				askerId: "APPROACH", fromController: "APPROACH", toCallsign: "NKS201", question: "say fuel",
			})
			h.clock.advance(5_001)
			const outcome = await pending
			expect(outcome.ok).toBe(false)
			if (outcome.ok) return
			expect(outcome.reason).toBe("timeout")
			expect(h.desk.timeoutsSeen()).toBe(1)
		})

		it("ignores a reply for an unknown query rather than failing", () => {
			const h = desk()
			expect(() => h.desk.receive({
				queryId: "ghost", callsign: "X", toController: "Y", text: "hi", claims: [],
			}, 0)).not.toThrow()
		})
	})
})
