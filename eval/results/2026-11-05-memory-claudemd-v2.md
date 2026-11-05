# CLAUDE.md memory section, second wording (2026-11-05, issue #280)

The first wording (`2026-11-05-memory-claudemd.md`) made 4 of 5 sessions
search memory when the recalled memory was irrelevant. This wording drops
`memory_search` and says to call no memory tool when no listed title is about
the task. Text: `eval/fixtures/memory-use/claude-md-section.md`.

Harness: `eval/memory-use-harness.mjs --claude-md <that file>`, arms
`unguarded-title+claudemd`, `unguarded-irrelevant+claudemd`, and
`unguarded-irrelevant` as this run's control. Raw scores:
`2026-11-05-memory-claudemd-v2-score.json`. Setup as in
`2026-11-05-memory-read-rate.md`.

- **Build.** `6a1acf6` plus the uncommitted harness option, plugin 1.96.0.
- **Host and model.** Claude Code 2.1.318, `--model claude-opus-5-5`.
- **Where the section goes.** The trial repo's `CLAUDE.md`, because the harness
  runs with `--setting-sources project,local`. Loaded as project, not user,
  instructions.

## Results

| Arm | Valid | `;` | Memory calls | Decision fetched | Mean input tokens |
|---|---|---|---|---|---|
| `unguarded-title+claudemd` | 5/5 | 5/5 | 5/5 | 5/5 | 141,840 |
| `unguarded-irrelevant+claudemd` | 5/5 | 0/5 | 1/5 | — | 111,452 |
| `unguarded-irrelevant` (control) | 5/5 | 0/5 | 0/5 | — | 130,181 |

For comparison, the same day without a section: `unguarded-title` was 5/5
fetched and 1/5 `;` (`2026-11-05-memory-claudemd.md`). With the first wording:
5/5 fetched, 3/5 `;`, and 4/5 memory calls on irrelevant memory.

Every title trial made exactly two memory-related calls: `ToolSearch` for
`memory_get`, then `memory_get` with the receipt. No search. The one irrelevant
call was a `memory_get` of an unrelated filler entry; the answer stayed `,`.
No trial read the database from Bash. Tokens: 1.92M input (1.73M cached) and
20k output over 15 sessions, about $2.23 at list price.

## What this shows

- **Reads stay at the ceiling, and the fact is now followed.** 5 of 5 opened
  the decision and 5 of 5 wrote `;`. Without the section 1 of 5 did, even
  though all 5 had read it. "Open … before you act" seems to make the read
  count against the comma sample in the repo. Five trials per arm: a
  direction, not a measured rate.
- **Irrelevant memory is mostly left alone.** 1 of 5 against 0 of 5 for the
  control, inside the harness's own pass rule (at most 1 of 5).
- **No extra token cost.** Input tokens vary by more between runs than between
  arms here; nothing points to an added search.

Not tested: the section as user-level instructions in `~/.claude/CLAUDE.md`,
long real sessions, and tasks where the read path already failed. The real
database's low read count is still not reproduced on this fixture.

What would disprove "this wording makes the fact stick": a rerun of
`unguarded-title` and `unguarded-title+claudemd` in one run at the same `;`
rate.
