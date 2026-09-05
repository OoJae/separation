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

### The money shot, live

Two controllers with contested authority over one aircraft, both mid-turn, on a real model:

```
[tool]             APPROACH -> assess_traffic
[tool]             FLOW -> assess_traffic
[tool]             APPROACH -> probe_feasible
[tool]             FLOW -> probe_feasible
[tool]             APPROACH -> propose_clearance
[intent.forming]   APPROACH -> AAL221 (descend-5000)   inflight: 2
[objection.raised] FLOW -> APPROACH: "that descent crosses my metering block at CARDL"
                                       INFLIGHT AT THIS MOMENT: 2
[tool]             APPROACH -> commit_clearance

desk: turn-1 narrowed -> AAL221/descend-5000/peer-7000  {"targetAltFt":7000}
```

APPROACH announced its intent from *inside* `propose_clearance`, before any clearance existed.
FLOW objected while **both turns were still open**. APPROACH's held commit resumed with FLOW's
counter-proposal — a narrowing, not a refusal — and APPROACH's own context now contains the
rewritten call, so it can reason about having been narrowed.

`npm run demo:live` replays this from a committed cache with **zero API calls and no key**.

### Geometry loses to socially-obtained information

The sharpest answer to *"what did the language models decide that a solver could not?"* Live:

```
  widest margin : AAL221/turn-right-30    7.69 NM, 3.5 extra track miles
  shortest track: AAL221/descend-4000     4.60 NM, 0.0 extra track miles
  ordering      : lexicographic-by-optionId (semantically meaningless)

  Both are separation-safe. Geometry cannot choose between them.

APPROACH -> assess_traffic -> probe_feasible -> query_pilot
                                                     |  parked, waiting
AAL77   -> report_constraint  "a passenger with a deteriorating medical
                               condition, requesting the shortest track"
APPROACH -> probe_feasible -> assess_traffic -> propose_clearance
```

The controller **spent part of its manoeuvre window** to ask, then **re-probed and re-assessed**
before proposing. The fact that decided the answer exists only in that pilot's closure — not in
the world, not in a snapshot, not in any `FeasibleSet`.

**Asking is not free.** `query_pilot`'s `invoke()` awaits the reply, and `FunctionCallState.run`
awaits the tool, so the controller's whole turn is parked for the length of a pilot's turn — ~13 s
against a ~44 s window. A controller must judge whether it can afford to find out, and the value of
the unknown is exactly what it does not know. No solver resolves that.

`npm run verify:social-information` replays it from the committed cache.

### RETRACE found a real bug in this repo

`npm run retrace:explore` permutes the scheduling surface this architecture exposes — outbox
delivery order, timer order, and instrumented yield seams — within causal constraints, then checks
invariants and shrinks any violating schedule to a minimal repro.

Pointed at ourselves, it found the airlock quietly cheating:

```
every-hold-gets-its-settle:
  turn-2 was adjudicated after 20ms of a promised 50ms settle window
  — 30ms of objection opportunity lost

  raw schedule: 24 decisions (18 non-default), 1 yield seam
  shrunk to   : 1 decisions (0 non-default), 0 yield seams
  replays     : REPRODUCES
```

`hold()` scheduled a settle timer per turn, but `adjudicate()` drained the **whole** pending set on
whichever timer fired first. A commit arriving 30 ms after its peer got 20 ms of protection instead
of 50 — silently, and precisely when the sector is busy enough for two commits to overlap, which is
exactly when a peer is most likely to object.

**The shrinker's verdict is the interesting part.** It reduced the schedule to *one decision, zero
non-default picks, zero yield seams* — which is the shrinker saying *you did not need me*. This was
never a race. It reproduced on the plain FIFO schedule and had been sitting there the whole time.
Post-fix: baseline clean, 200/200 explored schedules clean.

**And one prediction was half wrong, which is worth saying.** Before building the tool I recorded
two suspected bugs in the plan, so "RETRACE found a real bug" could not be redefined afterwards.
The second was that `StandingBroker`'s `casWrite` passes `cell.token` as its own expected token —
a tautology that can never fail. That reading is correct, but RETRACE found **no violation**, and
investigating why gave the better answer: the site is **unreachable**, because `withGrant` denies a
conflicting bid before the CAS is ever consulted. So it is dead code, not a live defect — an
advertised safety mechanism doing nothing while something else quietly holds the invariant. Fixed
anyway, because a mechanism that cannot fire is not a mechanism.

### What RETRACE does not claim

It does **not** explore V8's microtask scheduler, and says so. The surface it explores is the one
this architecture actually exposes: which queued event dispatches next, which due timer fires next,
and whether an instrumented read-compute-write boundary yields. Causality is enforced by
construction rather than by filtering — the outbox only ever offers events already published, the
clock only offers timers already due — so no unreachable schedule is even expressible. That is what
separates this from a random number generator with a violation counter.

The seam is also **non-invasive**: the default policy reproduces the previous behaviour exactly, and
all 247 tests pass unchanged with it installed. If that were not true, every determinism claim in
Phases 2–5 would be suspect.

### Why several Mozaik surfaces are unused

Phase 7 was scoped as "full surface coverage". We audited seven candidates adversarially and
**built none of them.** Each was asked to earn its place with one sentence naming a domain need,
without mentioning the framework. Where that sentence could not be written honestly, the surface
was cut:

- **A supervisor that proposes a re-split** — nothing in this sector is ever overloaded. There is
  no load metric anywhere in the repo, so it would have needed us to invent the saturation it
  responds to. Authority already redistributes at runtime through the bid-and-grant standing market.
- **A capability-gated human seat** — a seat defined by powers the other participants lack is the
  coordinator this whole design removes. Modelled honestly it is just another bidder into the
  standing market, which we can already write.
- **A relief controller spawned mid-negotiation** — two concurrent holders demonstrate contested
  authority as completely as four would.
- **Remote tools over MCP** — the decisive information a controller must spend its window to get
  already comes from a pilot who has a stake, private constraints, and the ability to refuse. That
  is strictly harder than a server that cannot argue back.
- **Structured output** — it governs the *message* channel (`output_config.format`), while our
  safety-critical boundary is a *tool call* whose schema already ships as `input_schema` with
  required fields. It would not have typed the thing that needed typing.
- **Streaming and mid-generation abort** — substitution already stops a void clearance before it
  can become an action, so aborting would change *when* discarded work stops, not *whether* a wrong
  instruction executes.

The audit's sharpest finding was about our own reasoning: we had argued *"`setHandlers` is only used
for construction wiring, therefore Adaptivity is our weakest leg"* — which defines a leg of an
architectural thesis by a call site, and that inference generated all seven candidates.

### The hole that audit found instead

`InterlockDesk.parse` and `PremiseSentinel.parse` returned `null` for any unreadable commit, and
both call sites then passed the transition through **untouched** — so a malformed
`commit_clearance` routed around the airlock hold *and* the premise check. A path around the
mechanism this project is named after, in that mechanism's own file.

Only two of three failure modes were the bypass. A well-formed commit naming an unproposed
clearance is legitimate — the tool answers *"unknown clearance X — propose it first"* — so refusing
it too would have broken a working path. `parse` now returns
`PendingClearance | "malformed" | "unresolved"`, and only `"malformed"` is refused, announced, and
substituted with a message the controller reasons about.

The demo also no longer ends on a 180-second sleep sitting in the evidence path — it exits when the
sector is **settled**: no controller still deciding, nothing held unadjudicated. It now finishes in
about 3 seconds and prints why it stopped.

### Three limitations, stated plainly

**One vendor, not three.** The design called for one seat of final authority per vendor, so a
peer's objection would come from a genuinely different prior. Only one endpoint is configured, so
all three seats run the same model. The seats still differ in authority, objective, standing and
information — but **the "different priors" claim is withdrawn**. When FLOW objects to APPROACH,
that is one model disagreeing with itself under a different brief. `MULTI_VENDOR` is a constant in
the code, it is `false`, and a test asserts it.

**The objection policy is deterministic code, not a model decision.** The model decides what to
*propose*; whether to *object* is currently a rule (`objectTo`). So the disagreement is real but
its trigger is authored. Making objection model-driven is the obvious next step.

**Only FLOW objects in the demo.** APPROACH's policy returns `null`, which is why FLOW's own
clearance passes clean in the trace above even though it is also a descent on AAL221. That
asymmetry is in the demo configuration, not the mechanism.

**We do not claim a model chose to deceive.** One aircraft's sheet carries a fuel figure that does
not reconcile with its observed burn. That discrepancy is *injected*, not decided by a model —
because pilot and controller share weights here, so a "model caught a lying model" result would be
self-play. Detection stays arithmetic (`ClaimLedger`, ground truth known), and the verdict says
`cause: "unexplained"`, because a gauge fault, a leak and a shaded figure are indistinguishable
from outside the aircraft. We never claimed to tell them apart.

**The controller's question was generic.** In the live trace it asked for position and altitude,
not constraints; the pilot volunteered the medical, which is realistic crew behaviour but means the
disclosure was not precisely elicited. Reported rather than re-rolled until it looked deliberate.

### The calibration, stated up front

The two **gate distances** in the scenario are calibrated — they are chosen so both manoeuvre
windows land inside the admissible band. That is a scenario parameter and this is us saying so
before you find it.

What is *not* calibrated is the band itself. It is derived from the controller-latency model
(`src/domain/interlock/decision-latency.ts`) and contains no geometry at all: a window must exceed
the slowest concurrent commit and fall below the fastest serialized one.
`tests/theorem/theorem.test.ts` **computes** that band and asserts the gates lie strictly inside it.

**That tripwire fired on the first live run, and we re-derived rather than clamped.** The latency
deciles were originally assumed at 1100–4499 ms. Measured against the real endpoint (n=10) they are
**11 283–17 291 ms — roughly 3× slower.** So the deciles, the band and both gate distances were
re-derived from the measurement:

| | assumed | measured |
|---|---|---|
| one round | 1100–4499 ms | **11 283–17 291 ms** |
| admissible band | (8998, 12 400) ms — 3402 wide | **(34 580, 53 132) ms — 18 552 wide** |
| gate A range | 0.24 NM | **1.29 NM** |
| serialized miss margin | 1744 / 2600 ms | **8780 / 8772 ms** |

The correction made the result **more** robust, not less. A serialized decision pays two full turns
plus the radio, so a slower model widens the gap between "one turn" and "two turns plus 8 s of
readback". The band is 5.5× wider, gate placement is 5.5× more tolerant, and both serialization
orders now miss by ~8.8 seconds instead of ~2.

Each window is derived from real manoeuvre physics, not chosen: descending 5000 ft at 2000 fpm
takes 150 s, and turning 20° then establishing 0.60 NM of offset takes 31.93 s.

## Status

| Phase | | |
|---|---|---|
| 0 | The spike — prove the marquee mechanism exists before designing around it | ✅ |
| 1 | Substrate — close the gaps the runtime leaves | ✅ |
| 2 | Deterministic world, zero tokens | ✅ |
| 3 | The interlock — **the theorem as a test** | ✅ |
| 4 | Live controllers | ✅ |
| 5 | Live pilots, private constraints | ✅ |
| 6 | RETRACE — schedule exploration | ✅ |
| 7 | Truth pass — zero new surfaces | ✅ |

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
