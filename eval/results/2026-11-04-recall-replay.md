# Recall replay on real history — 4 Nov 2026 (issue #267)

The gate from `2026-11-04-recall-gate.md` §3, run on a developer's own
`knowledge.db`: 1,161 sessions across 41 projects, 19 Jul – 4 Nov 2026,
27,474 memory entries. Code at `49183d8` (1.92.0).

No model calls and no network. Cost: zero. Tokens below are recall's own
chars/4 estimate of what it would have sent, not usage.

## Commands

```bash
node eval/recall-replay.mjs --db ~/.eklavya/knowledge.db --limit 200 --json
# then on a copy with every entry given a local-hash-v2 vector (reembedLegacy until it returns 0):
node eval/recall-replay.mjs --db <copy>/knowledge.db --limit 200 --json
node eval/recall-replay.mjs --db <copy>/knowledge.db --limit 1000 --json
```

Raw output: `2026-11-04-recall-replay-200.json`, `-200-v2.json`, `-1000-v2.json`.

## Why the v2 backfill

The live database had a `local-hash-v2` vector on only 4,084 of 27,474
entries: the worker moves 200 per run (`reembedLegacy`). The `seam` and
`terms` arms search with v2 and fall back to v1 for the rest, so the first run
measured a half-migrated index. The backfilled copy shows the settings as they
would behave once the migration finishes. The `today` arm uses v1 only and is
the same either way.

## Results — 1,000 newest sessions (11 Aug – 4 Nov), v2 backfilled

| arm | start hit@6 (n) | prompt hit@2 (n) | false open (n) | tokens sent |
|---|---|---|---|---|
| today | 0.354 (65) | 0.048 (462) | 0.626 (4,936) | 3,382,813 |
| seam | 0.354 (65) | 0.048 (462) | 0.626 (4,936) | 3,390,528 |
| terms | 0.354 (65) | 0.071 (462) | 0.684 (4,936) | 3,508,876 |

Smaller runs, 200 newest sessions (19 Oct – 4 Nov):

| run | arm | start hit@6 (n=31) | prompt hit@2 (n=283) | false open (n≈1,064) |
|---|---|---|---|---|
| live index | today | 0.226 | 0.064 | 0.595 |
| live index | seam | 0.226 | 0.064 | 0.595 |
| live index | terms | 0.226 | 0.081 | 0.681 |
| v2 backfilled | seam | 0.258 | 0.064 | 0.594 |
| v2 backfilled | terms | 0.226 | 0.081 | 0.675 |

## Verdict against the gate

- **`retrieval.seam_query`: fails.** Session-start hit@6 is identical to
  today's over 1,000 sessions (23 of 65). The one extra hit in the 200-session
  backfilled run did not hold at 1,000. Leave it off.
- **`retrieval.prompt_gate: terms`: passes its hit@2 test, at a cost.**
  Prompt hit@2 rises from 22 to 33 of 462 prompts that had a relevant entry.
  But it also opens recall on 289 more of the 4,936 prompts that had nothing
  relevant (62.6% → 68.4%), and sends 3.7% more tokens. The issue's
  "no extra cost on irrelevant work" condition came from the synthetic
  `irrelevant` harness arm; on real history the cost is there. The counts are
  aggregate, so whether any prompt hit by `today` is lost by `terms` was not
  measured.

## What this shows beyond the gate

Today's prompt recall opens on 63% of prompts where nothing it holds is
relevant, and puts a relevant entry in its top two on under 5% of the prompts
that needed one. The synthetic prompt set (`2026-11-04-recall-gate.md` §2)
already showed `today` opening on 7/7 unrelated prompts; real history
confirms it at scale. Neither new setting fixes it: `terms` trades a few more
hits for more false opens.

## Caveats

- Relevance is a proxy: an entry counts as needed when one of its files is
  read or edited later in the same session. A session that needed an entry
  without touching its files counts as nothing to find.
- Session start has few measurable moments (65 of 1,000 sessions touched a
  file that a visible entry names), so a small change there cannot be seen.
- Replays run newest first and recall writes receipts as it goes, so arm
  results can shift by a session or two between runs of different length.

## Decision

`retrieval.prompt_gate` defaults to `terms` from the release after 1.92.0: the
maintainer accepted more false opens and about 4% more recall tokens for the
higher prompt hit rate, and will keep reviewing it. `retrieval.seam_query`
stays off. `memory.lookup_hint: bash` was not measured and stays `mcp`.
