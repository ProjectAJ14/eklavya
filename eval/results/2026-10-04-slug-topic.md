# Slugs passed as a topic domain, 2026-10-04

Change: `get_session_quiz_plan` plans a `domain` as concept slugs when no
domain has that name and every word is an existing slug
(`feat/review-streak`, after `bf51a38`). The dashboard's review commands
hand out `claude "/eklavya:quiz <slug> [<slug>…]"`, and the quiz skill lets
the model pass that argument as either `domain` or `slugs`.

## Session plans are unchanged

`node eval/harness.mjs plan --focus <f> --limit 12` before and after the
change, for `project`, `concept` and `learn` focus (difficulty `hard`). The
plan stage drives the real planner with no model calls. With timestamps,
paths and session ids removed, each `plan.json` has 12 items and no
differences. The harness never passes `domain`, so this shows only that
session planning did not move.

## The one-slug command, live

Claude Code 2.1.289, a copy of the maintainer's database through
`EKLAVYA_HOME` / `EKLAVYA_DB`, run in the `talea` checkout:
`claude "/eklavya:quiz background-update-communication"` (a concept due
three days, last asked in `talea`). The first option of the first question
was chosen by a script.

| | Runtime | What happened | Due count |
|---|---|---|---|
| Before | installed 1.48.x | Plan came back empty; Claude said the topic was unknown and offered to mint 34 new concepts | 83 → 83 |
| After | this branch (`EKLAVYA_RUNTIME`) | One question on the concept; `record_attempt` stored it against `talea` | 83 → 82 |

An earlier run with two slugs on the installed runtime planned correctly, so
the model's choice of argument varies from run to run.

## Limitations

One live run each way. The session transcripts were not saved, so the
argument the model sent in the "after" run is not known; the deterministic
evidence is the planner tests in `mcp/test/tools.test.ts` ("plans named slugs
passed as a domain"). A run where a slug list reaches the planner and still
plans nothing, or where a real domain stops being planned as a domain, would
disprove the fix.
