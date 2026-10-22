# GEPA harness, first runs after #235 (2026-10-22)

Run on `main` at 688aef6 plus PR #245 (the `decide.py` rule, length cap, limits note, marker and model ids).
`origin/main` was merged before the runs ended; that commit touched only `hooks/panel/`, the workflow and docs,
and the three extraction markers show the same fixtures and the same scorer commit (`39be38a`). Data: `2026-10-22-gepa-*.json`
(the evaluations) and `2026-10-22-gepa-*-candidate-seed*.md` (the candidate texts).
Models the CLI resolved: generator `claude-sonnet-5-5` (extraction) and `claude-haiku-4-5` (feedback); judges
`claude-sonnet-5-5` and `claude-haiku-4-5`; reflection `claude-sonnet-5-5`. Every judge is a Claude model.

## Verdict under the written rule

Every comparison is **cannot decide**: each test split has 5 fixtures and the rule needs 8. The numbers below
are direction, not a result. Nothing here is shipped; a candidate goes through review of its diff first.

## Concept extraction (test split, 5 fixtures x 3 repeats, shipped guidance as baseline)

| | Pass every gate | Mean (all trials) | Mean (finished only) | Gate failures | Search cost |
|---|---|---|---|---|---|
| Shipped | 2/15 | 0.375 | 0.512 | `context_decision` 8, `valid_slugs` 4, `context_file` 1, `count` 1 | |
| Seed 0 candidate | 7/15 | 0.675 | 0.675 | `context_decision` 6, `context_file` 3 | $21.43 |
| Seed 1 candidate | 9/15 | 0.748 | 0.748 | `context_decision` 6 | $22.18 |

- **Proposals scored: 8 of 9 (seed 0) and 9 of 9 (seed 1)**, against 27 of 63 scored trials rejected unscored (9 of 10 proposals scoring 0) in the October run.
  Telling the reflection model the real headroom (2 words, not 30) is what changed it. Success criterion for item 2: met.
- Both seeds produced a different candidate, and both beat the shipped wording on the same five fixtures
  (seed 0: 3 wins, 1 loss, 1 tie; seed 1: 5 wins). Two independent searches agreeing is more than the October run had,
  but 5 fixtures cannot separate this from noise, and the baseline's 4 `valid_slugs` failures (the tool rejected the
  call) are a large share of the gap. All four are the same error: a concept `name` over 3 words (`wal-and-busy-retry` twice,
  `sql-add-column-backfill`, `mastered-http-caching`). Both candidates add "never 4" to the naming sentence, which is a
  hand-writable fix and a better first step than adopting either candidate wholesale.
- The strict `context_file` rule is kept (see `gepa/extraction/README.md`): the baseline failed it once in 15 trials this time,
  not 11, so it no longer decides most of the score. The October note's claim was about a different guidance and scorer.
- Cost of the extraction work: about $58 at list price (two searches at ~$22 each, three evaluations at ~$5), against the
  issue's estimate of $10 for one search. Plan for ~$22 a search.

## Prompt feedback (test split, 5 sessions x 3 repeats)

| | Pass every gate | Mean (all trials) | Mean (finished only) | Reviewer timeouts | Search cost |
|---|---|---|---|---|---|
| Shipped | 7/15 | 0.478 | 0.716 | 5 | |
| Seed 0 candidate | 6/15 | 0.458 | 0.762 | 6 | $2.19 |
| Seed 1 | returned the shipped wording unchanged | | | | $2.23 |

- No usable candidate, again. Seed 0's candidate is 51 words longer than the shipped one, finishes better when it
  finishes (0.762 vs 0.716) and times out more (6 vs 5): the exact failure #167 recorded, now visible as two numbers.
  Seed 1 returned the seed; 3 of its 10 proposals were over the length cap and rejected unscored.
- **The shipped reviewer timed out in 5 of 15 trials in this baseline** (October: 1 of 15). Same prompt and model alias;
  the model id is `claude-haiku-4-5`. That is a product-side question (is the 100 s limit still right, or was the
  service slow today), not a harness one. A second baseline run would say which.

## What this did not settle

- No second-family judge: `gemini` is installed but asks for an interactive sign-in, so it could not be called. The gap
  stays; the harness records the judge model ids so the shared-family limit is visible.
- `eval/gepa/dedup`, memory observer and the question pilot were not re-run.

## Update: the naming fix, measured on 8 test fixtures

The tutor skill now says a concept name is "1–3 words, never 4 or more" (`skills/tutor/SKILL.md`), paid for by trimming
two sentences so the file stays at 1,996 of 1,999 words. Three new extraction test fixtures were written after the
results above, so test is 8 fixtures and the rule can decide. Before (`main`'s block) and after (the edited skill),
3 repeats each, generator pinned to `claude-sonnet-5-5`, same fixtures and code commit (`214df72`):

| | Pass every gate | Mean (all trials) | Mean (finished only) | `valid_slugs` failures |
|---|---|---|---|---|
| Before | 5/24 | 0.467 | 0.534 | 3 |
| After | 7/24 | 0.526 | 0.574 | 2 |

Verdict from `report`: **candidate better, +0.059** (the rule needs 0.05), 6 fixtures up, 2 down. Data:
`2026-10-22-gepa-ex8-before-naming-fix.json` and `...-after-naming-fix.json`.

- This clears the rule by 0.009. Read it as a small gain, not a large one. The gate that dominates both columns is
  `context_decision` (13 and 14 of 24), which this change does not touch.
- A first pair of runs, made without pinning the generator, mixed `claude-opus-5-5` and `claude-sonnet-5-5` inside one
  result and read `no difference` (+0.018). They are discarded as not comparable; `report` now warns when a result mixes
  generator models, and the READMEs' commands pass `--model`. Cost of the extra pair: about $16.
- The 8-fixture split still has only three repeats per fixture and one generator; a further run on a different day
  could move the mean by more than the margin.
