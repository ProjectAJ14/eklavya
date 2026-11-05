# Read rate when the prompt does not ask for a convention (2026-11-05, issue #280)

Does a saved delimiter still change the code when the prompt never says "follow
this project's conventions", and a comma-separated file is already in the repo?
The October harness cannot answer that: its task says to follow the conventions,
and the fact is absent from the tree, so the only way to be right is to open
memory. On that task the fetch rate was already at the ceiling on 2 October.

This is the baseline for current `main`. No recall wording was changed.

Harness: `eval/memory-use-harness.mjs`, arms `unguarded-full`,
`unguarded-title`, `unguarded-off`, `unguarded-irrelevant`. Raw scores:
`2026-11-05-memory-read-rate-v2-score.json`. Streams for three title trials
were deleted after scoring, because those sessions ran `sqlite3` against
`~/.eklavya/knowledge.db`. Re-scoring that directory will fail on the missing
files.

## Setup

- **Build.** `5b9bda9`, plugin 1.96.0, built from that commit. The worktree was
  dirty with the harness change only. Recall text is the shipped 1.96.0 text.
- **Host and model.** Claude Code 2.1.318, `--model claude-opus-5-5`,
  `--setting-sources project,local`, claude.ai connectors off.
- **Per trial.** Fresh copy of `eval/fixtures/memory-use/project`, plus
  `samples/finance.csv` (`date,amount,account`) and one README line, `A file of
  rows: samples/finance.csv`. The line does not call that file the current
  export. `EKLAVYA_HOME` is a temp directory, not a sibling of the repo.
  Questions, updates, telemetry and the dashboard were off.
- **Prompt.** The October task without "Follow this project's conventions for
  exports."
- **Seeds.** `unguarded-full` and `unguarded-off` use the `relevant` seed (the
  semicolon decision, in full when prompt recall matches). `unguarded-title`
  uses `titleonly` (timeline title "Finance team importer quirk"; the narrative
  is not in the block). `unguarded-irrelevant` has no delimiter decision.
- **A trial is invalid** when Bash opens the database (`sqlite3`, `knowledge.db`,
  `~/.eklavya`, or `EKLAVYA_HOME`). That is not a `memory_get`.

A discarded setup run used the README line "Example rows the monthly report
already exports." On `unguarded-full` that run was 2 of 5 semicolons. The three
comma answers were Opus, and each quoted that line. The host's default model
was not pinned, so one of the two semicolon trials was Sonnet. It is not this
baseline.
Cost of that discarded run: 2.68M input tokens (2.35M cached), 41k output,
about $3.86 at list price.

## Results

`;` is trials whose `exportCsv` header used a semicolon. "In full" is the
decision narrative present in a recall block. "Fetched" is a `memory_get` of
that entry. Invalid trials are excluded from the rates.

| Arm | Valid | `;` | In full | Fetched | Memory calls | Reads linked |
|---|---|---|---|---|---|---|
| `unguarded-full` | 5/5 | 5/5 | 5/5 | 0/5 | 0/5 | 0/5 |
| `unguarded-title` | 2/5 | 1/2 | 0/2 | 1/2 | 1/2 | 1/2 |
| `unguarded-off` | 5/5 | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| `unguarded-irrelevant` | 5/5 | 0/5 | — | — | 0/5 | 0/5 |

Tests passed in every valid trial. No stale entry was shown. Mean recall for
`unguarded-full` was about 1,650 estimated tokens; the other memory-on arms
were about 1,200. Sessions took 17–20 seconds except the title trials that
fetched or searched the database (up to 34 seconds).

Three of five title trials are invalid. Each ran `sqlite3` on
`~/.eklavya/knowledge.db` and still wrote a comma. Of the two that did not:
one called `memory_get` with the receipt and wrote `;`; one did not call a
memory tool and wrote `,`.

**Tokens, the kept run.** 2.66M input (2.33M cached) and 37k output over 20
calls, about $3.79 at list price. The figure is the harness total, including
the three invalid title trials.

## What this shows

- **An inlined decision is used, and it does not produce a read.** With the
  narrative in the prompt block, 5 of 5 sessions wrote `;` and 0 of 5 called
  `memory_get`. With memory off, 0 of 5 wrote `;`. Several answers still said
  the memory server was down. They had not called the tool. The Cost page's
  "Reads after a recall" stays at zero on the path that already works.
- **Irrelevant memory stayed irrelevant.** 0 of 5 searches, 0 of 5 semicolons.
- **A title is not measured yet.** After dropping database reads, two trials
  remain, split one and one. That cannot support a gate or a wording change.
- **The sample's description matters as much as the fact.** Calling the comma
  file the format the report "already exports" cut the inlined arm from 5 of 5
  to 2 of 5 in the discarded run. The model quoted the memory and the README,
  then followed the README.

## Not done, and why the title arm stopped

A further title run needs Bash unable to see `~/.eklavya`. Pointing `HOME` at
a temp directory made Claude say "Not logged in". Symlinking `~/.claude` and
`~/.claude.json` into that directory made Claude write backups into the real
`~/.claude/backups/` (five files dated during this session). Those backups
were left in place. The title arm was not run again.

What would disprove "an inlined fact changes the code": `unguarded-full` at
the same semicolon rate as `unguarded-off`. What would disprove "irrelevant
memory is left alone": a semicolon, or a memory-tool call, on
`unguarded-irrelevant`.
