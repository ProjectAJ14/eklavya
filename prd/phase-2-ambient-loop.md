# Phase 2 — Automatic ambient loop

**Status:** ✅ Done — live-verified 2026-08-26
**Depends on:** Phase 1
**Spec:** [PRD §9.1](PRD.md#91-sessionstart--session-startsh), [§9.2](PRD.md#92-stop--stop-quiz-checksh), [§5.1](PRD.md#51-core-loop-ambient-mode)

## Objective

Remove the manual step. The quiz happens on its own after a task, exactly once, and the learner profile is injected at session start.

> ⚠️ **P0 risk:** Stop-hook infinite loop. The loop guard is the highest-severity bug class in this project (PRD §15). Write its tests before the hook itself.
>
> Phase 0 verification raised this risk: `stop_hook_active` is no longer documented (deviation D2), so the guard gets **no** help from the harness — a DB-side marker keyed by session is the only thing standing between a bug and an infinite loop.

## Tasks

### 2.1 Hook wiring
- [x] `hooks/hooks.json` per verified schema, all paths via `${CLAUDE_PLUGIN_ROOT}`
- [x] Timeouts set conservatively so a slow hook never wedges a session

### 2.2 `SessionStart` → `hooks/session-start.sh`
- [x] Reads profile directly from SQLite (no MCP round trip)
- [x] Prints 2–3 lines in the PRD §9.1 format
- [x] Honors `quiet: true` — prints nothing
- [x] Honors `mode: off` — prints nothing
- [x] < 200 ms; on ANY error prints nothing and exits 0
- [x] Missing DB / corrupt DB / missing `jq` all degrade silently

### 2.3 `Stop` → `hooks/stop-quiz-check.sh`
- [x] Reads `session_id` from stdin JSON
- [x] Honors `stop_hook_active` if present, but depends on nothing from the harness — see deviation D2
- [x] Query: unmastered/due concepts in `session_concepts` for this session
- [x] Blocks by writing the tutor instruction (slugs + contexts) to **stderr** and exiting **2** — see deviation D1 in [`docs/verified-schemas.md`](../docs/verified-schemas.md)
- [x] **Loop guard:** marker keyed by session (+ stop count) so it blocks at most once per task completion
- [x] Guard clears when new concepts are logged (next task → next quiz)
- [x] `min_minutes_between_quizzes` respected
- [x] Skip path: developer says "skip" → skill records grade-0 attempts → hook must not re-block
- [x] `mode: off` → always exit 0

### 2.4 Skill updates
- [x] Tutor skill instructs organic `log_session_concepts` batching during implementation (3–8 concepts, real contexts)
- [x] Skill handles the block-reason handoff cleanly (reads the reason, runs the plan, records attempts)

### 2.5 Tests
- [x] Hook-script tests with fixture JSON on stdin; assert exit codes and stdout JSON
- [x] **Loop guard: simulated repeated Stop events block exactly once**
- [x] `stop_hook_active=true` (when present) → never blocks; guard still correct when the field is absent
- [x] SessionStart never exits non-zero on a corrupt DB, missing DB, or missing binary
- [x] Skip flow → no re-block

## Acceptance criteria (demo)

- [x] Complete a task with no manual commands → quiz offered exactly once
- [x] Say "skip" → accepted, no re-prompt, no loop
- [x] Kill and restart the session → profile line appears at start
- [x] `quiet: true` → no banner; `mode: off` → nothing fires anywhere

## Notes / decisions

**2026-08-26 — hooks built, 28 hook tests green (160 total).** The acceptance boxes stay unchecked until the plugin is loaded live; what is machine-verified is every rule behind them, driven through the real scripts with fixture JSON on stdin.

**The loop guard.** With `stop_hook_active` undocumented (D2), the guard is entirely ours: *block only when the count of concepts logged for this session has grown since the last block.* Blocking stamps the count, so the next Stop passes no matter what happened in between — quiz answered, quiz skipped, or the model ignoring the instruction. New logged work re-arms it; `max_stop_blocks_per_session` (default 3) caps even that. Tests assert it blocks exactly once across six consecutive Stops, does not re-block after a skip, does not re-block when the same concepts are re-logged, and stops entirely at the cap.

Three bugs the tests caught, all of which would have shipped:

- **`PRAGMA busy_timeout=2000` emits a result row**, so `2000` was being prepended to the output of every hook query — the profile banner read `Learner profile: 2000` and the Stop hook parsed `2000` as its unmastered count. Now `.timeout` via `-cmd`, which is silent.
- **The profile banner gated on "anything mastered yet"**, so a learner three attempts in was told they had no learning history. Now gated on having a mastery row at all.
- **The weak-concepts query filtered on `reps > 0`** — but a failing grade resets reps to 0 under SM-2, so the filter hid exactly the concepts the learner was struggling with. That is the one query where the bug is invisible until someone does badly.

Other notes:

- Migration `002_stop_markers.sql` adds the guard table; the runner applies only the new file to an existing install, which is now covered by a test.
- `session-start.sh` stamps `meta.current_session`, closing the G1 seam: MCP tools called with no `session_id` now resolve the same session the hooks see. It stamps even when the banner is suppressed by `quiet` or `mode: off`.
- Hook scripts read SQLite and JSON directly, never Node — the banner budget is a few milliseconds, and PRD §12 keeps business rules in the server.
- The tutor skill now explains the mid-turn quiz instruction so Claude treats it as a prompt to teach rather than an error to report.


---

## Live verification — 2026-08-26

Run against a real Claude Code session (`claude --plugin-dir`), in a throwaway git repo with `EKLAVYA_HOME`/`EKLAVYA_DB` pointed at scratch so no real learning history was touched.

- **The G1 seam closed for real.** `SessionStart` stamped `meta.current_session` with Claude Code's own session id (`96b18a95-…`); the MCP tool was then called with **no** `session_id` and resolved to that same id. This is the gap that would have made every Phase 2 hook query silently return nothing.
- **The Stop hook fired unprompted.** Told to log two concepts and reply "DONE", the session instead ended up as a tutor asking a grounded question — the hook blocked and Claude took over the turn.
- **The loop guard held live.** `stop_markers` shows `block_count = 1` after the initial run *and* after a resumed follow-up turn: the second and third Stops passed. This is the P0 failure mode, and it did not occur.
