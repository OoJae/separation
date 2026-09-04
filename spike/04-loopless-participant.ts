/**
 * SPIKE 04 — the Phase 2 participant pattern.
 *
 * Phase 2 is zero-token STRUCTURALLY, not by discipline: every participant is a plain
 * `Participant` subclass with situation handlers and NO AgentLoop. Nothing can call a model
 * because nothing ever enters the loop. This spike proves that pattern is real before a
 * single domain file is written.
 *
 * Also pins three API facts the whole phase depends on.
 */
import {
	Participant, RuntimeState, SemanticEvent, SituationSpecification, createHuman, defineRuntime,
	FunctionCallOutputItem,
	type SituationContext, type SituationHandler,
} from "@mozaik-ai/core"

class SpikeState extends RuntimeState {}

const results: string[] = []
const check = (label: string, ok: boolean, detail = "") =>
	results.push(`   ${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`)

// ── 1. A loop-less participant with a bare manifest literal ──────────────────────────
// `ParticipantManifest` and `ParticipantRole` are NOT exported (verified: index.d.ts:628),
// so the manifest must be an object literal. `role` accepts only "agent" | "human".
class WorldParticipant extends Participant {
	readonly seen: string[] = []

	private constructor(handlers: SituationHandler[]) {
		super({ id: "world", name: "world", role: "agent", capabilities: ["airspace.truth"] }, handlers)
	}

	static init(): WorldParticipant {
		const self = new WorldParticipant([])
		self.setHandlers([
			{
				specification: new (class extends SituationSpecification {
					isSatisfiedBy({ event }: SituationContext) { return event.type === "actuator.command.issued" }
				})(),
				processor: { apply({ event }) { self.seen.push(event.type) } },
			},
		])
		return self
	}
}

console.log("SPIKE 04 — loop-less participant pattern\n")

{
	const { initializeRuntime, join, sendEvent } = defineRuntime<SpikeState>()
	const world = WorldParticipant.init()
	const driver = createHuman({ name: "driver", capabilities: [], handlers: [] })

	initializeRuntime({ state: new SpikeState() })
	join(world)
	join(driver)
	sendEvent(new SemanticEvent("actuator.command.issued", driver.getId(), new Date(0), { callsign: "AAL221" }), driver.getId())

	check("a bare Participant subclass joins and its handler fires with NO AgentLoop", world.seen.length === 1)
	check("manifest object literal is accepted without ParticipantManifest", world.getManifest().name === "world")
	check("capabilities survive on the manifest", world.getManifest().capabilities?.[0] === "airspace.truth")
}

// ── 2. event.type is a live field; only the PAYLOAD loses its prototype ──────────────
{
	const { initializeRuntime, join, sendEvent } = defineRuntime<SpikeState>()
	let typeSeen: unknown = null
	let payloadHadPrototype: boolean | null = null

	const observer = createHuman({
		name: "observer", capabilities: [],
		handlers: [{
			specification: new (class extends SituationSpecification {
				isSatisfiedBy({ event }: SituationContext) { return event.type === "probe" }
			})(),
			processor: {
				apply({ event }) {
					typeSeen = event.type
					payloadHadPrototype = typeof (event.payload as { getType?: unknown }).getType === "function"
				},
			},
		}],
	})

	initializeRuntime({ state: new SpikeState() })
	join(observer)
	// Publish a class instance AS the payload — the shape that loses its prototype in the loop.
	const item = FunctionCallOutputItem.create("c1", "done")
	sendEvent(new SemanticEvent("probe", observer.getId(), new Date(0), item), observer.getId())

	check("event.type is a live field (the event instance is passed by reference)", typeSeen === "probe")
	check("a payload passed directly KEEPS its prototype via sendEvent", payloadHadPrototype === true,
		"prototype loss (#12) comes from the loop visitor's {...payload} spread, not from sendEvent")
}

// ── 3. A synchronous throw in apply propagates OUT of publish ────────────────────────
// EventProcessor.process has no try/catch and no await (index.mjs:511-522). So a throwing
// processor escapes into whoever called sendEvent. Phase 2 forbids throwing processors.
{
	const { initializeRuntime, join, sendEvent } = defineRuntime<SpikeState>()
	const thrower = createHuman({
		name: "thrower", capabilities: [],
		handlers: [{
			specification: new (class extends SituationSpecification {
				isSatisfiedBy({ event }: SituationContext) { return event.type === "boom" }
			})(),
			processor: { apply() { throw new Error("processor exploded") } },
		}],
	})
	const after: string[] = []
	const downstream = createHuman({
		name: "downstream", capabilities: [],
		handlers: [{
			specification: new (class extends SituationSpecification {
				isSatisfiedBy({ event }: SituationContext) { return event.type === "boom" }
			})(),
			processor: { apply({ event }) { after.push(event.type) } },
		}],
	})

	initializeRuntime({ state: new SpikeState() })
	join(thrower)
	join(downstream)

	let escaped: unknown = null
	try {
		sendEvent(new SemanticEvent("boom", thrower.getId(), new Date(0), {}), thrower.getId())
	} catch (error) { escaped = error }

	check("a sync throw in apply ESCAPES publish into the caller", escaped instanceof Error,
		escaped instanceof Error ? escaped.message : String(escaped))
	check("and it starves every participant after the thrower", after.length === 0,
		"=> Phase 2 machine-checks that no processor throws and none is async")
}

console.log(results.join("\n"))
const failed = results.filter((r) => r.includes("FAIL")).length
console.log(`\n  ${results.length - failed}/${results.length} assertions passed`)
process.exit(failed ? 1 : 0)
