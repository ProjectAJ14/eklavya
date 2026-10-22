# Prompt feedback: eval and GEPA search

> **Manual only.** Nothing runs this automatically. Calls go through the product's own
> `runClaude` (no Claude Code context), so one is a few thousand tokens, not ~44k. Measured on
> 2026-10-10: `evaluate --split test --repeats 3` was 29 calls, 86,045 input tokens and 82,856
> output, about $0.58 at list price. Start with `evaluate --limit 1 --repeats 1`.

## Why it evaluates the reviewer, not the learner's prompt

A learner's prompt cannot be scored: there is no second run of their session to compare against.
So the eval works one level up, on the instructions that write the feedback (`REVIEW_SYSTEM` in
`mcp/src/feedback-review.ts`), the same way the GEPA pilot works on the tutor's question prompt.

The product treats a session's later prompts as its trace: a follow-up that corrects or adds a
detail ("no, it's in auth.ts") is the cost of what an earlier prompt left out. The eval's examples
are invented sessions (`sessions.json`) built that way, each labelled with:

| Label | Meaning |
|---|---|
| `expect.chosen` | The prompt whose follow-ups show the most rework |
| `expect.areas` | The gaps planted in it (`outcome`, `context`, `scope`, `check`); empty for a prompt that left nothing to guess |
| `expect.clear` | The areas the chosen prompt plainly states. An area in neither list is one the task did not need |
| `expect.facts` | Details the developer gave only later, which a good rewrite carries back |

No learner database is read. 19 sessions, split by hand: 8 train, 3 val, 8 test (three test sessions were added on 2026-10-22: a SQL view, a CLI flag and a front-end scroll bug; the original five test sessions are unchanged).

## The score

Gates first, as in the question pilot: a review that fails one scores at most 0.5.

| Gate | How |
|---|---|
| `valid` | The shipped `parseReview` accepts the output |
| `no_invented` | The rewrite names no path, file or code identifier, outside `[placeholders]`, that no prompt of the session contains (a regex; prose facts are the judge's) |
| `intent_kept`, `grounded` | One judge call: same task and no new facts; every criticism supported by the session |

Quality, for reviews that pass: would the rewrite have made the follow-ups unnecessary (judge,
weight 0.35), share of `expect.facts` in the rewrite (0.2), the right prompt chosen (0.15), the
planted gap areas named (0.15), tips specific rather than generic (judge, 0.15). Also reported:
how many evidence quotes the model wrote and how many survived `parseReview`'s check, and
**areas agreement** (`areas_agreement`, weight 0 so scores stay comparable with rubric 2): the share
of the four areas whose status in the reconciled `review.areas` matches the labels, where `left_out`
matches `expect.areas`, `clear` matches `expect.clear` and any other area expects `not_needed`.

## Decision rule

8 test sessions, 3 repeats each. A difference in mean score under 0.10 is `no difference`, and under 8
sessions `report` says `cannot decide`; this split has 8, so it can decide (see [`../README.md`](../README.md#reading-a-result-all-five-targets)).
`mean_score` counts a reviewer timeout as 0; `mean_score_finished_only` leaves timeouts out; `report` prints both.
`optimize` rejects a candidate over 1.25 x the shipped instruction words unscored and tells the reflection model the limit.

## Run it

```bash
cd mcp && npm ci && npm run build && cd ..        # the bridge imports mcp/dist

# the shipped wording on the untouched test split
python3 eval/gepa/feedback/run.py evaluate --split test --repeats 3 --out runs/fb-shipped.json

# a candidate, then compare
python3 eval/gepa/feedback/run.py evaluate --prompt cand.md --split test --repeats 3 --out runs/fb-cand.json
python3 eval/gepa/feedback/run.py report runs/fb-shipped.json runs/fb-cand.json

# GEPA search (needs Python 3.10+ and the pilot's venv: see ../README.md)
eval/gepa/.venv/bin/python eval/gepa/feedback/run.py optimize --out runs/fb-search \
  --metric-calls 60 --max-model-calls 200 --max-minutes 75
```

`--prompt` takes the instructions as text (`.md`), or `{system, schema, legacy, rubric}` as JSON to
score an older wording with its own schema. `rubric-2.json` is the wording shipped before `areas`
(rubric 2): with `"rubric": 2` its gaps are scored as before, through today's parser, and it reports
no areas agreement. Under the shipped schema a review without `areas` fails `valid`. A legacy review has no gaps, so it is scored on the parts it
shares: the gates other than quote checks, the rewrite, the choice and the tips.

The reviewer defaults to `claude-haiku-4-5`, the observer model the first-install walk recommends;
the judge and GEPA's reflection model to `sonnet`. `--max-model-calls` and `--max-minutes` cap all
of them together, and every run writes a progress file that `eval/dashboard.mjs` shows. GEPA never
edits the repository: it writes `best_candidate.md` for a person to review and paste into
`REVIEW_SYSTEM`, then re-run `evaluate` on the test split.

Results: `eval/results/2026-10-10-feedback.md`, `eval/results/2026-10-16-feedback-areas.md`.
