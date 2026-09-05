# Recorded inference

`live-cache.jsonl` is a content-addressed cache of real model answers from a live run against
`mimo-v2.5-pro` (Anthropic-protocol compatible endpoint), recorded 2026-09-05.

It is committed deliberately. `npm run demo:live` replays from it with **zero API calls and no
key**, so the money shot is reproducible by anyone who clones the repo. Delete it and the same
command makes real calls again, bounded by `--calls`.

The key is `FNV(model, reasoningEffort, serialized context items, tool names)` — see
`src/infrastructure/inference/inference-cache.ts`. Entries contain model output only: no
credentials, no endpoint URL.
