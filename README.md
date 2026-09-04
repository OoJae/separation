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

A hazard existing only in the intersection of two simultaneously-pending clearances is undetectable
by any sequential scheme **and** by validate-at-commit: validating clearance A against the world
cannot see clearance B, because B has not been applied to the world yet. And the two cannot simply be
serialized, because both aircraft are approaching the last point at which their maneuver is
physically available — so committing A first closes B's window.

That is a theorem, and it ships as a **passing test**, not a paragraph. (Phase 3.)

## Status

| Phase | | |
|---|---|---|
| 0 | The spike — prove the marquee mechanism exists before designing around it | ✅ |
| 1 | Substrate — close the gaps the runtime leaves | ✅ |
| 2 | Deterministic world, zero tokens | ⬜ |
| 3 | The interlock — **the theorem as a test** | ⬜ |
| 4 | Live controllers, three vendors | ⬜ |

## Reproduce

Everything below runs with **no network and no API key**. That is deliberate: a judge with a laptop
and no credentials must still be able to reproduce the central claims.

```bash
npm install
npm run spike      # regenerates spike/RESULTS.md against the shipped package
npm test           # 39 tests
npm run typecheck
```

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
