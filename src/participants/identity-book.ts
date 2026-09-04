import type { Participant } from "@mozaik-ai/core"

/**
 * IdentityBook — domain name <-> runtime id.
 *
 * WHY THIS EXISTS: `Agent.create` mints `crypto.randomUUID()` internally, so participant
 * ids differ on every run. Any log, tape, assertion or ablation keyed on id is
 * unreproducible by construction. Everything user-visible keys on NAME; ids stay an
 * internal detail of the runtime.
 */
export class IdentityBook {
	private readonly byName = new Map<string, Participant>()
	private readonly nameById = new Map<string, string>()

	register(participant: Participant): void {
		const name = participant.getManifest().name
		if (this.byName.has(name)) {
			throw new Error(`Duplicate participant name "${name}" — names are the stable key.`)
		}
		this.byName.set(name, participant)
		this.nameById.set(participant.getId(), name)
	}

	/** Falls back to the raw id so an unregistered producer is visible, never silently dropped. */
	nameOf(id: string): string {
		return this.nameById.get(id) ?? `<unregistered:${id.slice(0, 8)}>`
	}

	idOf(name: string): string {
		const participant = this.byName.get(name)
		if (!participant) throw new Error(`No participant named "${name}"`)
		return participant.getId()
	}

	get(name: string): Participant | undefined {
		return this.byName.get(name)
	}

	names(): string[] {
		return [...this.byName.keys()]
	}
}
