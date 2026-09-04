# Phase 0 — spike results

Regenerate with `npm run spike`. Every assertion below runs with **no network and no API key**.

Package under test: `@mozaik-ai/core@4.0.5`  ·  Node `v26.0.0`

## `00-imports.ts` — PASS

_Export surface + model registry of @mozaik-ai/core@4.0.5_

```
exports present: 26 / 27
MISSING: Memory
supportedModels count: 12

providers: openai, anthropic, google, deepseek

All model specs:
  openai     gpt-5.4                    efforts=[xhigh|high|medium|low|none] stream=true maxOut=128000 fn=true struct=true
  openai     gpt-5.4-mini               efforts=[xhigh|high|medium|low|none] stream=true maxOut=128000 fn=true struct=true
  openai     gpt-5.4-nano               efforts=[xhigh|high|medium|low|none] stream=true maxOut=128000 fn=true struct=true
  openai     gpt-5.5                    efforts=[xhigh|high|medium|low|none] stream=true maxOut=128000 fn=true struct=true
  anthropic  claude-haiku-4-5           efforts=[high|medium|low|none] stream=true maxOut=64000 fn=true struct=true
  anthropic  claude-sonnet-4-6          efforts=[max|high|medium|low] stream=true maxOut=64000 fn=true struct=true
  anthropic  claude-opus-4-7            efforts=[max|xhigh|high|medium|low] stream=true maxOut=32000 fn=true struct=true
  anthropic  claude-opus-4-8            efforts=[max|xhigh|high|medium|low] stream=true maxOut=32000 fn=true struct=true
  google     gemini-3.5-flash           efforts=[high|medium|low|minimal|none] stream=true maxOut=64000 fn=true struct=true
  google     gemini-3.1-pro-preview     efforts=[high|medium|low|minimal|none] stream=true maxOut=64000 fn=true struct=true
  deepseek   deepseek-v4-flash          efforts=[max|high|medium|low|none] stream=true maxOut=384000 fn=true struct=false
  deepseek   deepseek-v4-pro            efforts=[max|high|medium|low|none] stream=true maxOut=384000 fn=true struct=false
```

## `01-rewrite-readback.ts` — PASS

_UNKNOWN (a)+(b): custom runner multiplex, and a peer's objection landing as rewritten function_call args inside a still-open turn_

```
SPIKE 01 — interception rewrite read-back

  [interception] FLOW objects — narrowing args
      from: {"callsign":"UAL231","maneuver":"DESCEND 6000"}
      to:   {"callsign":"UAL231","maneuver":"DESCEND 6000, TURN 20L"}

  context at 2nd inference:
      message(developer) You sequence arrivals.
      message(user) UAL231 needs descent.
      function_call args={"callsign":"UAL231","maneuver":"DESCEND 6000, TURN 20L"}
      function_call_output {"ok":true,"committed":"DESCEND 6000, TURN 20L"}

  RESULTS
   (a) custom runner synthesized inference for a fake model id : PASS
   (b1) the REWRITTEN args are what actually executed          : PASS  ({"callsign":"UAL231","maneuver":"DESCEND 6000, TURN 20L"})
   (b2) the REWRITTEN call is in the agent's own context       : PASS
   (b3) the ORIGINAL args are structurally absent              : PASS (as predicted)
```

## `02-cancellation.ts` — PASS

_Can an InterceptionHandler halt a turn? (corrected finding + the honest alternative)_

```
SPIKE 02 — halting a turn from an InterceptionHandler

EXPERIMENT A — handle() returns {nextStateId:'idle'}
   dangerTool ran   : 0 times (action WAS suppressed)
   but the loop     : CRASHED — Cannot read properties of undefined (reading 'stateId')
   → verdict        : CONFIRMED BUG — halting is unreachable; uncaught, this kills the process
   → one-line fix   : re-check the loop condition after the interception block

EXPERIMENT B — substituting function_call -> model_message
   inferences=1  dangerTool ran=0  crash=none
   → action suppressed AND the turn ended cleanly : PASS
   → this is the mechanism SEPARATION ships as `transition.substituted`
```

## `03-abort.ts` — PASS

_UNKNOWN (c): aborting a streaming turn mid-generation without killing the process_

```
SPIKE 03 — aborting a streaming turn mid-generation

EXPERIMENT A — abort WITHOUT yielding inference.output (the trap)
      [runner] abort observed at token 6 — closing stream
   naive abort
      crash: Inference output not found
      → TRAP CONFIRMED — this would kill the process

EXPERIMENT B — abort AND yield a synthesized inference.output (the fix)
      [runner] abort observed at token 6 — closing stream
   guarded abort
      crash: none
      answers seen: ["[preempted: premise invalidated]"]
      → PASS — turn terminated cleanly, mid-generation, no crash

EXPERIMENT C — orphan repair
      every function_call has a matching output : PASS
      (this is also what makes 'being overruled' reasoning material)
```

## `04-loopless-participant.ts` — PASS

_PHASE 2 GATE: a plain Participant subclass with handlers and no AgentLoop — the pattern that makes zero-token structural rather than disciplinary_

```
SPIKE 04 — loop-less participant pattern

   PASS  a bare Participant subclass joins and its handler fires with NO AgentLoop
   PASS  manifest object literal is accepted without ParticipantManifest
   PASS  capabilities survive on the manifest
   PASS  event.type is a live field (the event instance is passed by reference)
   PASS  a payload passed directly KEEPS its prototype via sendEvent  — prototype loss (#12) comes from the loop visitor's {...payload} spread, not from sendEvent
   PASS  a sync throw in apply ESCAPES publish into the caller  — processor exploded
   PASS  and it starves every participant after the thrower  — => Phase 2 machine-checks that no processor throws and none is async

  7/7 assertions passed
```

## `05-bare-runloop.ts` — PASS

_PHASE 2 GATE: whether a non-Agent Participant may take a turn, and the telemetry-enabled crash that says it may not_

```
SPIKE 05 — runLoop on a bare (non-Agent) Participant
  MOZAIK_API_KEY is unset

   answers: ["seized"]
   crash:   none
   PASS  with the cloud disabled, a non-Agent Participant completes a full turn
   PASS  with the cloud ENABLED, the same turn dies: "agent.getDeveloperMessage is not a function"

   FINDING (API-NOTES #18): EventPublisherLoopVisitor casts the looping participant
   to Agent and guards it with `if (agent)` — a truthiness check that can never be
   false — so any non-Agent Participant running a loop crashes the moment telemetry
   is switched on. The failure is invisible until someone sets an API key.

   => Phase 2 needs none of this (all participants are loop-less).
   => Guard: assert MOZAIK_API_KEY is unset before constructing the runtime.
```
