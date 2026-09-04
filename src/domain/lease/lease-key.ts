import type { Callsign } from "../airspace/aircraft-state"

/**
 * ONE lease mechanism, two key scopes.
 *
 * The reflex layer wants an EXCLUSIVE per-(callsign, axis) actuator lease. The authority market
 * wants a per-(callsign, objective) standing lease that several controllers may hold at once.
 * Those are not two mechanisms — they are one, with two key spaces. Simultaneous holdability is
 * a property of the KEY, never of the lease: two controllers over one aircraft is two keys, and
 * "at most one live lease per key" holds in both worlds.
 */
export type LeaseScope = "standing" | "actuator"

/** The axes a clearance can command, and therefore the axes a reflex can seize. */
export type ManeuverAxis = "vertical" | "lateral" | "speed"

export type LeaseKey = {
	readonly scope: LeaseScope
	readonly callsign: Callsign
	/** An objectiveId for "standing"; a ManeuverAxis for "actuator". */
	readonly discriminator: string
}

export function standingKey(callsign: Callsign, objectiveId: string): LeaseKey {
	return { scope: "standing", callsign, discriminator: objectiveId }
}

export function actuatorKey(callsign: Callsign, axis: ManeuverAxis): LeaseKey {
	return { scope: "actuator", callsign, discriminator: axis }
}

export function keyString(key: LeaseKey): string {
	return `${key.scope}:${key.callsign}:${key.discriminator}`
}
