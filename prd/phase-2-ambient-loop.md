# Phase 2 — Automatic ambient loop

**Status:** ⬜ Not started
**Depends on:** Phase 1
**Spec:** [PRD §9.1](PRD.md#91-sessionstart--session-startsh), [§9.2](PRD.md#92-stop--stop-quiz-checksh), [§5.1](PRD.md#51-core-loop-ambient-mode)

## Objective

Remove the manual step. The quiz happens on its own after a task, exactly once, and the learner profile is injected at session start.

> ⚠️ **P0 risk:** Stop-hook infinite loop. The loop guard is the highest-severity bug class in this project (PRD §15). Write its tests before the hook itself.

## Tasks

### 2.1 Hook wiring
- [ ] `hooks/hooks.json` per verified schema, all paths via `${CLAUDE_PLUGIN_ROOT}`
- [ ] Timeouts set conservatively so a slow hook never wedges a session

### 2.2 `SessionStart` → `hooks/session-start.sh`
- [ ] Reads profile directly from SQLite (no MCP round trip)
- [ ] Prints 2–3 lines in the PRD §9.1 format
- [ ] Honors `quiet: true` — prints nothing
- [ ] Honors `mode: off` — prints nothing
- [ ] < 200 ms; on ANY error prints nothing and exits 0
- [ ] Missing DB / corrupt DB / missing `jq` all degrade silently

### 2.3 `Stop` → `hooks/stop-quiz-check.sh`
- [ ] Reads `session_id` from stdin JSON
- [ ] Respects `stop_hook_active` — never re-block when already continuing
- [ ] Query: unmastered/due concepts in `session_concepts` for this session
- [ ] Blocks with `{"decision":"block","reason":"..."}` naming slugs + contexts
- [ ] **Loop guard:** marker keyed by session (+ stop count) so it blocks at most once per task completion
- [ ] Guard clears when new concepts are logged (next task → next quiz)
- [ ] `min_minutes_between_quizzes` respected
- [ ] Skip path: developer says "skip" → skill records grade-0 attempts → hook must not re-block
- [ ] `mode: off` → always exit 0

### 2.4 Skill updates
- [ ] Tutor skill instructs organic `log_session_concepts` batching during implementation (3–8 concepts, real contexts)
- [ ] Skill handles the block-reason handoff cleanly (reads the reason, runs the plan, records attempts)

### 2.5 Tests
- [ ] Hook-script tests with fixture JSON on stdin; assert exit codes and stdout JSON
- [ ] **Loop guard: simulated repeated Stop events block exactly once**
- [ ] `stop_hook_active=true` → never blocks
- [ ] SessionStart never exits non-zero on a corrupt DB, missing DB, or missing binary
- [ ] Skip flow → no re-block

## Acceptance criteria (demo)

- [ ] Complete a task with no manual commands → quiz offered exactly once
- [ ] Say "skip" → accepted, no re-prompt, no loop
- [ ] Kill and restart the session → profile line appears at start
- [ ] `quiet: true` → no banner; `mode: off` → nothing fires anywhere

## Notes / decisions
