# SEPARATION — demo film
**Runtime 2:00 · 1920×1080 · 30 fps · voiceover + light sound design**

Every number spoken is machine-checked. Source in brackets — no claim in this film
is unverifiable, which is the point of the film.

---

## Director's notes

**Pace.** Documentary, ~140 wpm. Let the silences sit — there are three deliberate
holds (S3, S5, S7). The subject is a near-miss; rushing it reads as a sizzle reel.

**Grade.** The product's own tokens, nothing invented: void `#06090D`, chart `#E6E1D6`,
phosphor `#2FF08A`. Red `#FF4D3D` appears **twice in the whole film** — S3 and S8. That
scarcity is what makes it mean something.

**Rule.** Numbers are mono. Prose is sans. Never mixed in one line.

**Motion.** Transform and opacity only. Easing `cubic-bezier(.16,1,.3,1)`. No slides,
no wipes, no easing that draws attention to itself. One camera move per scene, maximum.

**Sound.** A single sub-bass bed at −24 LUFS. One radar sweep tick per scene change.
At S3 the bed drops out entirely for 900 ms — the silence is the alarm, not a stinger.

---

## Shot list

| # | In | Dur | On screen | VO |
|---|----|-----|-----------|-----|
| **S1** | 0:00 | 11s | Black. Two wireframe protection volumes drift in from the void, 12 NM apart. Dimension line between them. Mono readout `12.35 NM / 3000 FT` counts down as they close. | Air traffic control has one rule. Three nautical miles apart — or a thousand feet of altitude. Break both at the same moment, and you have lost separation. |
| **S2** | 0:11 | 13s | Cut to the in-flight strip. Two bars, `APPROACH` blue and `FLOW` violet, extend simultaneously. Label resolves: **57.8s both thinking**. | Two controllers. One aircraft. Both are deciding right now — and neither decision exists yet while the other is being written. |
| **S3** | 0:24 | 15s | Split screen. Left: descent only → `SAFE`. Right: turn only → `SAFE`. They slide together into one frame. Volumes interpenetrate. **RED.** Readout `2.3511 NM / 400 FT`. *Hold 900ms of silence.* | The descent, on its own, is safe. The turn, on its own, is safe. Together they put two aircraft four hundred feet apart. |
| **S4** | 0:39 | 12s | Type-only. `write skew` sets centre. Beneath, small: *Berenson et al., 1995 — anomaly A5B*. | This has a name. Databases called it write skew in 1995, and solved it. Agent runtimes have not. |
| **S5** | 0:51 | 15s | Timeline graphic. Serialized track: second decision lands at `53132 ms`. Two window bars slam shut before it. Labels `missed by 9446 ms` / `missed by 8770 ms`. | So take turns instead. A sequential system cannot reach its second decision for fifty-three seconds. By then both windows are shut. Both orders fail. |
| **S6** | 1:06 | 13s | The airlock. Two pending calls held in one gate, neither committed. Strip still showing both bars lit. `INFLIGHT AT THIS MOMENT: 2`. | So SEPARATION holds them together — one gate, at the moment before commitment, while both agents are still thinking. |
| **S7** | 1:19 | 14s | The diff, typed live. `proposed {"targetAltFt":4000}` strikes through red. `executed {"targetAltFt":7000}` resolves phosphor. Below: *because: that descent crosses my metering block at CARDL*. *Hold.* | The second agent rewrites the first one's arguments, mid-call. Descend to four thousand becomes descend to seven thousand. Not a refusal — a narrowing. |
| **S8** | 1:33 | 14s | A/B panes. Both plan views identical, both `2.3511 NM`. Altitude readouts diverge: left `400 FT` red, right `1000 FT` phosphor. | Same seed, same integrator. On a radar scope these two outcomes are the same picture. One is four hundred feet apart. The other is exactly one thousand — the standard itself. |
| **S9** | 1:47 | 13s | Ablation table builds row by row. `100 / 100 / 0`. Then the command block. Wordmark. | Six hundred runs. Sequential loses separation every time. Validate-at-commit loses it every time. The gate loses none. Three hundred and thirteen tests, no API key, nothing to install. |

**Total 2:00**

---

## VO only — paste into Clipchamp

> Air traffic control has one rule. Three nautical miles apart — or a thousand feet of altitude. Break both at the same moment, and you have lost separation.
>
> Two controllers. One aircraft. Both are deciding right now — and neither decision exists yet while the other is being written.
>
> The descent, on its own, is safe. The turn, on its own, is safe. Together they put two aircraft four hundred feet apart.
>
> This has a name. Databases called it write skew in 1995, and solved it. Agent runtimes have not.
>
> So take turns instead. A sequential system cannot reach its second decision for fifty-three seconds. By then both windows are shut. Both orders fail.
>
> So SEPARATION holds them together — one gate, at the moment before commitment, while both agents are still thinking.
>
> The second agent rewrites the first one's arguments, mid-call. Descend to four thousand becomes descend to seven thousand. Not a refusal — a narrowing.
>
> Same seed, same integrator. On a radar scope these two outcomes are the same picture. One is four hundred feet apart. The other is exactly one thousand — the standard itself.
>
> Six hundred runs. Sequential loses separation every time. Validate-at-commit loses it every time. The gate loses none. Three hundred and thirteen tests, no API key, nothing to install.

**247 words.** At 140 wpm ≈ 1:46, leaving ~4s of breathing room across nine scenes.
If your Clipchamp voice runs fast, add a 400ms pause after *"four hundred feet apart"* (S3)
and after *"a narrowing"* (S7) — both are written as holds.

---

## Provenance of every spoken number

| Spoken | Value | Source |
|---|---|---|
| three nautical miles / a thousand feet | 3.0 NM, 1000 ft | `src/domain/airspace/separation-standard.ts` |
| four hundred feet apart | 400.67 ft | `fixtures/ablation-ab.json`, arm B @ t+115 |
| write skew, 1995 | anomaly A5B | Berenson et al., *A Critique of ANSI SQL Isolation Levels* |
| fifty-three seconds | 53 132 ms | `npm run verify:theorem` |
| missed by 9446 / 8770 ms | both orders | `npm run verify:theorem` |
| 57.8s both thinking | 57.78 s overlap | `fixtures/trace.json`, turns |
| 2.3511 NM | identical, both arms @ t+115 | `fixtures/ablation-ab.json` |
| exactly one thousand | 1000 ft, arm C | `fixtures/ablation-ab.json` |
| 4000 → 7000 | the narrowing | `npm run demo:live` |
| six hundred runs | 3 arms × 200 seeds | `fixtures/ablation.json` |
| 100 / 100 / 0 | losses by arm | `fixtures/ablation.json` |
| three hundred and thirteen tests | 313 passed, 0 failed | `npm test` |
