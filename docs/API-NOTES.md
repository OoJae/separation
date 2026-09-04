# API notes — `@mozaik-ai/core@4.0.5`

Fourteen findings from building SEPARATION, verified against the **shipped package** (`dist/index.js` and
its sourcemap), not the documentation. Each one is reproducible via `npm run spike`, which needs
no network and no API key.

Offered in the spirit of a precise bug report. Where we worked around something, the workaround
is named so you can see exactly what a consumer has to build.

---

## 1. An `InterceptionHandler` cannot halt a turn, and attempting it kills the process

**Severity: high.** `AgentLoop.run`:

```ts
while (transition.nextStateId !== "idle") {
    const isInterceptionSatisfied = this.interceptionHandler?.isSatisfiedBy(transition)
    if (isInterceptionSatisfied && this.interceptionHandler) {
        transition = await this.interceptionHandler.handle(transition)   // may return idle
    }
    const execution = await this.stateExecutor.execute(transition, loopVisitor)  // not re-checked
    transition = this.transitionResolver.resolve(execution)
}
```

The loop condition is evaluated at the top, but the transition returned by `handle()` is **never
re-tested against it**. `LoopStateExecutor.execute` is an exhaustive `switch` over
`ExecutableLoopStateId` with no `idle` case and no `default`, so it falls through and returns
`undefined`; `TransitionResolver.resolve` then dereferences `execution.stateId`:

```
TypeError: Cannot read properties of undefined (reading 'stateId')
```

Because `createRunLoop` invokes `agentLoop.run(...)` with **no `await` and no `.catch()`** (see #5),
this surfaces as an unhandled rejection and terminates the process.

The types already say halting is not allowed — `ExecutableLoopStateId = Exclude<LoopStateId,"idle">`
— so this is only reachable through a cast. But the failure mode for anyone who tries is a hard
crash rather than a type error or a thrown, catchable exception.

**Suggested fix:** re-check the loop condition after the interception block (`if
(transition.nextStateId === "idle") break`), or have `execute` throw a named error on a
non-executable state.

**Our workaround:** we never halt. We **substitute** — rewriting the pending transition to
`model_message` so the action is suppressed and the turn ends cleanly. Shipped as
`transition.substituted`. Verified in `spike/02-cancellation.ts`.

---

## 2. Ending a stream without an `inference.output` throws — the abort path is a landmine

**Severity: high.** `InferenceStreamingState.run`:

```ts
for await (const event of this.inferenceRunner.stream(input)) {
    if (event.type === "inference.output") output = event.payload as InferenceOutput
}
if (!output) throw new Error("Inference output not found")
```

Any custom `InferenceRunner` that stops early — a cancellation, a provider refusal, an empty
content block — ends its generator without emitting `inference.output` and throws. Combined with
#5, that is a process kill rather than a failed turn.

**Our workaround:** the abort path **always** yields a synthesized `inference.output` carrying a
`ModelMessageItem` before returning, which routes through `InferenceToModelMessageRule` →
`model_message` → `idle`. Because mozaik's `for await` consumes *our* generator, we control
termination, so preemption mid-generation is clean. Verified in `spike/03-abort.ts`.

---

## 3. Rewriting a pending `function_call` works, and the agent reasons about it — this is excellent

**Not a bug — the best thing in the API.** `FunctionCallToInferenceRule` appends
`execution.input.call`, i.e. the **post-interception** call:

```ts
previousRequest.context.addContextItems([execution.input.call, execution.output.item])
```

So an `InterceptionHandler` may replace a pending call's arguments via
`FunctionCallItem.rehydrate({callId, name, args})`, the **rewritten** call is what executes, and the
rewritten call lands in the agent's own context — meaning the agent's next inference sees that it
was narrowed and can reason about it, instead of silently failing.

This is the mechanism SEPARATION is built on: a peer's objection arriving as narrowed arguments
*inside a turn that is still open*. Verified end to end in `spike/01-rewrite-readback.ts`.

**One consequence worth documenting:** the model's *original* arguments are never appended, so an
agent cannot compare what it asked for against what it got. If you want that diff, you must inject
it yourself.

---

## 4. `ModelContext.addContextItems` mutates in place and returns `this`

**Severity: high for concurrent use.**

```ts
addContextItems(contextItems) { this.items.push(...contextItems); return this }
```

`MessageReceivedState` also mutates the caller's context (`input.input.context.addContextItems([...])`).
The `return this` reads like a persistent/immutable builder, so `const next = ctx.addContextItems(x)`
silently aliases.

Two concurrent `runLoop`s on one agent that share `agent.getMemory().getContext()` therefore
interleave a `function_call` with a foreign `function_call_output` and hard-400 both Anthropic and
OpenAI. Since `runLoop` is explicitly fire-and-forget and concurrency is the framework's headline,
this is easy to hit.

**Our workaround:** a `TurnScheduler` owns a per-agent context ledger and builds a fresh
`new ModelContext(id, items)` for every turn. The public constructor makes this possible.

---

## 5. `runLoop` swallows all failures — a dead agent is indistinguishable from a silent one

**Severity: high.** `createRunLoop` ends with:

```ts
agentLoop.run({ content: message, input: inferenceInput }, loopVisitor)
```

No `await`, no `.catch()`, and `runLoop` returns `void`. Every error above — plus provider 400s and
`No transition rule found after "inference"` on a truncated or refused response — becomes an
unhandled rejection. On Node 26 that is fatal by default.

In a system where participants infer consent from silence, an agent that dies publishing nothing is
read by its peers as agreement.

**Suggested fix:** attach a `.catch()` that publishes a failure event (an `agent.failed` /
`participant.halted` semantic event would fit the existing vocabulary).

**Our workaround:** a supervising driver with a global `unhandledRejection` handler, per-provider
retry/backoff, and an explicit `participant.halted` event.

---

## 6. `publish` is synchronous, re-entrant, and uncaught — participants observe different orders

```ts
publish(event) { for (const p of this.state.getParticipants()) this.processor.process(event, p) }
process(event, consumer) { for (const h of consumer.getHandlers()) if (satisfied) h.processor.apply(...) }
```

There is no queue and no `try/catch`. If a situation processor calls `sendEvent`, `publish` re-enters
depth-first, so participant A can observe event 2 before event 1 while participant B observes the
reverse. A throwing processor propagates into whoever called `sendEvent` — often an unrelated
participant.

The docs' guarantee that "a slow listener never blocks producers" holds only for `async` processors,
whose returned promise is discarded (and whose rejections are therefore unhandled — see #5).

**Our workaround:** an `OutboxDispatcher` that defers dispatch and stamps a monotonic `seq`, giving
every participant one identical order. That order is also what makes deterministic replay possible.

---

## 7. `Memory` is not exported

`Memory` is declared in `index.d.ts` but absent from the export list, so it cannot be constructed
directly, and `Memory`'s context has no setter. Combined with #4, injecting a synthesized
`FunctionCallOutputItem` — which is exactly what orphan repair and "you were overruled" feedback
require — is only possible by owning the context outside the agent.

---

## 8. `maxOutputTokens` is honored by exactly one provider

`request.max_tokens = inferenceInput.maxOutputTokens` appears **once** in the entire bundle, in
`AnthropicMessagesMapper.toRequest`. The OpenAI Responses, OpenAI Chat Completions and Gemini
mappers never read the field.

A consumer setting `maxOutputTokens` for cost control gets it silently ignored on three of four
providers — which matters when the participant count is high.

---

## 9. `SemanticEvent.create` stamps wall-clock time

```ts
static create(type, producerId, payload) { const occurredAt = new Date(); ... }
```

Any system wanting deterministic replay must avoid the static factory and use the public
constructor with an injected clock. Worth a line in the docs, since `create` is what every example
uses.

---

## 10. `reasoningEffort` vocabularies are not uniform, and the docs don't say so

From the shipped `supportedModels`:

| model | supported efforts |
|---|---|
| `gpt-5.4` / `gpt-5.5` | `xhigh, high, medium, low, none` |
| `claude-haiku-4-5` | `high, medium, low, none` |
| `claude-sonnet-4-6` | `max, high, medium, low` |
| `claude-opus-4-8` | `max, xhigh, high, medium, low` |
| `gemini-3.5-flash` | `high, medium, low, minimal, none` |

`none` is unavailable on Sonnet/Opus, `max` is unavailable on Haiku and OpenAI, and `minimal` is
Gemini-only. Any hardcoded effort ladder breaks when a participant is moved between models, so
effort must be read off `ModelSpecification.supportedReasoningEfforts` at call time.

---

## 11. Documentation drift: `context_update` vs `message_received`

`/docs/semantic-events` and `/docs/interception` describe the first loop state as `context_update`
(and events `context_update.started` / `.completed`). The shipped `LoopStateId` and the runtime both
use `message_received`. The compiled code is authoritative.

---

## 12. Event payloads lose their prototype in transit

**Severity: medium.** `EventPublisherLoopVisitor.publish` builds every loop event as:

```ts
const event = new SemanticEvent(type, this.agentId, new Date(), { ...payload, loopId: this.loopId })
```

Spreading a class instance copies its own enumerable properties but drops the prototype. For
`function_call.completed`, whose payload *is* a `FunctionCallOutputItem`, the subscriber receives a
plain object:

```
original getType(): "function_call_output" | instanceof: true
spread   getType(): undefined              | instanceof: false
spread keys: type, callId, output, loopId
```

So a situation handler that does `payload instanceof FunctionCallOutputItem` or `payload.getType()`
— the natural thing, given those are the domain types the docs teach — silently fails.

**Suggested fix:** carry the payload under a key (`{ item: payload, loopId }`) instead of spreading
it, or document that payloads are structural rather than nominal.

**Our workaround:** we never use `instanceof` on an event payload and read fields structurally.
Machine-checked by `tests/substrate/invariants.test.ts`.

---

## 13. An unknown tool name leaks the in-flight set

**Severity: medium.** `FunctionCallState.run` publishes `function_call.started`, then:

```ts
let tool = inferenceInput.tools?.find((tool) => tool.name === call.name)
if (!tool) {
    return { stateId: this.id, input, output: { item: FunctionCallOutputItem.create(call.callId, `Error: unknown tool "${call.name}"`) } }
}
const item = await this.functionCallRunner.run(call, tool)
loopVisitor.visitFunctionCallCompleted(item)
```

The early return skips `visitFunctionCallCompleted`, so `function_call.started` fires with **no
matching `function_call.completed`**. The loop itself recovers fine — the error output goes back to
the model — but any observer tracking outstanding work by pairing those two events leaks one entry
per unknown tool, permanently.

That matters for the pattern the `baro` post describes: proving quiescence via an empty in-flight
set. A hallucinated tool name — routine LLM behaviour — makes such a system believe work is
outstanding forever.

**Suggested fix:** publish `function_call.completed` on the unknown-tool path too; it already has an
output item to publish.

**Our workaround:** in-flight is keyed on **turn lifecycle** (`TurnScheduler`), never on
`function_call.*` pairing.

---

## 14. Telemetry ships agent memory off-box, and constructs a client per turn

`EventPublisherLoopVisitor` calls `createCloudClient()` in its constructor — once per `runLoop`, not
once per process — and when `MOZAIK_API_KEY` is set it sends, on **every event**:

```ts
agent: { manifest, developerMessage, tools, memory: agent.getMemory().getContext().getItems() }
```

That is the agent's entire conversation, on every event, for every turn. Worth making explicit in the
docs: it is a privacy consideration for anyone whose contexts contain user data, a bandwidth
consideration at high event rates, and a determinism consideration for anyone recording runs.

---

## 15. `EventProcessor.process` neither awaits nor catches

```ts
process(event, consumer) {
    for (const handler of consumer.getHandlers()) {
        if (handler.specification.isSatisfiedBy({ event, participant: consumer })) {
            handler.processor.apply({ event, participant: consumer })
        }
    }
}
```

Two consequences, both verified in `spike/04-loopless-participant.ts`:

**A throwing processor escapes into the publisher.** `RuntimeService.publish` has no `try/catch`
either, so an exception in one participant's processor propagates out of whoever called `sendEvent`
— usually an unrelated participant that merely announced something.

**And it starves every participant after it.** Fan-out is a `for` loop, so the throw abandons the
iteration. Participants later in `getParticipants()` never see the event at all. In a system where
silence is read as consent, one bad handler silently disenfranchises everyone downstream of it.

`SituationProcessor.apply` is typed `void | Promise<void>`, but the returned promise is discarded, so
an `async` processor's rejection is unhandled (see #5) and its ordering is unspecified.

**Our workaround:** two machine-checked invariants — no `SituationProcessor.apply` may be `async`,
and none may contain a `throw`. A rejected command **publishes** `world.command.rejected` instead.

---

## 16. `ParticipantManifest` and `ParticipantRole` are not exported, and the role vocabulary is closed

`Participant` is exported; its manifest type is not (`index.d.ts:628`). A subclass must therefore
write a bare object literal, which is fine but undiscoverable.

More substantively, `ParticipantRole = "agent" | "human"`. There is no role for a participant that is
neither — a clock, a physics integrator, a deterministic prober, a market. The framework's own
blackboard thesis (HEARSAY-II) is precisely about *heterogeneous* experts sharing one board, and
several of ours are not inferential at all. They currently declare `role: "agent"` and lie.

**Suggested fix:** a third role (`"machine"` / `"process"`), or documenting that `role` is advisory.

---

## 17. Prototype loss is narrower than it looks — it is the loop visitor, not the bus

Refining #12. `sendEvent` passes the `SemanticEvent` **instance** through by reference, and a payload
handed to `new SemanticEvent(...)` keeps its prototype. Verified: a `FunctionCallOutputItem`
published directly still answers `getType()` on the far side.

The loss is introduced solely by `EventPublisherLoopVisitor.publish`, which spreads
(`{...payload, loopId}`). So **framework loop events have structural payloads; your own events do
not have to.** Worth documenting, because the natural inference from #12 — "never trust a payload" —
is stricter than reality and would push consumers into unnecessary defensive code.

---

## 18. A non-Agent `Participant` may take a turn, until telemetry is switched on

`runLoop(agentId, ...)` accepts any joined participant id. With `MOZAIK_API_KEY` unset a plain
`Participant` completes a full turn — verified in `spike/05-bare-runloop.ts`.

Switch telemetry on and the same code dies:

```
agent.getDeveloperMessage is not a function
```

because `EventPublisherLoopVisitor.publish` does:

```ts
const participant = this.runtime.getParticipant(this.agentId)
const agent = participant as Agent
if (agent) { /* getDeveloperMessage(), getTools(), getMemory() */ }
```

The cast is unchecked and `if (agent)` is a truthiness test that can never be false for a joined
participant — so the guard reads like a type check but is not one.

The failure mode is the bad kind: invisible in development, triggered by an environment variable, and
surfacing as an unhandled rejection (#5) rather than a clear error.

**Suggested fix:** `if (participant instanceof Agent)`.

**Our workaround:** every Phase 2 participant is loop-less, and the runtime asserts `MOZAIK_API_KEY`
is unset before construction.
