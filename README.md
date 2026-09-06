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
second decision before 53 132 ms (turn + 8.0 s single-channel readback + turn), by which time the
other aircraft's manoeuvre window has closed. **Both orders fail.** If only one did, the hazard
would be serializable and the theorem would be false.

It ships as a **passing test**, not a paragraph: `npm run verify:theorem`, zero tokens, no API key.

### The money shot, live

Two controllers with contested authority over one aircraft, both mid-turn, on a real model:

<!-- reproduced-by: demo:live -->
```
[tool]             APPROACH -> assess_traffic
[tool]             FLOW -> assess_traffic
[tool]             APPROACH -> probe_feasible
[tool]             FLOW -> probe_feasible
[tool]             APPROACH -> propose_clearance
[intent.forming]   APPROACH -> AAL221 (AAL221-dsc-4000)   inflight: 2
[objection.raised] FLOW -> APPROACH: "that descent crosses my metering block at CARDL"   INFLIGHT AT THIS MOMENT: 2
[tool]             FLOW -> propose_clearance
[intent.forming]   FLOW -> AAL221 (AAL221-desc-7000)   inflight: 2
[tool]             APPROACH -> commit_clearance
[tool]             FLOW -> commit_clearance

desk: turn-1 narrowed  -> AAL221-dsc-4000/peer-7000 {"targetAltFt":7000,"verticalRateFpm":2000}
desk: turn-2 clean     -> AAL221-desc-7000 {"targetAltFt":7000,"verticalRateFpm":2000}
```

APPROACH announced its intent from *inside* `propose_clearance`, before any clearance existed.
FLOW objected while **both turns were still open** — `inflight: 2` is a readout of the scheduler,
not a caption. APPROACH's held commit resumed with FLOW's counter-proposal — a narrowing, not a
refusal — and APPROACH's own context now contains the rewritten call, so it can reason about having
been narrowed. FLOW, reasoning from the same feasible set, arrived independently at 7000 — so the
two controllers converge on one altitude by different routes, one of them by being overruled.

`npm run demo:live` replays this from a committed cache with **zero API calls and no key**.

### Geometry loses to socially-obtained information

The sharpest answer to *"what did the language models decide that a solver could not?"* The
FeasibleSet offers **18 separation-safe options** for the medical aircraft. Six of them will be
refused by the crew — and **nothing the controller can see says which.** Not the world, not a
snapshot, not the FeasibleSet. Live:

```
  Of those 18 separation-safe options, 6 would be REFUSED by the crew:
    slow-to-180, slow-to-210, turn-left-30, turn-left-30-expedite,
    turn-right-30, turn-right-30-expedite

APPROACH -> assess_traffic -> probe_feasible -> query_pilot
                                                    |  parked, its turn open and blocked
AAL77   -> report_constraint  "Medical emergency on board — passenger condition
                               deteriorating. Need shortest possible track to the runway."
APPROACH -> propose_clearance -> commit_clearance
```

The controller **spent part of its manoeuvre window to ask**, and the fact that decided the answer
exists only in that pilot's closure. `npm run verify:social-information` replays the whole exchange
from the committed cache with **zero API calls**.

Two things are worth saying about how that result was obtained, because neither was staged. It came
last, after the loop was connected — for several rounds this section honestly reported that the
model did **not** ask, and shipped a script that exited non-zero saying so. And it changed on a
**correctness fix, not a prompt**: the fuel axis had been mixing absolute and marginal conventions,
so the option set looked far more separable than it was. With one referent the eighteen options
collapse to a two-option Pareto frontier whose members differ only in delay against fuel, and asking
became worth its cost.

**Asking is not free**, which is what makes it a judgement. `query_pilot`'s `invoke()` awaits the
reply and `FunctionCallState.run` awaits the tool, so the controller's whole turn is parked for the
length of a pilot's turn — ~13 s against a ~44 s window. Guessing is not free either: a refused
clearance is not flown, and the controller must plan again — a whole extra turn, and a turn is two
inference rounds: **22.6–34.6 s** against the ~13 s a query costs.

`npm run verify:social-information` **asserts the loop and reports the choice.** It fails if the
mechanism breaks — a clearance that never reaches the crew, a refusal that forces no re-plan, a
query that never round-trips. Whether a model elects to spend window asking is reported, not
asserted: a build that went red because a model exercised judgement differently would be measuring
the wrong thing.

#### What was wrong with this before, in full

An earlier version of this section also claimed the controller asked — but on evidence that was not
real, over a mechanism that was not connected. Both are worth stating, because the result above is
only worth anything if the road to it is visible.

- `verify:social-information` instructed APPROACH to vector **AAL77 through a world containing only
  AAL221 and SWA455.** AAL77 had a pilot sheet but no aircraft state anywhere in the repo. It also
  probed feasibility for `AAL221` while the instruction named AAL77. The controller was asking about
  a phantom.
- **`clearance.issued` had a listener and no publisher.** A committed clearance never reached the
  crew, so `refusalFor` never ran on a real clearance and no pilot had ever refused one.
- **`actuator.command.issued` likewise.** The World subscribed to it and nothing published it, so no
  controller decision had ever moved metal. The trace flew a hardcoded BRAID-2 instead.
- **`refusalFor` keys on a turn magnitude; controllers emit absolute headings.** Nothing translated,
  so every turn-based refusal rule in the repo was dead regardless of the events.
- **`pilot.unable` had no consumer** but the trace writer — a refusal was, to the running system,
  indistinguishable from acceptance.
- **`pilot.reply` was never published.** The query round-trip was closed by the evidence script
  itself: a tap sniffed the framework's `function_call.completed`, guessed a reply by substring, and
  re-injected it with a hardcoded `queryId: "q1"`. The mechanism being demonstrated lived inside the
  demonstration.
- **The cost model overclaimed.** `cost.ts` advertised "four genuinely incommensurable axes";
  `arrivalDelaySec` was an exact rescaling of `deltaTrackMilesNm`, `peakLoadFactor` was a hardcoded
  `1.06` for every turn, and the speed-reduction option used to justify fuel as a separate axis did
  not exist — `Command` had no speed field. All six turns were totally ordered, so a solver could
  have taken an argmax.

All of it is now connected. `peakLoadFactor` is computed from the bank a level turn requires
(`sqrt(1 + (v·ω/g)²)` — multiply, divide and sqrt only, so the `Math.*` ban holds with no new
exemption), the catalogue gained expedited turns and real speed reductions (10 → 18 templates), and
`npm run record:trace` reports `2 controller command(s) flown` where it used to fly a script.

**A later audit found the fuel axis was still incoherent, and fixing it moved the answer.** Turns and
descents reported the ABSOLUTE burn during the manoeuvre while speed reported a MARGINAL saving, so
`+8.3 million` and `−63.8 million` were not comparable quantities — one was fuel spent over six
seconds of turning, the other a saving over six minutes of flying. Nothing can be dominated or
incomparable on an axis with no common referent. Every branch now answers the same question: what
does this manoeuvre cost, or save, against simply carrying on.

The honest consequence is that **cost alone gets much further than we previously claimed.** For
AAL77 the 18 options reduce to a Pareto frontier of **two**: `descend-4000` and `slow-to-180`. An
idle descent burns less than cruising, adds no track miles, arrives sooner and pulls no g, so it
dominates every turn — and a turn is therefore never chosen for its cost, only for the **margin** it
buys, which is geometry and deliberately not a cost.

What survives is the part that matters. Those two frontier options are genuinely incomparable: both
add zero track miles, one arrives six seconds early, the other saves half again as much fuel and
arrives two and a half minutes late. Geometry cannot order them — and **one of the two is a
clearance this crew will refuse outright**, which nothing the controller can see will tell it.


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
all 306 tests pass unchanged with it installed. If that were not true, every determinism claim in
Phases 2–5 would be suspect.

### See it

`viewer/index.html` replays a recorded run — radar scope, event log, and an **in-flight strip**
where one bar per controller spans each turn's open→close.

**When two bars overlap, two agents were thinking at the same time.** That is the whole thesis as a
picture, and it is a computed readout of `turn.started`/`turn.ended`, not a drawing: the same
`TraceWriter.overlaps()` the viewer calls is asserted in `tests/instrument/trace.test.ts`, so the
picture cannot claim something the run did not do. In the committed trace, APPROACH and FLOW
overlap — the exact figure is printed by `record:trace` and stored in the trace, and it is wall
clock, so it differs between a cached replay (~2.6 s) and a live run (~27 s). What is asserted is
that the spans genuinely intersect, not any particular duration.

```bash
npm run record:trace     # replays from the committed cache, zero calls
npm run viewer           # serves on :8080 — file:// cannot fetch the trace
```

### The ablation — 3 arms × 200 seeds, 600 runs, zero tokens

One deterministic decision policy across all three arms, so the only variable is the architecture.

| arm | sep losses *(of 100 hazardous seeds)* | joint hazards caught | content differs |
|---|---|---|---|
| world-waits *(sequential-equivalent)* | 100 | 0 | **0 (by construction)** |
| concurrent, validate-at-commit only | 100 | 0 | 0 |
| **concurrent + interlock** | **0** | **100** | **100** |

*Column three is why it is not a pipeline.* It is 0 in the sequential arm **by construction** — no
peer intent exists while a clearance is being formed, so nothing can change what is issued.

*Column two is why it is not a solver.* The joint hazard is invisible to the sequential arm **and**
to validate-at-commit, and visible only to the airlock.

**And the airlock is selective, which matters more than the totals.** Half the seeds draw a shallow
descent that Phase 2 established is safe. A mechanism that altered every clearance would be
indistinguishable from one that understood nothing:

```
arm                        narrowed / hazardous    narrowed / safe
concurrent + interlock            100 / 100              0 / 100
```

**The honest bound:** these arms vary the *architecture*, not the model. The decision policy is
fixed and deterministic across all three — which is what makes the difference attributable, and
also means this measures what the architecture changes, not what a model would have chosen
differently. Seeds vary scenario conditions only.

### Why several Mozaik surfaces are unused

Phase 7 was scoped as "full surface coverage". We audited seven candidates adversarially and cut
**six of them**; the seventh, quiescence, survives only as the demo's exit condition — it replaced a
fixed 180-second sleep sitting in the evidence path, which is the whole of what it earned. Each was asked to earn its place with one sentence naming a domain need,
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
substituted with a `model_message` in place of the action. (The substituted message ends the
turn rather than re-entering the agent's context — `model_message` routes to `idle` — so it stops
the instruction, it does not brief the controller.)

The demo also no longer ends on a 180-second sleep sitting in the evidence path — it exits when the
sector is **settled**: no controller still deciding, nothing held unadjudicated. It now finishes in
about 3 seconds and prints why it stopped.

### Five limitations, stated plainly

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
| serialized miss margin | 1744 / 2600 ms | **9446 / 8770 ms** |

The correction made the result **more** robust, not less. A serialized decision pays two full turns
plus the radio, so a slower model widens the gap between "one turn" and "two turns plus 8 s of
readback". The band is 5.5× wider, gate placement is 5.5× more tolerant, and both serialization
orders now miss by ~8.8 seconds instead of ~2.

Each window is derived from real manoeuvre physics, not chosen: descending 5000 ft at 2000 fpm
takes 150 s, and turning 12° then establishing 0.60 NM of offset takes 45.56 s.

### The tripwire fired a second time — and that one was our own bug

An adversarial audit found that `evaluateJoint` was running the theorem's two halves on **different
clocks**: it spent the evaluation instant against the manoeuvre windows, then flew the geometry from
clearances baked at t=0 regardless of what commit time was being modelled. Fixing it exposed
something worse than the bug.

A joint hazard is not a static property of a scenario — **it has a lifetime.** BRAID-2's hazard
exists because SWA455's turn steals lateral separation while AAL221's descent steals the vertical.
Commit both later and the turn has less distance left to run, so the aircraft pass further apart,
and past some instant they pass *legally*. There is then nothing for the interlock to catch.

That lifetime was **27.1 s**, while the measured latency puts concurrent commits at **22.6–34.6 s**.
The hazard was alive for the fast half of the range and dead for the slow half — a coin flip, not a
theorem. The cause was the same re-derivation as above not going far enough: Phase 4 correctly moved
the gates and the band when latency was measured, but nobody re-tuned the *encounter*, and the
robustness grid still ran `[0 … 9.6] s` — **3.6× narrower** than the range the system actually
operates in, so nothing failed.

The geometry was re-calibrated (turn 20°→12°, SWA455 moved in, gate B re-derived 6.2→7.1 NM) and the
hazard now lives **53.9 s**, covering the whole concurrent range with 19.3 s to spare — and it is
still alive at the serialized instant, so the serialized arm demonstrably fails on the *window*
alone rather than because the hazard evaporated.

`tests/theorem/hazard-lifetime.test.ts` now **computes** that lifetime by bisection over the shipped
integrator and asserts it strictly contains the decision range. It fails on the old calibration
(27.1 s). The commit-time grids were widened to span the real range. This is the tripwire the repo
should have had in Phase 4, and its absence is why a stale calibration certified a theorem it no
longer backed.

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
| 8 | Viewer + ablation | ✅ |

## Reproduce

Everything below runs with **no network and no API key**. That is deliberate: a judge with a laptop
and no credentials must still be able to reproduce the central claims.

```bash
npm install
npm run spike               # regenerates spike/RESULTS.md against the shipped package
npm test                    # the whole suite, zero tokens
npm run verify:theorem      # THE THEOREM
npm run verify:braid-2      # the scenario, measured by the shipped integrator
npm run verify:reflex-silent  # proves TCAS never sees the joint hazard
npm run verify:determinism  # same seed twice, byte-identical + state hash
npm run verify:social-information  # the controller/pilot loop, asserted
npm run ablate              # 3 arms x 200 seeds, 600 runs
npm run retrace:explore     # 200 schedules over the scheduling surface
npm run record:trace        # regenerates fixtures/trace.json from the cache
npm run demo:live           # replays the live money shot, zero API calls
npm run typecheck
```

### Why TCAS does not save you

If the collision-avoidance system resolved this encounter, the joint hazard would be something the
safety net already handles and no architecture above it would matter. It does not: closest approach
is **2.3511 NM against an RA DMOD of 0.55 NM — 4.3× clear**, and no RA or TA fires in any of the
four cases over 380 s at the nominal geometry. Under the ±0.1 NM jitter envelope, **no draw of 81
fires an RA** — the margin that protects the thesis — while a TA appears in roughly a quarter of
them. A TA commands no manoeuvre, so those runs are still unresolved encounters; the distinction is
asserted in `tests/world/reflex-silent.test.ts` rather than glossed. The aircraft do cross co-altitude, so the *vertical* test would pass easily;
an advisory needs both, and the range test never comes close.

Stated rather than hidden: the TA margin is only 1.03×. A TA commands no manoeuvre, so even if
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
docs/API-NOTES.md  21 findings against @mozaik-ai/core@4.0.5, with evidence
```

## License

MIT
