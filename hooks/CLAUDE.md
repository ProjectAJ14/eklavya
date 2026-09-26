# Working in `hooks/`

`hooks.json` registers events; `run.mjs` resolves the runtime and dispatches into
`mcp/src/hooks/`. Read the root contract and `mcp/CLAUDE.md` before changing the
TypeScript implementation. Hook schemas and observed host behavior are recorded
in `docs/verified-schemas.md`.

## Event map

Seven implementations are registered across six events. The checkpoint has two
registrations, for eight rows total.

| Event | Implementation | Responsibility |
|---|---|---|
| SessionStart | `session-start` | Record the session for this host process and the checkout pointer; migrate legacy config; replay, summarize and recall memory; start a due background update; start or replace the background dashboard (`dashboard-daemon.ts`, never under `CI` or `VITEST`); show profile/status and supply the log directive |
| UserPromptSubmit | `prompt-submit-nudge` | Refresh the host session record and checkout pointer, capture the prompt, recall relevant memory and nudge a session that has not logged concepts |
| SubagentStart | `subagent-start` | Ask implementers to log, without asking questions; exempt the tutor |
| PreToolUse (`Bash`) | `pre-tool-gate` | Deny recognized commits when the enforced session gate has not passed |
| PostToolUse (all tools) | `capture-tool` | Record one memory event with a bounded result excerpt (none for reads and edits); no quiz, summarization or provider call |
| PostToolUse (`mcp__.*log_session_concepts`) | `checkpoint-quiz` | Ask a due interleaved question after concepts are logged |
| PostToolUse (`^(Bash|Edit|Write|MultiEdit|NotebookEdit)$`) | `checkpoint-quiz` | Mark an edit into a git tree for `only_on_changes`; recheck pacing as work continues; no spinner on every tool call |
| Stop | `stop-quiz-check` | Record the turn's final message (parent only), flush the memory seam and request the remaining eligible quiz |

The MCP matcher accepts both standalone and plugin-scoped names. Do not narrow
it to one prefix. Keep the work-tool regex anchored. Hook timeouts are 10 seconds,
except Stop at 15 seconds; consult the manifest before changing them.

## Failures and latency

Every hook body runs inside `await run(async (input) => { ... })` and returns 0.
It never calls `process.exit` itself. `run()` catches failures; `openExisting()`
returns `null` for an unavailable database and never migrates or seeds it.
Stop continues a turn with JSON `additionalContext`, not exit 2.

Use the shared bounded reader in `mcp/src/stdin.ts`: reset the idle timer on
each chunk, retain the total cap, handle errors, strip BOM, unref timers and
pause the stream when finished. Removing listeners alone leaves stdin alive.
`HOOK_STDIN` is 2s idle / 5s total; `STATUSLINE_STDIN` is 150ms / 250ms. The total
cap can truncate a slow payload; on a swallowed pipe each hook can cost the idle
timeout. `test/stdin.test.ts` checks bounds and processes with stdin left open.

`EKLAVYA_INTERNAL_OBSERVER=1` must make both `run.mjs` and `run()` exit before
reading stdin, opening the database or spawning work. Never rely only on the
host's hook-disabling flag: recursive observer workers have occurred despite it.

## Separate memory from questions

Memory runs before the `quiz.enabled` check. Disabling questions does not disable
history. Capture uses the lightweight `capture-lib.ts` path; importing worker,
provider, recall or notification modules there violates `hook-isolation.test.ts`.

Stop closes a batch at `SEAM_MIN_EVENTS` (8) or `SEAM_MAX_AGE_MS` (20 minutes);
SessionStart closes remaining work except on compaction, which uses the ordinary seam thresholds. Retention runs at most every six hours in
5,000-event chunks. Notification sinks share a 5s budget. Read these constants
from source when changing or documenting them.

An observer batch is queued for a detached `eklavya memory process`, only after
winning the machine-wide reservation and only while the queue is unpaused. A
paused queue instead gets local stand-in observations each seam and, at most
every 30 minutes, a detached `--probe-paused` worker that resumes only when
`claude auth status` or the quota cooldown says the cause is fixed. Nothing is
captured or batched outside a git checkout.
Never wait on inference in a hook. `capture-tool` records subagent evidence;
prompt and Stop memory seams are parent-only.

## Output channels and delegation

Put developer messages in top-level `systemMessage`, model instructions in
`hookSpecificOutput.additionalContext`, and the event name in `hookEventName`.
Plain stdout is not a user-visible banner. Stop's context is also rendered by
the host, so keep it short and let the planner carry pedagogy details.

`SubagentStart` requires the JSON envelope. Check `quiz.enabled`, honor a
session's silence if a database exists, and continue on a missing database.
Match `eklavya-tutor` as a substring to cover namespaced and bare names. Unknown
`agent_type` receives the directive. The tutor exemption matters because the
implementer's directive says not to ask questions.

Both checkpoint and Stop return on `agent_id`; retain both guards even if the
host appears to deliver Stop only to parents. See `docs/subagent-policy.md`.

## Pacing, silence and gates

`quiet` hides the banner and status bar, not model directives or quizzes.
`quiz.enabled: false` disables questions. Session-scoped silence disables that
session's questions but never bypasses an enforced commit gate; `pre-tool-gate`
reads it only to explain how to resume and clear the gate.

Unenforced sessions can still receive Stop questions. Enforcement skips cooldown,
lifts the planner's interleaved cap and adds commit checks. It does not override
the developer's session silence.

| Cadence | Pacing and loop guard |
|---|---|
| `interleaved` | `min_minutes_between_checkpoints` (default 4) paces single questions; Stop floors its gap at one minute. Time can re-arm Stop without new logged work. |
| `end` | `min_minutes_between_quizzes` (default 20) paces the full sweep; work-origin concept count must grow since the previous block. |

Hooks and planner must use the same clock, checking both the last block and
last answer. Stamp `stop_markers` or `checkpoints` before emitting. The Stop
block cap (default 3) and remaining session question budget also bound repeats.
Every attempt consumes the shared `max_questions_per_task` allowance (default 4).
Review-origin concepts cannot re-arm the work-count guard. Change matching
candidate predicates in both hooks together: both ask only work logged within
the current stretch (`workSince` in `session.ts`: activity is a prompt or a
work tool call, and a gap over `IDLE_BREAK_MINUTES` starts a new stretch),
newest first then last inserted, and so does the planner;
enforced gates are exempt. `quiz.only_on_changes` counts an edit-tool write
into any git working tree, not ignored (`noteEdit`, marked by the checkpoint
before its subagent and cadence exits), before comparing git trees.

The shell lexer in `commit-lib.ts` recognizes common wrappers and nested shell
forms, with deliberate misses for aliases, variables and scripts. The optional
git hook covers terminal commits; do not describe the Bash detector as complete.

## Documentation and checks

Update the affected manual pages in the same PR: `first-session`, `dials`,
`how-it-works`, `memory`, `commit-gate` and `troubleshooting`. Keep the timeline
and flow labels aligned with ordering and guards. Schema/delegation changes also
update `docs/verified-schemas.md` and `docs/subagent-policy.md`.

When changing banner or checkpoint wording, search `web/public/index.html` and
manual examples for quoted output. Do not preserve a transcript that no longer
matches the source.

Run `npm test -- hooks gate stdin hook-isolation memory-observer-guard` from
`mcp/`; `pretest` builds the files the hook suites execute. Use a temporary
`EKLAVYA_HOME` and `EKLAVYA_DB` for manual probes. Behavior changes also need the
live checkpoint acceptance check in `CONTRIBUTING.md`; unit tests cannot prove
that the model asks a question and resumes work.
