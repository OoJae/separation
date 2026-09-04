import type { Callsign } from "../airspace/aircraft-state"
import { isLive, type Lease, type LeaseHolder } from "./lease"
import { keyString, type LeaseKey } from "./lease-key"

/**
 * One registry per callsign, held in a VersionedCell and mutated only through `casWrite`
 * (src/state/cas-write.ts). No new write path, no SWAP exemption.
 *
 * GENERATION IS PER KEY, not the cell's token. That distinction is load-bearing: the token bumps
 * on every write to the callsign's registry, so fencing on it would mean a grant on
 * `standing:AAL221:metering` invalidates a live `actuator:AAL221:vertical` lease that has nothing
 * to do with it. Per-key generations fence exactly the writers they should.
 */
export type RegistryState = {
	readonly callsign: Callsign
	readonly leases: readonly Lease[]
	/** keyString -> highest generation ever granted on that key. Monotonic, never reused. */
	readonly generations: Readonly<Record<string, number>>
	readonly counter: number
}

export type GrantRequest = {
	readonly key: LeaseKey
	readonly holder: LeaseHolder
	readonly nowMs: number
	readonly expiresAtMs: number | null
}

export type GrantResult =
	| { readonly ok: true; readonly next: RegistryState; readonly lease: Lease }
	| { readonly ok: false; readonly reason: "already-held"; readonly holder: LeaseHolder; readonly leaseId: string }
	| { readonly ok: false; readonly reason: "expires-before-it-starts" }

export type AuthorizeResult =
	| { readonly ok: true; readonly lease: Lease }
	| {
			readonly ok: false
			readonly reason: "no-such-lease" | "fenced" | "expired"
			readonly currentGeneration: number
	  }

export function emptyRegistry(callsign: Callsign): RegistryState {
	return { callsign, leases: [], generations: {}, counter: 0 }
}

function liveOn(state: RegistryState, key: LeaseKey, atMs: number): Lease | undefined {
	const target = keyString(key)
	return state.leases.find((l) => keyString(l.key) === target && isLive(l, atMs))
}

/**
 * Total and refusing — this is where the exclusion invariant is actually enforced, rather than
 * being a comment. A denial is a VALUE, so the caller can announce it; nothing here throws.
 */
export function withGrant(state: RegistryState, request: GrantRequest): GrantResult {
	const { key, holder, nowMs, expiresAtMs } = request

	if (expiresAtMs !== null && expiresAtMs <= nowMs) {
		return { ok: false, reason: "expires-before-it-starts" }
	}

	const incumbent = liveOn(state, key, nowMs)
	if (incumbent !== undefined) {
		return { ok: false, reason: "already-held", holder: incumbent.holder, leaseId: incumbent.leaseId }
	}

	const ks = keyString(key)
	const generation = (state.generations[ks] ?? 0) + 1
	const counter = state.counter + 1
	const lease: Lease = {
		leaseId: `L${counter}:${ks}`,
		key,
		holder,
		generation,
		grantedAtMs: nowMs,
		expiresAtMs,
	}

	return {
		ok: true,
		lease,
		next: {
			callsign: state.callsign,
			// Drop anything already dead on this key; keep every other key untouched.
			leases: [...state.leases.filter((l) => keyString(l.key) !== ks || isLive(l, nowMs)), lease],
			generations: { ...state.generations, [ks]: generation },
			counter,
		},
	}
}

/**
 * Release bumps the generation again. Without that bump, a clearance issued BEFORE a reflex
 * seizure would authorize again the moment the reflex let go — the seizure would suppress it
 * rather than kill it. Bumping on release makes a pre-seizure clearance stay dead.
 */
export function withRelease(state: RegistryState, leaseId: string): RegistryState {
	const lease = state.leases.find((l) => l.leaseId === leaseId)
	if (lease === undefined) return state
	const ks = keyString(lease.key)
	return {
		callsign: state.callsign,
		leases: state.leases.filter((l) => l.leaseId !== leaseId),
		generations: { ...state.generations, [ks]: (state.generations[ks] ?? 0) + 1 },
		counter: state.counter,
	}
}

/** May this holder still act? Fencing is by generation, expiry by the half-open interval. */
export function authorize(
	state: RegistryState,
	request: { readonly leaseId: string; readonly generation: number; readonly atMs: number },
): AuthorizeResult {
	const lease = state.leases.find((l) => l.leaseId === request.leaseId)
	if (lease === undefined) {
		// The lease is gone — expired and swept, or released. We can still answer PRECISELY,
		// because a leaseId is self-describing by construction (`L<n>:<keyString>`), so the key
		// survives the lease. A stale holder learns it was fenced and by which generation,
		// instead of the uninformative "never heard of it".
		const ks = request.leaseId.slice(request.leaseId.indexOf(":") + 1)
		const current = state.generations[ks] ?? 0
		if (current > request.generation) return { ok: false, reason: "fenced", currentGeneration: current }
		return { ok: false, reason: "no-such-lease", currentGeneration: current }
	}
	const current = state.generations[keyString(lease.key)] ?? 0
	if (request.generation < current) {
		return { ok: false, reason: "fenced", currentGeneration: current }
	}
	if (!isLive(lease, request.atMs)) {
		return { ok: false, reason: "expired", currentGeneration: current }
	}
	return { ok: true, lease }
}

/** Live holders, sorted, so any log or tape built from this is order-stable. */
export function holdersOf(state: RegistryState, atMs: number): readonly string[] {
	return state.leases
		.filter((l) => isLive(l, atMs))
		.map((l) => keyString(l.key))
		.sort()
}

/** Drop expired leases. Generations are NOT bumped — expiry already fences by time. */
export function withExpired(state: RegistryState, atMs: number): RegistryState {
	const live = state.leases.filter((l) => isLive(l, atMs))
	if (live.length === state.leases.length) return state
	return { ...state, leases: live }
}
