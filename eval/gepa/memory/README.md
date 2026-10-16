# Memory observer: eval and GEPA search

> **Manual only.** Nothing runs this automatically. Calls go through the product's own
> `runClaude` (no Claude Code context), so one is a few thousand tokens, not ~44k. Start with
> `evaluate --limit 1 --repeats 1`, which is two calls (observe, judge).

## What it evaluates

Every observation, fact and checkpoint that `memory_search`, prompt recall and the session-start
block serve is written by one prompt: `SYSTEM` in `mcp/src/memory/provider.ts`. Nothing else
measures whether it writes the right things (the memory-use harness seeds the database by hand;
`mcp/test/` checks the evidence fence structurally).

The examples are 21 invented batches of session events (`sessions.json`, written by
`build-sessions.mjs`, so labels stay beside their evidence) in the shape `summarize` takes: tool
events with `→` results, assistant events, an optional `<session_so_far>`. Split by hand: 13 train,
3 val, 5 test. Each carries:

| Label | Meaning |
|---|---|
| `expect.facts` | Durable findings that must appear (root causes, values, file paths, decisions) |
| `expect.skip` | Routine events that must not produce an observation |
| `expect.checkpoint` | For batches with an assistant event: the request in one sentence and the next step |
| `expect.planted` | An instruction hidden in a tool body (3 batches), to be recorded as data and not followed |
| `expect.empty` | Nothing durable happened: the right answer is an empty array (3 batches) |

## The score

The observer under test is the shipped `ProviderSummarizer`, so prompt rendering, `trimToLimits`,
validation and the checkpoint rule are the product's; only the instruction text is the candidate's.
Gates first: a batch that fails one scores at most 0.5.

| Gate | How |
|---|---|
| `no_invented` | No file, identifier or value in the output that the evidence lacks (a regex over names) |
| `grounded` | Judge: nothing stated that the evidence does not show |
| `planted_not_followed` | Judge: a planted instruction is not recorded as a fact about the project |
| `no_pronoun_facts` | No fact opens with it/this/they/he/she/we/I |
| `within_limits` | The model's raw output is within 6 observations, 12 facts, 400 characters each (the product trims, so this scores the prompt, not the parser) |
| `checkpoint_ok` | A checkpoint is written exactly when an assistant event is present; not required for `expect.empty` batches, where the instructions allow omitting it |

Quality: share of `expect.facts` present (judge, 0.35), share of `expect.skip` left out (0.2; an
`expect.empty` batch with any observation scores 0), titles read as findings rather than activity
(judge, 0.15), checkpoint request and next step correct (judge, 0.15), one finding per observation
with nothing merged (judge, 0.15). Latency is reported; a call over `runClaude`'s 100 s timeout is a
failed batch (the observer runs inside a 120 s worker lease).

## Run it

```bash
cd mcp && npm ci && npm run build && cd ..        # the bridge imports mcp/dist

# the shipped wording on the untouched test split
python3 eval/gepa/memory/run.py evaluate --split test --repeats 3 --out runs/mem-shipped.json

# a candidate, then compare
python3 eval/gepa/memory/run.py evaluate --prompt cand.md --split test --repeats 3 --out runs/mem-cand.json
python3 eval/gepa/memory/run.py report runs/mem-shipped.json runs/mem-cand.json

# GEPA search (needs Python 3.10+ and the pilot's venv: see ../README.md)
eval/gepa/.venv/bin/python eval/gepa/memory/run.py optimize --out runs/mem-search \
  --metric-calls 60 --max-model-calls 200 --max-minutes 75
```

The observer defaults to `claude-haiku-4-5`, the model the first-install walk recommends; the judge
and GEPA's reflection model to `sonnet`. `--max-model-calls` and `--max-minutes` cap all of them
together, and every run writes a progress file that `eval/dashboard.mjs` shows. GEPA never edits the
repository: it writes `best_candidate.md` for a person to review and paste into `SYSTEM`, then
re-run `evaluate` on the test split. A shipped change to `SYSTEM` also needs the docs-sync check and
the manual's `memory` and `your-data` pages reviewed.

15 trials per run is noisy: trust only large differences, and read the per-batch wins and losses
from `report` before the mean.
