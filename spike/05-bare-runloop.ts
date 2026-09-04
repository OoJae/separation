/**
 * SPIKE 05 — can a non-Agent Participant take a turn?
 *
 * Phase 2 needs no synthesized turns (every participant is loop-less), but Phase 6 RETRACE
 * may want a reflex seizure to travel the same transition stream as a controller's commit.
 * This de-risks that now, cheaply.
 *
 * The hazard: `EventPublisherLoopVisitor.publish` reaches Agent-only accessors
 * (`getDeveloperMessage`, `getMemory`) on the participant — but ONLY under
 * `if (this.cloud.enabled)`. With MOZAIK_API_KEY unset the branch is dead, so a bare
 * Participant survives. With it set, the same call would explode.
 */
import {
	ModelContext, ModelMessageItem, Participant, RuntimeState, SituationSpecification,
	defineRuntime,
	type InferenceOutput, type InferenceRunner, type SemanticEvent,
	type SituationContext, type SituationHandler,
} from "@mozaik-ai/core"

class SpikeState extends RuntimeState {}

class ReflexParticipant extends Participant {
	readonly answers: string[] = []
	private constructor(handlers: SituationHandler[]) {
		super({ id: "reflex:AAL221", name: "reflex:AAL221", role: "agent", capabilities: ["tcas"] }, handlers)
	}
	static init(): ReflexParticipant {
		const self = new ReflexParticipant([])
		self.setHandlers([{
			specification: new (class extends SituationSpecification {
				isSatisfiedBy({ event }: SituationContext) { return event.type === "model.answer" }
			})(),
			processor: {
				apply({ event }) {
					const { answer } = event.payload as { answer: { content: { text: string } } }
					self.answers.push(answer.content.text)
				},
			},
		}])
		return self
	}
}

const runner: InferenceRunner = {
	async run(): Promise<InferenceOutput> {
		return { items: [ModelMessageItem.rehydrate({ text: "seized" })], tokenUsage: undefined, rowResponse: {} }
	},
	async *stream(): AsyncGenerator<SemanticEvent> {},
}

console.log("SPIKE 05 — runLoop on a bare (non-Agent) Participant")
console.log(`  MOZAIK_API_KEY is ${process.env.MOZAIK_API_KEY ? "SET" : "unset"}\n`)

let crash: unknown = null
process.on("unhandledRejection", (e) => { crash = e })

const { initializeRuntime, join, runLoop } = defineRuntime<SpikeState>()
const reflex = ReflexParticipant.init()
initializeRuntime({ state: new SpikeState(), inferenceRunnerConfig: { runner } })
join(reflex)

runLoop(reflex.getId(), "closure 0.4nm", { model: "spike/synthetic", context: ModelContext.create(), tools: [] })
await new Promise((r) => setTimeout(r, 200))

const cloudEnabled = Boolean(process.env.MOZAIK_API_KEY)
const completed = reflex.answers.length === 1 && crash === null
const crashedAsPredicted =
	crash instanceof Error && crash.message.includes("getDeveloperMessage is not a function")

console.log(`   answers: ${JSON.stringify(reflex.answers)}`)
console.log(`   crash:   ${crash === null ? "none" : (crash as Error).message}`)

if (process.env.SPIKE_CHILD === "1") {
	// Child run, invoked by the parent below with MOZAIK_API_KEY set.
	console.log(`   ${crashedAsPredicted ? "PASS" : "FAIL"}  with the cloud enabled, the turn crashes as predicted`)
	process.exit(crashedAsPredicted ? 0 : 1)
}

console.log(`   ${completed ? "PASS" : "FAIL"}  with the cloud disabled, a non-Agent Participant completes a full turn`)

// Now prove the hazard is real rather than theoretical: same code, cloud enabled.
const { execFileSync } = await import("node:child_process")
let childOk = false
let childOut = ""
try {
	childOut = execFileSync("npx", ["tsx", "spike/05-bare-runloop.ts"], {
		encoding: "utf8",
		env: { ...process.env, MOZAIK_API_KEY: "dummy-key-never-sent", SPIKE_CHILD: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	})
	childOk = childOut.includes("PASS")
} catch (error: any) {
	childOut = String(error.stdout ?? "") + String(error.stderr ?? "")
}
console.log(`   ${childOk ? "PASS" : "FAIL"}  with the cloud ENABLED, the same turn dies: "agent.getDeveloperMessage is not a function"`)

console.log(`\n   FINDING (API-NOTES #18): EventPublisherLoopVisitor casts the looping participant`)
console.log(`   to Agent and guards it with \`if (agent)\` — a truthiness check that can never be`)
console.log(`   false — so any non-Agent Participant running a loop crashes the moment telemetry`)
console.log(`   is switched on. The failure is invisible until someone sets an API key.`)
console.log(`\n   => Phase 2 needs none of this (all participants are loop-less).`)
console.log(`   => Guard: assert MOZAIK_API_KEY is unset before constructing the runtime.`)
process.exit(completed && childOk ? 0 : 1)
