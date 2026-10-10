# GEPA pilot: the tutor's question-writing instructions

> **Manual only, and expensive.** Nothing runs this automatically. Each model call is a fresh
> `claude -p` that sends about 44k input tokens (Claude Code's own context plus the prompt), so
> the pilot's ~560 calls were roughly 25M input tokens. Start with `evaluate --limit 3 --repeats 1`.

An offline experiment (issue #156), not part of the product or CI. It asks whether
[GEPA](https://github.com/gepa-ai/gepa) can improve `skills/tutor/references/writing-mcq.md`
against Eklavya's own question checks and judges, and says so honestly when it cannot.

## What it does and does not touch

| Editable candidate | Fixed frame |
|---|---|
| The text of `writing-mcq.md` | `SKILL.md` (shown as-is), the planner's plan item, the code, the output contract |
| | Planner budget, tier, focus and answer slot; grading; learner preferences |

GEPA never edits the repository. The selected candidate is written under `--out`
as `best_candidate.md` next to `seed.md`; a person reviews the diff and applies it.
No learner database is read: examples come from the real planner run over
anonymised fixtures (`fixtures/`) and the question eval's own (`../fixtures/`).

## Run it

```bash
cd mcp && npm ci && npm run build && cd ..          # the evaluator is the built TypeScript
python3 -m venv eval/gepa/.venv && eval/gepa/.venv/bin/pip install -r eval/gepa/requirements.txt
node eval/gepa/build-dataset.mjs                    # real planner output -> dataset.json

# 1. baseline: the shipped prompt on the untouched test split
eval/gepa/.venv/bin/python eval/gepa/pilot.py evaluate --split test --repeats 3 --out eval/gepa/runs/baseline.json

# 2. search (small by default; every cap is explicit)
eval/gepa/.venv/bin/python eval/gepa/pilot.py optimize --out eval/gepa/runs/search \
  --metric-calls 100 --train 24 --val 12 --max-model-calls 400 --max-minutes 90

# 3. the candidate, on the same untouched test split, then compare
eval/gepa/.venv/bin/python eval/gepa/pilot.py evaluate --prompt eval/gepa/runs/search/best_candidate.md \
  --split test --repeats 3 --out eval/gepa/runs/candidate.json
eval/gepa/.venv/bin/python eval/gepa/pilot.py report eval/gepa/runs/baseline.json eval/gepa/runs/candidate.json
```

Every model call (the generator, both judges and GEPA's reflection model) goes through
`claude -p` on the machine's own login. `--max-model-calls` and `--max-minutes` are hard
caps over all of them together, because GEPA's own `max_metric_calls` counts neither the
judges nor the reflection model: one metric call here is three model calls.

## What it costs

Calls are not tokens. Every `claude -p` call is run with `--output-format json`, and the
runner adds up the reported usage. Each run's output (`optimize`'s `summary.json`,
`evaluate`'s result file) carries `budget.tokens`: input in total, how much of it was cache
reads, output, a breakdown by call kind (`generate`, `judge-audit`, `judge-cold`,
`reflect`) and `cost_usd_list_price`; `report` prints it. "Input" is fresh input plus cache
writes plus cache reads. Calls run in parallel do not share a cache, so most of that input
is billed as cache writes.

Measured on 2026-10-09 with the shipped prompt: one trial (one generation, two judge calls)
was 131,681 input tokens (38,922 cached) and 984 output, about $0.39 at list price.
A subscription is not billed per token, but this is the number that drains its limit.
Results written before token tracking (the 2026-10-09 pilot) have no token figures.

## The score

Gates first. A question that fails any gate cannot score above 0.5, and the diagnostics say which failed:

`structure` (four options, a real key, the key in the plan's slot), `rationale_free` (no
"tempting because" in a description), `key_correct` and `single_answer` (the audit judge),
`cold_answerable` (the cold-read judge), `tier_match`.

A question that passes every gate scores 0.5 plus half its quality, so it always outranks one that does not; failed questions are ranked by how many gates they pass, because a flat 0 gives the search nothing to climb (the shipped prompt passed all six on 1 of 12 validation questions in the first attempt). Quality is a weighted mean of: balance
(no visible option outruns the next; the keyed option and its description not conspicuous),
plausible distractors, a stem of one idea within the word limits, and a padding guard (no
option over 35 visible words). Prompt size, cost and latency are reported, not optimised.

Not optimised, on purpose: learner pass rate, word-count equality alone, a forced 25%
longest rate, a systematically shortest key. Sequence-level bias is *measured*, across
repeated generations, as how often the keyed option is strictly longest by label,
description and both together; ties are not counted as leaks.

The judge wording is the question eval's (`../judge-prompts.mjs`, imported by both), and
the checks are `mcp/src/eval/question-checks.ts` through `bridge.mjs`.

## Splits and leakage

`dataset.json` is split by fixture (a hash rank, 50/20/30), not by example: the same code
appears under six focus and difficulty settings, and those near-duplicates share a side.
`optimize` trains on `train`, selects on `val`, and never reads `test`. Fixtures are small
(16 codebases, 204 examples), so treat any result as a pilot.

## Pinned

`gepa==0.1.4`, the `claude` CLI on `PATH`, Node for `bridge.mjs`. Record the Eklavya
revision, the model the CLI resolves, `--seed` and the dataset `version` with any result.

## Prompt feedback

`feedback/` runs the same budget and GEPA search over prompt feedback's review instructions
(`REVIEW_SYSTEM`); see [`feedback/README.md`](feedback/README.md).

## Follow-up (not built)

Conversation-level optimisation would reuse `eval/conversation-harness.mjs` as the
evaluator over `grading.md` and `agents/tutor.md`. It should wait for this pilot to show
the question-level loop is worth its cost.
