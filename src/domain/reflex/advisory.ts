import type { PairClosure } from "../airspace/observations"
import {
	CLEAR_TICKS, CONFIRM_TICKS, SENSE_INDIFFERENCE_FT, sensitivityFor, type SensitivityRow,
} from "./constants"
import { modifiedTauSeconds, verticalTauSeconds } from "./tau"

export type AdvisoryKind = "none" | "traffic" | "resolution"
export type Sense = "climb" | "descend"

export type AdvisoryTest = {
	readonly kind: AdvisoryKind
	readonly level: SensitivityRow["level"]
	readonly tauModS: number
	readonly verticalTauS: number
	readonly rangeTestPassed: boolean
	readonly verticalTestPassed: boolean
}

/**
 * The TCAS advisory test for one pair, as seen by ONE aircraft's reflex.
 *
 * Both a range test AND a vertical test must pass. That conjunction is why BRAID-2's joint hazard
 * is invisible here: at 2.5 NM the range test never comes close to the 0.55 NM DMOD, so the
 * vertical margin never even gets consulted.
 */
export function testAdvisory(closure: PairClosure, ownAltFt: number): AdvisoryTest {
	const row = sensitivityFor(ownAltFt)

	const raTau = modifiedTauSeconds(closure.rangeSqNm2, closure.closureRateNmPerSec, row.raDmodNm)
	const taTau = modifiedTauSeconds(closure.rangeSqNm2, closure.closureRateNmPerSec, row.taDmodNm)
	const vTau = verticalTauSeconds(closure.verticalSeparationFt, closure.verticalRateFtPerSec)

	const raRange = raTau <= row.raTauS
	const raVertical = closure.verticalSeparationFt < row.raZthrFt || vTau <= row.raTauS
	if (raRange && raVertical) {
		return { kind: "resolution", level: row.level, tauModS: raTau, verticalTauS: vTau, rangeTestPassed: true, verticalTestPassed: true }
	}

	const taRange = taTau <= row.taTauS
	const taVertical = closure.verticalSeparationFt < row.taZthrFt || vTau <= row.taTauS
	if (taRange && taVertical) {
		return { kind: "traffic", level: row.level, tauModS: taTau, verticalTauS: vTau, rangeTestPassed: true, verticalTestPassed: true }
	}

	return {
		kind: "none", level: row.level, tauModS: raTau, verticalTauS: vTau,
		rangeTestPassed: raRange, verticalTestPassed: raVertical,
	}
}

/**
 * Pairwise sense selection with NO ARBITER.
 *
 * Each reflex runs this independently and they must reach COMPLEMENTARY answers. Geometry decides
 * it whenever the two are meaningfully apart in altitude — the higher aircraft climbs. Inside a
 * 25 ft indifference band that tie-break is meaningless noise, so both fall back to comparing
 * their Mode S addresses, which is deterministic, symmetric-safe, and total.
 */
export function selectSense(ownAltFt: number, otherAltFt: number, ownAddress: number, otherAddress: number): Sense {
	const gap = ownAltFt - otherAltFt
	if (Math.abs(gap) >= SENSE_INDIFFERENCE_FT) return gap > 0 ? "climb" : "descend"
	return ownAddress > otherAddress ? "climb" : "descend"
}

export function isComplementary(a: Sense, b: Sense): boolean {
	return a !== b
}

/**
 * Hysteresis. Every counter is an INTEGER TICK COUNT, so no floating-point value ever decides
 * whether an advisory exists — only how close the geometry is.
 */
export class AdvisoryTracker {
	private confirming = 0
	private clearing = 0
	private declared: AdvisoryKind = "none"

	observe(kind: AdvisoryKind): AdvisoryKind {
		if (kind === "none") {
			this.confirming = 0
			if (this.declared !== "none") {
				this.clearing += 1
				if (this.clearing >= CLEAR_TICKS) {
					this.declared = "none"
					this.clearing = 0
				}
			}
			return this.declared
		}

		this.clearing = 0
		if (kind === this.declared) return this.declared
		this.confirming += 1
		if (this.confirming >= CONFIRM_TICKS) {
			this.declared = kind
			this.confirming = 0
		}
		return this.declared
	}

	current(): AdvisoryKind {
		return this.declared
	}
}

/** Deterministic stand-in for a 24-bit ICAO address. FNV-1a over the callsign, folded to 24 bits. */
export function modeSAddress(callsign: string): number {
	let hash = 0x811c9dc5
	for (let i = 0; i < callsign.length; i++) hash = Math.imul(hash ^ callsign.charCodeAt(i), 0x01000193)
	return ((hash >>> 8) ^ (hash >>> 24)) & 0xffffff
}
