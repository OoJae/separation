import { describe, expect, it } from "@rstest/core"
import { clampDurationMs, isLive, MIN_LEASE_MS, type LeaseHolder } from "../../src/domain/lease/lease"
import { actuatorKey, keyString, standingKey } from "../../src/domain/lease/lease-key"
import {
	authorize, emptyRegistry, holdersOf, withExpired, withGrant, withRelease,
	type RegistryState,
} from "../../src/domain/lease/lease-registry"

const approach: LeaseHolder = { kind: "controller", controller: "APPROACH", clearanceId: "c1" }
const flow: LeaseHolder = { kind: "controller", controller: "FLOW", clearanceId: "c2" }
const reflex: LeaseHolder = { kind: "reflex", reflex: "reflex:AAL221", raId: "ra1", sense: "climb" }

const grant = (state: RegistryState, key: Parameters<typeof withGrant>[1]["key"], holder: LeaseHolder, nowMs = 0, expiresAtMs: number | null = 10_000) =>
	withGrant(state, { key, holder, nowMs, expiresAtMs })

describe("lease registry", () => {
	describe("one mechanism, two key scopes", () => {
		/**
		 * The whole point. Two controllers legally hold standing over the SAME aircraft at the
		 * same time, because their objectives are different keys. That overlap is the mechanism
		 * that puts two language models on one callsign simultaneously — it is not a bug.
		 */
		it("lets two controllers hold standing over one aircraft simultaneously", () => {
			let state = emptyRegistry("AAL221")
			const first = grant(state, standingKey("AAL221", "runway-sequence"), approach)
			expect(first.ok).toBe(true)
			if (!first.ok) return
			state = first.next

			const second = grant(state, standingKey("AAL221", "metered-interval"), flow)
			expect(second.ok).toBe(true)
			if (!second.ok) return
			state = second.next

			expect(holdersOf(state, 0)).toEqual([
				"standing:AAL221:metered-interval",
				"standing:AAL221:runway-sequence",
			])
		})

		it("but refuses a second holder on the SAME key", () => {
			let state = emptyRegistry("AAL221")
			const first = grant(state, standingKey("AAL221", "runway-sequence"), approach)
			if (!first.ok) throw new Error("setup")
			state = first.next

			const clash = grant(state, standingKey("AAL221", "runway-sequence"), flow)
			expect(clash.ok).toBe(false)
			if (clash.ok) return
			if (clash.reason !== "already-held") throw new Error("expected already-held")
			expect(clash.holder).toEqual(approach)   // announced, not silent
		})

		it("keeps actuator axes independent of each other", () => {
			let state = emptyRegistry("AAL221")
			const vertical = grant(state, actuatorKey("AAL221", "vertical"), reflex)
			if (!vertical.ok) throw new Error("setup")
			state = vertical.next
			const lateral = grant(state, actuatorKey("AAL221", "lateral"), approach)
			expect(lateral.ok).toBe(true)
		})
	})

	describe("generations fence per key, never globally", () => {
		/**
		 * If fencing used the VersionedCell token, every write to this callsign's registry would
		 * invalidate every live lease on it. A grant on an unrelated key must not fence anyone.
		 */
		it("a grant on an unrelated key does NOT fence a live lease", () => {
			let state = emptyRegistry("AAL221")
			const held = grant(state, actuatorKey("AAL221", "vertical"), reflex)
			if (!held.ok) throw new Error("setup")
			state = held.next

			const elsewhere = grant(state, standingKey("AAL221", "metering"), flow)
			if (!elsewhere.ok) throw new Error("setup")
			state = elsewhere.next

			const check = authorize(state, { leaseId: held.lease.leaseId, generation: held.lease.generation, atMs: 100 })
			expect(check.ok).toBe(true)
		})

		it("a re-grant on the SAME key fences the previous generation", () => {
			let state = emptyRegistry("AAL221")
			const first = grant(state, actuatorKey("AAL221", "vertical"), approach, 0, 1_000)
			if (!first.ok) throw new Error("setup")
			state = first.next

			// First lease expires, reflex seizes the same axis.
			const seized = grant(state, actuatorKey("AAL221", "vertical"), reflex, 2_000, 12_000)
			if (!seized.ok) throw new Error("setup")
			state = seized.next

			const stale = authorize(state, { leaseId: first.lease.leaseId, generation: first.lease.generation, atMs: 3_000 })
			expect(stale.ok).toBe(false)
			if (stale.ok) return
			expect(stale.reason).toBe("fenced")
			expect(stale.currentGeneration).toBe(2)
		})

		it("release bumps again, so a pre-seizure clearance stays DEAD", () => {
			let state = emptyRegistry("AAL221")
			const clearance = grant(state, actuatorKey("AAL221", "vertical"), approach)
			if (!clearance.ok) throw new Error("setup")
			state = clearance.next

			state = withRelease(state, clearance.lease.leaseId)

			// The reflex let go — but the controller's old lease must not spring back to life.
			const revived = authorize(state, {
				leaseId: clearance.lease.leaseId, generation: clearance.lease.generation, atMs: 500,
			})
			expect(revived.ok).toBe(false)
			if (revived.ok) return
			// "fenced", not "no-such-lease": the release bumped the generation, so the old holder
			// is told precisely why it may no longer act, and by which generation.
			expect(revived.reason).toBe("fenced")
			expect(revived.currentGeneration).toBe(2)
			expect(state.generations[keyString(actuatorKey("AAL221", "vertical"))]).toBe(2)
		})
	})

	describe("expiry is a half-open interval", () => {
		it("is dead exactly AT expiresAtMs, not after it", () => {
			const state = emptyRegistry("AAL221")
			const g = grant(state, standingKey("AAL221", "seq"), approach, 0, 5_000)
			if (!g.ok) throw new Error("setup")
			expect(isLive(g.lease, 4_999)).toBe(true)
			expect(isLive(g.lease, 5_000)).toBe(false)   // half-open
			expect(isLive(g.lease, 5_001)).toBe(false)
		})

		it("reports expired rather than fenced when the generation is current", () => {
			const state = emptyRegistry("AAL221")
			const g = grant(state, standingKey("AAL221", "seq"), approach, 0, 1_000)
			if (!g.ok) throw new Error("setup")
			const check = authorize(g.next, { leaseId: g.lease.leaseId, generation: g.lease.generation, atMs: 2_000 })
			expect(check.ok).toBe(false)
			if (check.ok) return
			expect(check.reason).toBe("expired")
		})

		it("frees the key once the incumbent expires", () => {
			let state = emptyRegistry("AAL221")
			const first = grant(state, standingKey("AAL221", "seq"), approach, 0, 1_000)
			if (!first.ok) throw new Error("setup")
			state = first.next
			const later = grant(state, standingKey("AAL221", "seq"), flow, 2_000, 12_000)
			expect(later.ok).toBe(true)
		})

		it("drops expired leases without bumping generations — time already fenced them", () => {
			let state = emptyRegistry("AAL221")
			const g = grant(state, standingKey("AAL221", "seq"), approach, 0, 1_000)
			if (!g.ok) throw new Error("setup")
			state = g.next
			const before = state.generations[keyString(standingKey("AAL221", "seq"))]
			state = withExpired(state, 5_000)
			expect(state.leases).toHaveLength(0)
			expect(state.generations[keyString(standingKey("AAL221", "seq"))]).toBe(before)
		})
	})

	describe("a lease is never born dead", () => {
		it("refuses a grant whose expiry has already passed", () => {
			const state = emptyRegistry("AAL221")
			const g = withGrant(state, {
				key: standingKey("AAL221", "seq"), holder: approach, nowMs: 5_000, expiresAtMs: 4_000,
			})
			expect(g.ok).toBe(false)
			if (g.ok) return
			expect(g.reason).toBe("expires-before-it-starts")
		})

		it("clamps a duration up to the floor rather than producing a zero-length lease", () => {
			expect(clampDurationMs(50, null, 0)).toBe(MIN_LEASE_MS)
			expect(clampDurationMs(999_999, null, 0)).toBe(20_000)
			// deadline already inside the floor -> still at least MIN_LEASE_MS, never negative
			expect(clampDurationMs(10_000, 500, 0)).toBe(MIN_LEASE_MS)
		})
	})

	describe("reproducibility", () => {
		it("answers no-such-lease for an id that never existed", () => {
			const state = emptyRegistry("AAL221")
			const check = authorize(state, { leaseId: "L9:standing:AAL221:ghost", generation: 1, atMs: 0 })
			expect(check.ok).toBe(false)
			if (check.ok) return
			expect(check.reason).toBe("no-such-lease")
		})

		it("mints counter-based ids, never uuids", () => {
			let state = emptyRegistry("AAL221")
			const a = grant(state, standingKey("AAL221", "one"), approach)
			if (!a.ok) throw new Error("setup")
			state = a.next
			const b = grant(state, standingKey("AAL221", "two"), flow)
			if (!b.ok) throw new Error("setup")
			expect(a.lease.leaseId).toBe("L1:standing:AAL221:one")
			expect(b.lease.leaseId).toBe("L2:standing:AAL221:two")
		})

		it("two identical sequences produce identical registries", () => {
			const run = () => {
				let s = emptyRegistry("AAL221")
				for (const objective of ["a", "b", "c"]) {
					const g = grant(s, standingKey("AAL221", objective), approach)
					if (g.ok) s = g.next
				}
				return s
			}
			expect(run()).toEqual(run())
		})
	})
})
