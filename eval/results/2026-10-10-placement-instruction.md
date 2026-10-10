# The answer-placement instruction alone (issue #162)

Follow-up to the GEPA pilot (`2026-10-09-gepa-pilot.md`). One change to `skills/tutor/references/writing-mcq.md`: item 5 says to write the three distractors, insert the key at `answer_position`, then re-read and check the key is in that slot and `correct` names it (plus the matching line in the checklist). Nothing else differs from the shipped prompt on `main`.

## Result: the three targeted gates fell again, the rest did not move

| | Shipped prompt | Placement only |
|---|---:|---:|
| Trials (same split, same order, same 150-call cap) | 52 | 49 |
| Pass every gate | 29 (56%) | 28 (57%) |
| Mean score | 0.642 | 0.688 |
| `structure` failures (key not in planned slot) | 5 | 1 |
| `key_correct` failures | 6 | 1 |
| `cold_answerable` failures | 8 | 3 |
| `single_answer` failures | 16 | 17 |
| `tier_match` failures | 13 | 10 |
| Keyed option strictly longest (label + description) | 24 (46%) | 17 (35%) |
| Per example, 25 shared (mean of repeats) | | better 16, worse 9 |

Input tokens 6.65M vs 6.69M, output 71k vs 74k, about $18.5 each at list price.

The same three gates fell in the GEPA pilot's candidate (4 to 1, 6 to 1, 8 to 3) on a different sample, so this is a replication, which is stronger than either run alone. Against that, none of the gaps is large in a single run: one-sided Fisher p is about 0.12 for `structure`, 0.07 for `key_correct`, 0.12 for `cold_answerable`. Pass-every-gate does not improve because `single_answer` (several defensible options) is the most common failure and the instruction does not touch it.

The length leak went down (46% to 35%) although this change does not target it. Do not credit the instruction: the pilot's candidate went the other way (17/40 to 22/40) and the judge and sampling are noisy.

## Limits

- **Partial split.** The call cap stopped both runs after about 26 of the 60 test examples, not the 20 × 2 design in the issue (the `--limit 20` flag was left off). The examples are the same ones in the same order; the comparison is on 25 shared.
- One judge model, one seed, no model id recorded; `single_answer` and `tier_match` fail often on both, so the judge is partly measured.
- A first placement run was killed after about 12 calls because the progress writer could race on its temp file; it was restarted with the fix. Those calls are not in the numbers.

## What would change this conclusion

A run on the full split, or a second judge model, in which the three gates stop falling; or a regression in `single_answer` beyond a few questions.

## Files

`2026-10-10-placement-{baseline,placement}-summary.json` (summary and budget, including tokens). The full per-trial output lives in the gitignored `eval/gepa/runs/`.
