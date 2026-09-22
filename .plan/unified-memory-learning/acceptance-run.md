# Acceptance run, 2026-09-22

Driven headless (`claude -p … --plugin-dir`) against the real built hooks, in a
scratch git repo with no `.eklavya.json`, and with `EKLAVYA_HOME` pointed at a
scratch directory so nothing touched the developer's own `~/.eklavya/`.
Preconditions checked first, as `CONTRIBUTING.md` requires: `mode ambient`,
`focus concept`, `cadence interleaved`, fresh database.

## The memory half: passes, end to end, in a live session

The task was a non-trivial change to a small `cart.js` — tiered volume
discounts and tax, exact in integer cents, with assert-based checks. The model
read, wrote two files and ran them; the suite it wrote passed.

What the hooks recorded, read back out of the scratch database afterwards:

| | |
|---|---|
| Evidence captured | 6 events — 1 prompt, 1 file_read, 2 file_edit, 2 tool_use |
| Batched | 1 batch, `reason: session_seam`, 6 events |
| Summarised | 1 entry, `kind: observation`, `generator: local-v1`, filed under the scratch checkout |
| Batch provenance | `summarizer: local-v1`, `config_digest: 2e3fd7e89482` |
| Entry → evidence links | 6 of 6 |

Three things worth naming, because they are code written on this branch and
this is the first time any of it ran outside a test:

- **batch provenance** (migration 013) is populated on a real batch;
- **every evidence event is linked to its entry** — the native counterpart of
  the importer fix, so the drill-down works for captured rows too;
- **no session summary was written, correctly.** `summarizeSession` returns
  nothing below two observations, and this session produced one. A summary of a
  single observation is that observation retyped, competing with its own source
  for a bounded recall budget. The designed behaviour, observed live.

## The learning half: inconclusive, twice, and not re-run to green

`CONTRIBUTING.md` is explicit that a checkpoint can only fire if the model
called `log_session_concepts`, and that a run where it did not is
**inconclusive** — to be reported rather than re-run until one comes out green.

- **Run 1.** The model *did* call `log_session_concepts`, unprompted, which is
  the `UserPromptSubmit` nudge doing its job. The harness denied the call:
  `--permission-mode acceptEdits` does not cover MCP tools. My fault, not the
  product's. Invalid.
- **Run 2.** With the tool allowed, the model did not call it. No logging, so no
  checkpoint could fire. `session_concepts` is 0 and `attempts` is 0.

So the mid-task question — the thing the acceptance test exists to prove — is
**unverified**. Two runs, neither of them evidence, and a third would be
fishing. It needs the interactive run `CONTRIBUTING.md` actually specifies:

```bash
cd /some/scratch/repo
claude --plugin-dir /path/to/eklavya
```

Headless `-p` is a fair approximation of the hooks and proved the memory half,
but whether a model chooses to log mid-task is exactly the behaviour a
single-shot non-interactive run is worst at reproducing.
