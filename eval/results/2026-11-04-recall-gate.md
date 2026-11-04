# Recall gate and local-hash-v2 — 4 Nov 2026 (issue #258)

No model calls: every number here is from the deterministic harnesses
(`eval/retrieval-harness.mjs`, `eval/recall-replay.mjs`). Tokens are the
chars/4 estimate recall itself uses. Cost: zero.

## 1. Search on the synthetic corpus (110 queries, k=5)

`node eval/retrieval-harness.mjs`, before (local-hash-v1, `e8be2aa`) and after
(local-hash-v2: stopwords dropped, identifiers split, 1,024 dimensions,
rarity-weighted query).

| mode | top-1 before | top-1 after | recall before | recall after | mrr before | mrr after |
|---|---|---|---|---|---|---|
| keyword | 0.691 | 0.691 | 0.774 | 0.774 | 0.742 | 0.742 |
| semantic | 0.755 | 0.800 | 0.862 | 0.939 | 0.809 | 0.873 |
| hybrid | 0.755 | 0.800 | 0.898 | 0.930 | 0.819 | 0.870 |

Held-out split, hybrid top-1: 0.633 → 0.767; recall 0.950 → 0.967.

Unfavourable: the `worktree` adversarial pairs leak one more stale row into
the top 5 (2/5 → 3/5), and semantic top-1 on the `stale` pairs drops
0.625 → 0.375 (hybrid stays at 0.375). No `mustFind`
guarantee was lost and no SQL filter leaked.

## 2. The prompt gate on full-length prompts

`node eval/retrieval-harness.mjs --prompts` scores `recallForPrompt` itself on
22 prompts written as a developer types them (15 with a relevant entry, 7
about something the project has no memory of). Raw output:
`2026-11-04-recall-gate-prompts.json`.

| arm | gate | vectors | hit@2 | false open | tokens sent |
|---|---|---|---|---|---|
| today | strict | v1 @ 0.35 | 0.867 | 7/7 (1.000) | 4,667 |
| strict | strict | v2 @ 0.25 | 0.800 | 0/7 | 1,963 |
| terms | terms | v2 @ 0.25 | 1.000 | 1/7 (0.143) | 2,853 |

The finding: on full-length prompts today's cosine fallback opens on every
unrelated prompt. A long prompt shares enough common words with almost any
entry that its `local-hash-v1` cosine sits around 0.41 (median closest
unrelated entry), above the 0.35 gate. `local-hash-v2` drops those words: the
closest unrelated entry scores 0.162 (median) and 0.216 (90th percentile),
which is where the 0.25 floor comes from. A sweep of 0.22 / 0.25 / 0.28 / 0.30
gave strict hit@2 of 0.80 / 0.80 / 0.73 / 0.73 with no false opens at any of
them; 0.25 is the highest value that keeps 0.80.

The `terms` arm's one false open is `p-none-graphql` ("…product catalogue with
filtering by category and price"), which matched one entry on two common
words. Its misses in the strict arm (`p-password-hash`, `p-money`,
`p-health`) are prompts worded differently from their entry.

Caveat: these 22 prompts were written for this eval, by the same author as
the gate, before the gate was run on them. They are not the replay set.

## 3. Replay on real sessions — not run here

`eval/recall-replay.mjs` replays sessions from a copy of `knowledge.db` and is
the gate #258 sets (prompt hit@2 and session-start hit@6 must beat today).
This container's database holds one session and no memory entries, so no
baseline could be measured. On a scripted history (one decision on
`src/payments/retry.ts`, then sixty newer unrelated entries, then a session
that reads `retry.ts`), session-start hit@6 was 0 with the default and 1 for
that session with `retrieval.seam_query` on.

To settle it: run `node eval/recall-replay.mjs --json` on a real database and
store the output beside this file. The defaults (`seam_query` off,
`prompt_gate` strict, `timeline_items` 50, `lookup_hint` mcp) stay as they are
until that run and the `irrelevant` arm of `memory-use-harness.mjs` pass.

## 4. memory-use harness arms — not run

The `bash` lookup hint (`memory.lookup_hint`) is wired as a setting for the
`memory-use-harness.mjs` arms but was not measured: that harness calls the
model and this run had no budget for it.
