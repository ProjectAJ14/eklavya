# Phase 4 — Parallel tutoring (stretch)

**Status:** 🟢 Concurrency verified; two-pane UX not yet run live
**Depends on:** Phase 3
**Spec:** [PRD §5.4](PRD.md#54-parallel-tutoring-ux-stretch-goal-phase-4), [§8 Concurrency](PRD.md#concurrency)

## Objective

Approach the dream UX: learn *during* generation, not only after. Two tracks — a `tutor` subagent, and a documented two-pane shared-DB workflow that needs no new code.

## Tasks

### 4.1 Tutor subagent
- [x] `agents/tutor.md` — subagent definition with restricted tools (MCP tools + read-only file access)
- [x] Decide and document invocation model: implementation delegated to a worker subagent while the main thread tutors
- [x] Guard: tutoring must never interleave into or stall the implementation thread

### 4.2 Two-pane workflow (docs only)
- [x] Document tmux/Herdr setup: worker session in one pane, `/eklavya:learn` in another
- [x] Both panes share `~/.eklavya/knowledge.db` through their own MCP server instances
- [x] Document the caveat that `session_id` differs per pane and how concepts are shared

### 4.3 Concurrency hardening
- [x] Confirm WAL + short transactions hold under concurrent writers
- [x] `busy_timeout` set on every connection
- [x] Retry-on-`SQLITE_BUSY` wrapper for writes

### 4.4 Tests
- [x] Two processes writing attempts simultaneously → no corruption, no lost writes
- [x] Reader (git hook) during an active write → no error, no stale-read gate bypass

## Acceptance criteria

- [ ] Concurrency test passes repeatedly under load
- [ ] Two-pane workflow documented with a copy-pasteable setup
- [ ] Subagent path demoed at least once end to end

## Notes / decisions

**Still genuinely pending:** the two-pane workflow has not been run live. Concurrency is verified by three real processes writing simultaneously, and `EKLAVYA_SESSION_ID` override is unit-tested through the actual hook scripts — but nobody has yet sat in front of two panes and confirmed the experience holds together. That needs an interactive terminal, not a headless run.

**2026-08-26 — both tracks built, 200 tests green.** Concurrency is fully machine-verified: three OS processes writing attempts to one database simultaneously, asserting no lost writes per session, `PRAGMA integrity_check` clean, no orphaned rows, and a reader (standing in for the git hook) succeeding continuously throughout.

**The two-pane workflow needed one small change after all**, contrary to the PRD's assumption that it would be docs-only. Claude Code gives each pane its own session id, so two panes would have been two unrelated sessions: the teaching pane would see none of the building pane's logged work, and answering questions there would not satisfy the gate holding the other pane's commit — which is the entire point of the workflow. `EKLAVYA_SESSION_ID` now overrides session resolution in the hooks as well as the MCP server, so both panes can agree on one session. Unset in normal use, where the harness id stays authoritative.

**Retry on lock contention** (`src/concurrency.ts`) wraps every tool call. It is safe for writes specifically because a `SQLITE_BUSY` transaction has already rolled back — noted in the code, because "retry the write" is otherwise a dangerous-looking pattern. Non-lock errors rethrow immediately rather than being retried five times.

**The subagent's honest limitation is documented rather than papered over:** the main thread and a subagent take turns, so Option A feels like staged explanation rather than genuine parallel tutoring. Option B (two panes) is the one that delivers the pitch.

**The tutor subagent has no write tools.** Tutoring must never race the implementation for the same file.
