# SEPARATION

**Three air-traffic controllers hold overlapping authority over the same aircraft. Two clearances
that are each safe alone are unsafe together — and neither one exists yet while the other is being
written.**

Two aircraft each computing a safe avoidance manoeuvre will, uncoordinated, sometimes both climb and
cancel each other out. TCAS fixed that in the 1980s by making the two boxes exchange intent
*mid-decision* and forcing complementary advisories. `src/domain/reflex/advisory.ts` implements
exactly that — `selectSense()`, `isComplementary()` — for the aircraft. This project does the same
thing one layer up, for the **controllers' decisions**, where no datalink exists.

### ▶ [oojae.github.io/separation](https://oojae.github.io/separation/) — no install, no key

Scroll and the two protection volumes converge. One seed, one integrator, two architectures: the
left pane loses separation at t+97.6 s and the right does not, and the only difference is whether the
airlock was allowed to hold both half-formed clearances at once. The
[interactive viewer](https://oojae.github.io/separation/viewer/) has the recorded agent run beside
it, with the rewrite as data.

The controllers are LLM agents on [Mozaik](https://github.com/jigjoy-ai/mozaik). Their half-formed
clearances are held together in one airlock — a Mozaik `InterceptionHandler`, suspending a pending
`function_call` *without* halting the turn, so a peer can still reach it. A hazard existing **only in
the intersection of two simultaneously-pending decisions** is caught there and nowhere else, because
no single agent is ever holding both.

### The repair is a rewritten argument, inside a turn that is still open

This is a real model run, recorded once and replayed deterministically from a committed cache — so
it costs nothing, cannot fail in front of you, and a test asserts every line of it still reproduces.

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

`inflight: 2` is a readout of the scheduler, not a caption. FLOW's objection landed while both turns
were still open, and APPROACH's held commit resumed with narrowed arguments:

```
proposed {"targetAltFt":4000,"verticalRateFpm":2000}
executed {"targetAltFt":7000,"verticalRateFpm":2000}
because: "that descent crosses my metering block at CARDL"
```

The rewritten call is what executes *and* what lands in APPROACH's own context, so it reasons about
having been narrowed. A narrowing, not a refusal.

### The theorem ships as a passing test — `npm run verify:theorem`, 0.7 s

A serialized system cannot reach its second decision before 53 132 ms (turn + 8.0 s single-channel
readback + turn), by which time the other aircraft's manoeuvre window has shut. **Both** orders
fail, by 9 446 ms and 8 770 ms. If only one did, the hazard would be serializable and the theorem
false.

### The ablation — 3 arms × 200 seeds, 600 runs, zero tokens

One deterministic decision policy across all three arms, so the only variable is the architecture.

| arm | sep losses *(of 100 hazardous)* | joint hazards caught | content differs |
|---|---|---|---|
| world-waits *(sequential-equivalent)* | 100 | 0 | **0 (by construction)** |
| concurrent, validate-at-commit only | 100 | 0 | 0 |
| **concurrent + interlock** | **0** | **100** | **100** |

*Column three is why it is not a pipeline* — 0 in the sequential arm by construction, because no peer
intent exists while a clearance is being formed, so nothing can change what is issued. *Column two is
why it is not a solver* — the joint hazard is invisible to validate-at-commit too, not just to the
sequential arm. And the interlock is **selective**: 100/100 hazardous seeds altered, 0/100 safe ones.
A mechanism that altered everything would be indistinguishable from one that understood nothing.

TCAS is the *model* for what the interlock does one layer up; down at the avionics layer it never has
to fire — closest approach 2.3511 NM against an RA DMOD of 0.55 NM, 0 RAs across 81 jitter draws. The
safety net is not what resolves this encounter.

### Run it

```bash
npm run verify:theorem     # 0.6 s — the theorem
npm test                   # 313 tests, 13 s
npm run verify:braid-2     # 20 s — the scenario, under the shipped integrator
npm run ablate             # 9 s — 600 runs
npm run retrace:explore    # 10 s — the schedule explorer, pointed at ourselves
npm run demo:live          # 4 s — replays the recorded run
```

Every one of them: under half a minute, zero tokens, no API key, no network. Timings are from one
warm M-series laptop and will vary; the counts will not.

### What this is, precisely

A known result, moved one layer up. Databases call the hazard **write skew** (Berenson et al. 1995,
anomaly A5B) and catch it in the validation phase of serializable snapshot isolation (Cahill/Fekete
2008, in PostgreSQL since 9.1) — detecting the dangerous structure between two concurrent
transactions before either commits.

What is unoccupied is the **repair**. A database aborts; an agent runtime cannot afford to, because an
aborted turn costs minutes of inference. So the objection arrives as rewritten arguments instead.

### Limitations

- **One vendor, not three.** All three seats run the same model — one model disagreeing with itself
  under a different brief. The seats differ in authority, objective, standing and information, not in
  priors. `MULTI_VENDOR` is `false` and a test asserts it.
- **The gate distances are calibrated** so both manoeuvre windows land inside the admissible band.
  The band itself is derived from measured latency and contains no geometry.
- **The arms vary the architecture, not the model.** That is what makes the difference attributable,
  and it is also what bounds the claim.
- **We do not claim a model chose to deceive.** The fuel discrepancy is injected into a sheet.

### Also in here

**RETRACE** — deterministic record/replay plus a schedule explorer over the scheduling surface this
architecture exposes — found a real bug in our own airlock: a commit arriving 30 ms after its peer got
20 ms of a promised 50 ms settle window. The shrinker reduced it to one decision, zero non-default
picks, zero yield seams — proving it was never a race but an unconditional bug.

That bug is fixed, so the shipped run now finds nothing, and **a tool that finds nothing is
indistinguishable from a broken one**. So it reports what it actually did: how many schedules were
*generated* versus how many executions were **behaviourally distinct** — deduped on the choices the
scheduler was really asked to make, not on the pick-vector it was offered. It also **exits non-zero
if the scenario offers no decision points at all**, because exploring a scenario with no scheduling
surface proves nothing however many schedules you count. A test feeds the detector the exact
observation the historical bug produced and asserts it still fires.

Building on Mozaik produced **21 line-numbered findings against the shipped runtime**. Four are filed
upstream, each re-verified against the current `4.0.6` bundle:
[#113](https://github.com/jigjoy-ai/mozaik/issues/113) an `InterceptionHandler` returning `idle`
crashes the process · [#114](https://github.com/jigjoy-ai/mozaik/issues/114) `runLoop` swallows every
failure, so a dead agent is indistinguishable from a silent one ·
[#115](https://github.com/jigjoy-ai/mozaik/issues/115) `publish` is re-entrant, so participants
observe different event orders · [#116](https://github.com/jigjoy-ai/mozaik/issues/116) an unknown
tool name leaks the in-flight set. Re-checking before filing caught that a fifth was already fixed in
4.0.6. This repo is pinned to 4.0.5, the version it was built against.

Full engineering log: [`docs/NOTEBOOK.md`](docs/NOTEBOOK.md) · Runtime findings:
[`docs/API-NOTES.md`](docs/API-NOTES.md) · MIT.
