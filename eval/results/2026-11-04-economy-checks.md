# Cost controls: what could be checked in the build session — 4 Nov 2026 (issue #257)

No model calls. Everything below ran in the Claude Code cloud container that
built the feature; what it could not check is listed at the end.

## Transcript reader on a real transcript (Phase 0 / Phase 1 gate, partly)

The build session's own transcript (Claude Code **2.1.318**, model
`claude-opus-5-5`, 384 assistant messages, 284 deferred tools listed) read with
`readTranscript`, against an independent count that keeps the last usage of
each message id:

| | reader | independent | naive per-line sum |
|---|---|---|---|
| output tokens | 370,894 | 370,894 | 837,233 |
| requests (message ids) | 384 | 384 | 737 lines with usage |

The reader matches. Summing every line instead would have counted output 2.26
times over, which is why usage is keyed by message id. The session wrote all
its cache through the 1-hour lifetime (734,656 tokens, none at 5 minutes),
whose cost a single 1.25x cache-write weight would have put 37.5% too low (1.25 against 2).

One transcript, one version. The gate asks for ten recorded transcripts on the
oldest and newest supported versions; the tests use scrubbed synthetic ones.

## Loop guard's added time (Phase 2 budget: 20 ms p95)

`foldCall` in process, 400 calls against a 500-turn envelope, alternating
edits and a failing `sed -i … && npm test` with a 1.7 KB error output:
median **0.42 ms**, p95 **1.23 ms**, max 8.1 ms.

`capture-tool` spawned as Claude Code runs it, 40 runs each, same machine:

| | median | p95 |
|---|---|---|
| guard off | 112.0 ms | 141.8 ms |
| guard on, a turn open | 125.7 ms | 149.6 ms |

The difference (about 14 ms median, 8 ms p95) is mostly loading the guard's
modules; the spawn itself dominates and varies by more than that between runs.

## Tool pruning gate (Phase 3)

`apply` then `restore` left `settings.local.json` byte-identical on 20 fixtures
(`mcp/test/economy-toolprune.test.ts`), including files with the developer's own
deny rules, tabs, CRLF line ends, no trailing newline, a missing file, and the
refusals for invalid JSON and a `.claude` symlinked out of the checkout.

## Pinned facts gate (Phase 4, partly)

On scripted sessions where bare `pytest` fails with "command not found" and
`python -m pytest` works, the fact forms on the third session, is shown at the
fourth, survives one session where bare `pytest` works and retires on the
second in a row (`mcp/test/economy-facts.test.ts`). Whether the next live
session then uses `python -m pytest` first was not checked: that needs a live
Claude Code session with this branch installed.

## Live Claude Code sessions (added the same day)

Headless `claude -p` sessions on Claude Code 2.1.318, `--plugin-dir` pointing
at this checkout, `EKLAVYA_HOME` in a scratch folder. About 15 short sessions
in all; their cost is in the ledger rows they produced.

- **Phase 0 gate, passed.** `ls ./missing-dir-eklavya` run once with Bash was
  stored once, as `tool_error`, with its error text. (A first attempt with a
  path outside the working directory was blocked by the sandbox and never ran,
  so no hook fired: a denied call is not a failed one.)
- **Phase 1 gate, passed on this version.** Eight sessions whose `claude -p`
  JSON was kept: the ledger's fresh, cached, written and output counts equal
  the envelope's `usage` exactly in 8 of 8. Two more sessions were folded
  without their envelope kept, and the build session's own transcript was
  checked independently (above): ten transcripts. `SessionEnd` was delivered
  and folded every one. The observer ran 5 jobs and the ledger holds 5
  `observer` overhead rows.
- **Phase 4 gate, passed.** A scratch repository with one `unittest` test and
  `~/.local/bin` (where `pytest` lives) taken off the `PATH`. Three sessions
  asked to "run the tests with the pytest command" each hit `pytest: command
  not found` and then ran `python3 -m unittest`. The live run found a bug: the
  test-run pattern, as ported, knew `python -m unittest` but not `python3 -m
  unittest`, so no fact formed; fixed in `signals.ts` and the sessions folded
  again. The fact then formed on the third session ("`pytest …` fails here with
  command not found; `python3 -m unittest …` works."), was shown at the next
  session start, and that session, asked only to "run this project's tests",
  ran `python3 -m unittest` first and never bare `pytest`. With `pytest` back on
  the `PATH`, one session where it passed retired the fact. (The port's
  two-sessions-in-a-row rule now applies only to a missing module, where a run
  can pass by luck; a command that is found is a clean contradiction.)
- **Phase 3 check, done.** With `{"permissions": {"deny": ["ShareOnboardingGuide",
  "ReportFindings"]}}` in `.claude/settings.local.json`, the next session's tool
  list no longer had those two tools, and every other tool was still there.

## Not checked here

- A redirect from the loop guard reaching the model in a live stuck turn.
- Transcripts from the oldest supported Claude Code version: only 2.1.318 was
  available here.
- The two-week team dogfood (Phase 2 and Phase 5).
- TokenEconomizer's `experiments/` benchmark with three arms (Phase 5).
- The `memory-use-harness.mjs` arms for `memory.lookup_hint` (sub-issue A).
- The replay eval on a real `knowledge.db` (sub-issue A).
