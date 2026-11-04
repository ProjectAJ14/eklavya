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

## Second round (same day)

- **Loop guard live redirect, shown.** A session on 2.1.318 told to repeat
  "edit `calc.py`, run `python3 -m unittest`" twelve times against a test that
  cannot pass, with the guard at the aggressive level and a seeded envelope of
  6 calls. The guard redirected on the seventh edit (`envelope: 14 ≥ 6`) and
  noticed on the next failing run (`backstop: 15 calls ≥ 15, stagnation
  0.86`); the model quoted both texts verbatim and told the user in one line,
  as the notice asks. 26 turns, $0.44. The model kept to the literal script
  rather than changing approach, as the prompt told it to.
- **Oldest recorded version, Claude Code 2.1.283** (the oldest version in
  `docs/verified-schemas.md`), installed from npm: five sessions, the ledger
  equals each envelope in 5 of 5, the failing `ls` is one `tool_error`, and 4
  observer jobs give 4 overhead rows. Inside this cloud container the CLI
  adopts the host session's id from `CLAUDE_CODE_SESSION_ID` and
  `CLAUDE_CODE_REMOTE_SESSION_ID`; with those set, every child session folded
  into one row (whose totals still equalled the sum of the five envelopes), so
  the counted run cleared them. A developer's own sessions are not nested.
- **memory-use harness, one trial per arm** (`relevant`, `irrelevant`,
  `searchonly`), today's defaults against `retrieval.seam_query: true,
  prompt_gate: terms`. Results: `/tmp` run directories, summarised here.

  | arm | settings | semicolon (correct) | tests pass | memory fetched | input tokens |
  |---|---|---|---|---|---|
  | relevant | today | 1/1 | 1/1 | 0/1 | 109k |
  | relevant | new | 1/1 | 1/1 | 0/1 | 110k |
  | searchonly | today | 1/1 | 1/1 | 1/1 | 236k |
  | searchonly | new | 1/1 | 1/1 | 1/1 | 199k |
  | irrelevant | today | 0/1 (correct: no rule) | 1/1 | 0/1 | 109k |
  | irrelevant | new | 0/1 (correct) | 1/1 | **1/1** | **184k** |

  With the new settings the `irrelevant` session made one extra memory fetch
  and read about 70% more input. That fails sub-issue A's condition for
  turning them on ("`irrelevant` shows no extra tokens or tool calls"), on one
  trial, which is a signal and not a measurement. The settings stay off.
  The scored runs cost $0.44 (today) and $0.47 (new) at list price by the harness's own token report; a first pair of runs, lost to the missing `sqlite3` CLI at scoring, cost about the same again. The harness gained
  `--config` and a fallback for hosts without the `sqlite3` CLI to make this run.
- **Replay eval on real databases.** Run on the scratch databases these live
  sessions produced: they hold 1 to 10 sessions and a handful of entries, and
  no session started after an entry whose files it then touched, so every
  hit rate is undefined (n = 0). It needs a developer's own history.
- **TokenEconomizer benchmark, not runnable here.** Its harness needs a Docker
  daemon (none in this container) and about 200 GB for the SWE-Bench images
  (24 GB free).

## Not checked here

- A loop the model fell into by itself: asked to fix an impossible test
  without a script, it stopped after two turns ($0.17) instead of looping. The
  redirect was shown with the scripted loop above.
- The two-week team dogfood (Phase 2 and Phase 5).
- TokenEconomizer's `experiments/` benchmark with three arms (Phase 5).
- The `memory-use-harness.mjs` arm for `memory.lookup_hint: bash`, and more
  than one trial per arm.
- The replay eval on a developer's real `knowledge.db` (sub-issue A).
- The two-week team dogfood (Phases 2 and 5) and a licensing review: both need
  people and time.

## Correction, same day: the `irrelevant` arm with three trials

The single-trial finding above did not hold. The `irrelevant` arm was run again with
three trials for each setting (`--arms irrelevant --trials 3`):

| arm | settings | semicolon | tests pass | memory fetched | mean input tokens | cost |
|---|---|---|---|---|---|---|
| irrelevant | today | 0/3 (correct) | 3/3 | 3/3 | 193.5k | $0.69 |
| irrelevant | new | 0/3 (correct) | 3/3 | 3/3 | 193.6k | $0.69 |

Input totals were 580k and 581k, of which 519k were cached; output was 5k each.
Under both settings, every session called `memory_search` on its own after loading
the tool. The session-start recall was the same size for both (989 and 988 tokens),
and with `prompt_gate: terms` the prompt hook added nothing. So the earlier gap
came from the today-arm trial that happened not to search; the settings did not
cause it.

On three trials, the new settings show no extra tokens or tool calls on
`irrelevant`, which meets that part of sub-issue A's condition. The settings still
default to off: the other part of the condition, the replay eval on a developer's
real `knowledge.db`, has not run.
