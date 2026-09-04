# SEPARATION

**Contested authority over a world that will not wait.**

Three air-traffic controllers hold *overlapping* authority over the same aircraft. Their half-formed
clearances are held together in one airlock, where a hazard that exists **only in the intersection of
two simultaneously-pending decisions** is caught — and a peer's objection lands as **rewritten
function-call arguments inside a turn that is still open**.

Built on [Mozaik](https://github.com/jigjoy-ai/mozaik) (`@mozaik-ai/core@4.0.5`) for the
JigJoy × daily.dev × Hyperskill *Systems of Concurrent Agents* hackathon.

> This is **not** a proposal to run an airspace on language models. The domain was chosen because a
> hard exogenous clock, incommensurable objectives, private information and real-time safety
> envelopes make the failure modes of concurrent agent systems *observable*. The deterministic reflex
> layer exists precisely to demonstrate that language models must be **subordinate** to a safety
> envelope they cannot override. The thesis is subordination, not autonomy.

## The claim

> **Validate-at-commit does not fail because it cannot see. It fails because by the time it has
> committed and looked, the other aircraft's window is shut.**

Two clearances are individually safe and jointly unsafe. The hazard **is** visible to anything
holding both as pending intent — that is exactly what the interlock does, and exactly what
validate-at-commit does not. And the two cannot be serialized: a serialized system cannot reach its
second decision before 12 400 ms (turn + 8.0 s single-channel readback + turn), by which time the
other aircraft's manoeuvre window has closed. **Both orders fail.** If only one did, the hazard
would be serializable and the theorem would be false.

It ships as a **passing test**, not a paragraph: `npm run verify:theorem`, zero tokens, no API key.

### The calibration, stated up front

The two **gate distances** in the scenario are calibrated — they are chosen so both manoeuvre
windows land inside the admissible band. That is a scenario parameter and this is us saying so
before you find it.

What is *not* calibrated is the band itself. It is derived from the controller-latency model
(`src/domain/interlock/decision-latency.ts`) and contains no geometry at all: a window must exceed
8998 ms for the concurrent arm to fit on every latency draw, and fall below 12 400 ms for the
serialized arm to miss on every draw. `tests/theorem/theorem.test.ts` **computes** that band and
asserts the gates lie strictly inside it, so changing the latency model fails the test and tells
you to re-derive the gates rather than letting a stale calibration slide through.

Each window is derived from real manoeuvre physics, not chosen: descending 5000 ft at 2000 fpm
takes 150 s, and turning 20° then establishing 0.60 NM of offset takes 31.93 s.

## Status

| Phase | | |
|---|---|---|
| 0 | The spike — prove the marquee mechanism exists before designing around it | ✅ |
| 1 | Substrate — close the gaps the runtime leaves | ✅ |
| 2 | Deterministic world, zero tokens | ✅ |
| 3 | The interlock — **the theorem as a test** | ✅ |
| 4 | Live controllers, three vendors | ⬜ |

## Reproduce

Everything below runs with **no network and no API key**. That is deliberate: a judge with a laptop
and no credentials must still be able to reproduce the central claims.

```bash
npm install
npm run spike               # regenerates spike/RESULTS.md against the shipped package
npm test                    # 194 tests
npm run verify:theorem      # THE THEOREM
npm run verify:braid-2      # the scenario, measured by the shipped integrator
npm run verify:reflex-silent# proves TCAS never sees the joint hazard
npm run verify:determinism  # same seed twice, byte-identical + state hash
npm run typecheck
```

### Why TCAS does not save you

If the collision-avoidance system resolved this encounter, the joint hazard would be something the
safety net already handles and no architecture above it would matter. It does not: closest approach
is **2.5361 NM against an RA DMOD of 0.55 NM — 4.6× clear**, and no RA or TA fires in any of the
four cases over 380 s. The aircraft do cross co-altitude, so the *vertical* test would pass easily;
an advisory needs both, and the range test never comes close.

Stated rather than hidden: the TA margin is only 1.06×. A TA commands no manoeuvre, so even if
geometry shifted enough to trigger one the encounter would still be unresolved.

## What we had to build, and why

Mozaik is deliberately unopinionated about concurrency control — it ships no locks, no mutex, no
change notification and no turn handle, and `runLoop` is fire-and-forget. Six subsystems follow
directly from that, each traceable to a numbered finding in [`docs/API-NOTES.md`](docs/API-NOTES.md):

| Subsystem | Because |
|---|---|
| `VirtualClock` | `SemanticEvent.create` stamps `new Date()`, so replay needs an injected clock (#9) |
| `OutboxDispatcher` | `publish` is a synchronous re-entrant for-loop, so participants observe **different event orders** (#6) |
| `ContextLedger` | `addContextItems` mutates in place and returns `this`; `Memory` is not exported (#4, #7) |
| `TurnScheduler` | one in-flight loop per agent, fresh context per turn, and the turnId↔loopId binding (#4, #13) |
| `OrphanRepair` | a preempted turn leaves a `function_call` with no output, which every provider rejects (#2) |
| `SupervisingDriver` | `runLoop` has no `.catch()`, so a dead agent is indistinguishable from a silent one (#5) |

### One honest scope note

The outbox totally orders **our** domain events. Framework loop events (`inference.*`,
`function_call.*`, `model.answer`) are published by mozaik's `EventPublisherLoopVisitor` directly and
do **not** route through it; the Recorder stamps those with a separate observation seq. We claim
ordering only for what we actually order.

### Three preemption mechanisms, never conflated

Overclaiming is the fastest way to lose a room of framework authors, so these are logged separately
and never merged in the narration:

- **`transition.rewritten`** — a peer's objection replaced a pending call's arguments via
  `FunctionCallItem.rehydrate`. The rewritten call is what executes *and* what lands in the agent's
  context, so it reasons about having been narrowed. Verified in `spike/01`.
- **`transition.substituted`** — a completed inference whose premise died is replaced with a
  `model_message` before it can become an action. This is the honest form of "stop": an
  `InterceptionHandler` **cannot** halt a turn (#1).
- **`runner.abort`** — our runner closed the provider stream mid-generation. We do **not** claim
  "tokens stop billing": on the aborted path `stream.finalMessage()` is never reached, so
  `tokenUsage` is `undefined` and the claim would be unobservable from inside the process.

## Invariants a reader can check with a grep

Not asserted in prose — machine-checked in `tests/substrate/invariants.test.ts`:

- Nothing outside the clock adapter reads wall-clock time.
- Only `state/cas-write.ts` can mutate shared state (gated on a module-private `SWAP` symbol).
- No `instanceof` on an event payload — payloads lose their prototype in transit (#12).

## Layout

```
spike/     Phase 0 receipts — every assertion + the runtime behaviour it probes
src/
  domain/          pure, no framework imports
  state/           TraconState + THE single mutator
  support/         clock, outbox, composite interception, tool contract
  infrastructure/  scheduling (turns, ledgers, orphan repair), driver
  participants/    recorder, identity book
tests/substrate/   the Phase 1 gate
docs/API-NOTES.md  14 findings against @mozaik-ai/core@4.0.5, with evidence
```

## License

MIT
