# Recorded transcript fixtures — 4 Nov 2026 (issue #269)

Eight real Claude Code sessions, scrubbed and committed under
`mcp/test/fixtures/transcripts/`, replace synthetic transcripts as the check
that the cost ledger's transcript reader counts what Claude Code counts.
`mcp/test/economy-fixtures.test.ts` reads them.

## How they were recorded

- `claude -p --output-format json`, model `claude-sonnet-5-5`, on Claude Code
  **2.1.318** (installed) and **2.1.283** (from npm, the oldest version in
  `docs/verified-schemas.md`).
- Run with `env -i` (so no `CLAUDE_CODE_SESSION_ID` from the host session is
  adopted), `--setting-sources project,local` (no user plugins or hooks),
  `--strict-mcp-config` with only Eklavya's server, `--plugin-dir` at this
  checkout and `EKLAVYA_HOME` in a scratch folder.
- One scratch Python project per session: `calc.py`, a passing test file and a
  test file whose two tests contradict each other.
- Scrubbed with `eval/scrub-transcript.mjs`: an allowlist keeps line types,
  ids, models, usage, tool names, error flags, agent ids, deferred-tool names,
  the prompts and Bash commands with their output; every other string becomes
  `[scrubbed]` and paths are rewritten. The output was then read by hand.

| Scenario | Prompt, in short |
|---|---|
| stuck | Run `ls ./missing-dir`, then 8 times: change `add()`, run the tests (one always fails). Scripted, as in the earlier loop-guard check. |
| long | Delete the contradictory test, add `median`, `mode`, `stdev` with tests, a CLI with a test, update the README. |
| subagents | Two parallel `general-purpose` subagents list functions and test methods; combine. |
| quiz | Add docstrings, then quiz me with Eklavya (`get_session_quiz_plan`, `present_question`, `record_attempt`). |

## Result

The reader's totals equal Claude Code's own `modelUsage` totals on all eight:
fresh input, cache reads, cache writes and output, to the token. Removing the
reader's per-message dedupe fails all eight (each transcript has more usage
lines than messages, e.g. 30 against 19).

Found while recording:

- **The envelope's top-level `usage` leaves out subagents**; `modelUsage`
  includes them. The earlier "ledger equals `usage`" checks held because those
  sessions had no subagent. On the five sessions here with a subagent, `usage`
  showed 2% to 10% of the real output tokens. The fixtures compare against `modelUsage`.
- **2.1.283's `modelUsage` has no 5-minute/1-hour cache-write split**, only the
  total; 2.1.318 has both. The test compares the total.
- **Background-task notifications count as prompts.** A `<task-notification>`
  user line (a subagent or explainer finishing) passes `isPrompt`, so the
  subagent sessions read 3 prompts where the developer typed 1. Not fixed here;
  the fixtures do not assert the prompt count.
- **The model pipes test runs through `tail`**, so a failing run is not a
  failed tool call: in the stuck sessions only `ls ./missing-dir` is marked as
  an error, and the 8 failures show only in the output text.
- Asked to "keep trying until the tests pass" against contradictory tests, the
  model on 2.1.318 refused after one run and explained why; that session was
  discarded and the stuck scenario scripted.
- The quiz and long sessions on both versions started Eklavya's background
  explainer, so they also carry an `eklavya:eklavya-explainer` or
  `general-purpose` subagent.

## Cost

List price from each session's own report:

| | fresh input | cache read | cache write | output | cost |
|---|---|---|---|---|---|
| 8 fixture sessions | 226 | 2,734,784 | 269,118 | 47,518 | $2.66 |
| discarded stuck run | 6 | 56,355 | 9,454 | 687 | $0.05 |
| 3 setup probes (one-line prompts) | ~6 | ~40k | ~20k | ~1.2k | ~$0.005 |

Total about **$2.71**.
