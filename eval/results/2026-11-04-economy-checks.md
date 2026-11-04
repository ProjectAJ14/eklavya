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

## Not checked here

- A live Claude Code session with this branch installed: the scripted failing
  `ls` (Phase 0 gate), redirects reaching the model, `SessionEnd` delivery.
- Ten recorded transcripts on the oldest and newest supported versions.
- The two-week team dogfood (Phase 2 and Phase 5).
- Whether a bare tool name in `permissions.deny` removes the tool on current
  Claude Code (Phase 3).
- TokenEconomizer's `experiments/` benchmark with three arms (Phase 5).
- The `memory-use-harness.mjs` arms for `memory.lookup_hint` (sub-issue A).
- The replay eval on a real `knowledge.db` (sub-issue A).
