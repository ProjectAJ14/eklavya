# Phase 4 — Parallel tutoring (stretch)

**Status:** ⬜ Not started
**Depends on:** Phase 3
**Spec:** [PRD §5.4](PRD.md#54-parallel-tutoring-ux-stretch-goal-phase-4), [§8 Concurrency](PRD.md#concurrency)

## Objective

Approach the dream UX: learn *during* generation, not only after. Two tracks — a `tutor` subagent, and a documented two-pane shared-DB workflow that needs no new code.

## Tasks

### 4.1 Tutor subagent
- [ ] `agents/tutor.md` — subagent definition with restricted tools (MCP tools + read-only file access)
- [ ] Decide and document invocation model: implementation delegated to a worker subagent while the main thread tutors
- [ ] Guard: tutoring must never interleave into or stall the implementation thread

### 4.2 Two-pane workflow (docs only)
- [ ] Document tmux/Herdr setup: worker session in one pane, `/eklavya:learn` in another
- [ ] Both panes share `~/.eklavya/knowledge.db` through their own MCP server instances
- [ ] Document the caveat that `session_id` differs per pane and how concepts are shared

### 4.3 Concurrency hardening
- [ ] Confirm WAL + short transactions hold under concurrent writers
- [ ] `busy_timeout` set on every connection
- [ ] Retry-on-`SQLITE_BUSY` wrapper for writes

### 4.4 Tests
- [ ] Two processes writing attempts simultaneously → no corruption, no lost writes
- [ ] Reader (git hook) during an active write → no error, no stale-read gate bypass

## Acceptance criteria

- [ ] Concurrency test passes repeatedly under load
- [ ] Two-pane workflow documented with a copy-pasteable setup
- [ ] Subagent path demoed at least once end to end

## Notes / decisions
