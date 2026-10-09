# GEPA pilot: tutor question-writing instructions (issue #156)

Dated historical evidence from a small pilot on one day. It does not show how the shipped tutor behaves in real sessions.

## Recommendation: do not ship the candidate

On the untouched test split the candidate did **not** reduce the answer-length leak, which is what the pilot was for, and the overall gain is within what 40 trials can show. Two narrower changes look promising and should be tried on their own (below).

## Setup

- **Candidate boundary:** only the text of `skills/tutor/references/writing-mcq.md`; `SKILL.md`, the planner's plan item, the code and the output contract fixed.
- **Versions:** GEPA 0.1.4 (`optimize_anything`, generalization mode), Eklavya `02245aa` plus this PR's eval files, the default model of the `claude` CLI on the maintainer's login for the generator, both judges and the reflection model (the model id was not recorded: a limitation), seed 0.
- **Dataset:** 204 examples from real planner output over 16 fixtures (12 anonymised, 4 this repository's own), split by fixture: train 108, val 36, test 60. No learner data. Small and from few codebases.
- **Search:** 24 train and 12 validation examples, 100 metric calls, 8 iterations before the metric-call limit. 331 model calls in total (114 generations, 105 + 105 judge calls, 7 reflections), 0 errors, about 85 minutes.
- **Test:** 20 test examples (spread over fixtures), 2 generations each, the same settings for baseline and candidate. 0 generation errors on both.
- **Score:** six gates (structure, no pre-answer rationale, key correct, single defensible answer, cold answerable, tier match), then quality (balance, plausible distractors, stem, a padding guard). Failed questions rank by gates passed. See `eval/gepa/README.md`.

## Result (test split, 40 trials each)

| | Baseline | Candidate |
|---|---:|---:|
| Pass every gate | 15/40 | 18/40 |
| Mean score | 0.545 | 0.637 |
| Per-example: candidate better / worse / tied | 10 / 9 / 1 | |
| Keyed option strictly longest, label | 17/40 | 19/40 |
| Keyed option strictly longest, description | 12/40 | 14/40 |
| **Keyed option strictly longest, label + description** | **17/40** | **22/40** |

Gate failures (counts of 40):

| Gate | Baseline | Candidate |
|---|---:|---:|
| `structure` (key not in the plan's slot, etc.) | 4 | 1 |
| `key_correct` | 6 | 1 |
| `cold_answerable` | 8 | 3 |
| `tier_match` | 17 | 11 |
| `single_answer` | 15 | 15 |

## Reading it

- **The target did not move.** The keyed option was strictly longest by label plus description in 22/40 candidate questions against 17/40 baseline, so the leak is not fixed and may be slightly worse (not distinguishable from noise at this size). The candidate added explicit word budgets ("about 20-26 visible words per option, never more than 30"), but obeying them did not stop the keyed option from being the longest one.
- **Where it helped:** answer-slot obedience (`structure` 4 to 1), keyed-answer correctness (6 to 1) and cold-answerability (8 to 3). These come from instructions to place the key mechanically and to re-check it, and they are plausible, but 1 to 6 failures out of 40 is a small count and I did not repeat the run.
- **Per-example outcome is a coin flip:** better on 10, worse on 9, tied on 1.
- **Validation score overstates it:** 0.48 to 0.79 on the 12 validation examples the search selected on, against 0.545 to 0.637 on the test split. That gap is selection, not generalisation.
- **Judge noise is large.** `tier_match` fails 17/40 on the baseline and `single_answer` fails 15/40 on both; the same judge model wrote and judged questions. A gate that fails this often is partly measuring the judge, so the gate pass rates are not a clean measure of question quality.
- **No gain came from padding:** the padding guard (no option over 35 visible words) held for both, and neither prompt makes the key systematically shortest.

## Cost

Tokens were not recorded for this pilot. A later measurement of one trial (3 calls) was about 132k input tokens, about 44k per call, so the ~560 calls were very roughly 25M input tokens; treat that as an estimate.

Search: 331 model calls, about 85 minutes with 4 workers. Test evaluation: 112 calls for the baseline, 118 for the candidate. One failed attempt (before the score was shaped so failures rank by gates passed) and one run invalidated by a usage limit (63 generation and 44 reflection calls failed) are discarded; the second is why the runner now stops after 12 failed calls.

## What would change this conclusion

More repeats and a larger test split showing the candidate's longest-option rate below the baseline's; a second judge model; or a run where the length instruction is the only change.

## Follow-ups

1. Try the placement instruction ("insert the key at index `answer_position`, then re-check") alone, since slot and key failures fell most.
2. Treat the length leak as a mechanism problem, not a wording one: the live check from #157 already rejects lopsided options, so measure how often it fires and whether rewrites help, rather than asking prose to do it.
3. Conversation-level optimisation (`eval/conversation-harness.mjs` as the evaluator) should wait until a question-level run shows a gain.

Files, beside this one: `2026-10-09-gepa-pilot-candidate-writing-mcq.md`, `2026-10-09-gepa-pilot-candidate.diff` (against the shipped prompt, for review, not applied), and `2026-10-09-gepa-pilot-{baseline,candidate}-test-summary.json`.
