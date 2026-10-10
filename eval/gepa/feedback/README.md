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
| `expect.facts` | Details the developer gave only later, which a good rewrite carries back |

No learner database is read. 16 sessions, split by hand: 8 train, 3 val, 5 test.

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
how many evidence quotes the model wrote and how many survived `parseReview`'s check.

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

`--prompt` takes the instructions as text (`.md`), or `{system, schema, legacy}` as JSON to score
an older wording with its own schema. A legacy review has no gaps, so it is scored on the parts it
shares: the gates other than quote checks, the rewrite, the choice and the tips.

The reviewer defaults to `claude-haiku-4-5`, the observer model the first-install walk recommends;
the judge and GEPA's reflection model to `sonnet`. `--max-model-calls` and `--max-minutes` cap all
of them together, and every run writes a progress file that `eval/dashboard.mjs` shows. GEPA never
edits the repository: it writes `best_candidate.md` for a person to review and paste into
`REVIEW_SYSTEM`, then re-run `evaluate` on the test split.

Results: `eval/results/2026-10-10-feedback.md`.
