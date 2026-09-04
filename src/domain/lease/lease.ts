import { keyString, type LeaseKey } from "./lease-key"

export type LeaseHolder =
	| { readonly kind: "controller"; readonly controller: string; readonly clearanceId: string }
	| { readonly kind: "reflex"; readonly reflex: string; readonly raId: string; readonly sense: "climb" | "descend" }

export type Lease = {
	/** `L<n>:<keyString>` — a counter, never a uuid, so tapes are reproducible. */
	readonly leaseId: string
	readonly key: LeaseKey
	readonly holder: LeaseHolder
	/** Fences stale writers. PER KEY, never the VersionedCell token — see lease-registry.ts. */
	readonly generation: number
	readonly grantedAtMs: number
	readonly expiresAtMs: number | null
}

/** Half-open [grantedAt, expiresAt): a lease is dead exactly AT its expiry, not after it. */
export function isLive(lease: Lease, atMs: number): boolean {
	if (atMs < lease.grantedAtMs) return false
	return lease.expiresAtMs === null || atMs < lease.expiresAtMs
}

export function describeLease(lease: Lease): string {
	return `${lease.leaseId}(gen ${lease.generation}) on ${keyString(lease.key)}`
}

export const MIN_LEASE_MS = 2_000
export const MAX_LEASE_MS = 20_000

/**
 * Clamp a requested duration. The lower clamp is not cosmetic: without it a lease whose deadline
 * has already passed would be granted with `expiresAtMs <= grantedAtMs` — born dead, and holding
 * the key against everyone else while it did so.
 */
export function clampDurationMs(requestedMs: number, deadlineMs: number | null, nowMs: number): number {
	let duration = Math.min(Math.max(requestedMs, MIN_LEASE_MS), MAX_LEASE_MS)
	if (deadlineMs !== null) duration = Math.min(duration, deadlineMs - nowMs)
	return Math.max(duration, MIN_LEASE_MS)
}
