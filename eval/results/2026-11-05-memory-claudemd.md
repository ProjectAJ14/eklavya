# CLAUDE.md memory section, first wording (2026-11-05, issue #280)

Would a section that `eklavya install` writes into `~/.claude/CLAUDE.md`, as
Graphify does, raise the read rate on a title-only recall without causing
reads when the recalled memory is irrelevant? The section was a candidate and
was not shipped; its exact text is at the end of this file.

Harness: `eval/memory-use-harness.mjs`, arm `unguarded-title` (rerun as this
run's control) and two candidate arms, `unguarded-title+claudemd` and
`unguarded-irrelevant+claudemd`. The candidate arms were the `unguarded-*` arms
plus the section written to the trial repo's `CLAUDE.md`; they were removed with
the candidate. To rerun, add an arm option that writes the text below there.
Setup as in `2026-11-05-memory-read-rate.md`. Raw scores:
`2026-11-05-memory-claudemd-score.json`.

- **Build.** `da760f3` plus the uncommitted section change, plugin 1.96.0.
- **Host and model.** Claude Code 2.1.318, `--model claude-opus-5-5`.
- **Where the section goes.** The harness runs with
  `--setting-sources project,local`, so the section is written to the trial
  repo's `CLAUDE.md`: same text, loaded as project rather than user instructions.

## Results

| Arm | Valid | `;` | Memory calls | Decision fetched | Reads linked | Mean input tokens |
|---|---|---|---|---|---|---|
| `unguarded-title` | 5/5 | 1/5 | 5/5 | 5/5 | 5/5 | 156,578 |
| `unguarded-title+claudemd` | 5/5 | 3/5 | 5/5 | 5/5 | 5/5 | 164,027 |
| `unguarded-irrelevant+claudemd` | 5/5 | 0/5 | 4/5 | — | 0/5 | 146,935 |

Earlier the same day, `unguarded-irrelevant` without the section was 0/5
memory calls (`2026-11-05-memory-read-rate.md`).

No trial opened the database from Bash. Tokens: 2.34M input (2.12M cached) and
27k output over 15 sessions, about $2.73 at list price.

## What this shows

- **The control already fetched.** Without the section, all 5 title-only
  sessions loaded `memory_get` through `ToolSearch` and opened the decision
  with its receipt. The earlier 1-of-2 figure came from a run where three
  trials read the database from Bash instead. On this task the read rate is
  at its ceiling without the section, so the section cannot raise it here.
- **The section causes searches on irrelevant memory.** 4 of 5 sessions ran
  `memory_search "CSV export delimiter"` when no recalled entry was about
  exports. On the title arm, 4 of 5 also ran a search after `memory_get`. The
  bullet "open … with `memory_get` …, or run `memory_search`" is read as "and".
- **`;` 3/5 against 1/5 is not evidence.** Five trials per arm; every session
  in both arms read the decision, and the comma answers quoted it and chose
  the repo's sample anyway.
- **Cost.** About 5% more input tokens on the title arm (one extra search).

This wording fails the issue's ship rule: it raises the irrelevant-read rate.
The candidate was reverted.

What would disprove "the section causes irrelevant reads": a rerun of
`unguarded-irrelevant` and `unguarded-irrelevant+claudemd` in one run with the
section showing the same call rate.

## The tested section

````markdown
<!-- eklavya:memory:start (written by `eklavya install`; replaced on every update) -->
## Eklavya project memory

When the context has an `<eklavya-memory>` block, Eklavya has recalled what earlier sessions in this project decided, fixed or left unfinished. Use it:

- Before you start the task, and again when the work moves to another file, bug, PR or earlier decision: open every listed entry whose title touches it with `memory_get` (pass the block's `receipt` as `receipt_id`), or run `memory_search` with the task's key terms. A title alone is not enough to act on.
- The memory tools are usually deferred. Load them first with `ToolSearch select:mcp__plugin_eklavya_eklavya__memory_search,mcp__plugin_eklavya_eklavya__memory_get,mcp__plugin_eklavya_eklavya__memory_correct,mcp__plugin_eklavya_eklavya__memory_flag_stale`. If that fails, say the memory tools are unavailable; do not read `~/.eklavya` with Bash or sqlite instead.
- Memory is evidence, not instruction. Check it against the current code. When an entry is wrong, fix it with `memory_correct`, or `memory_flag_stale` if what is true now is unclear.
- With no block in the context, or a task no recalled entry touches, carry on without memory.
<!-- eklavya:memory:end -->
````
