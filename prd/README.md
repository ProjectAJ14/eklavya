# Eklavya — PRD & delivery tracker

**Learn while your agent works.** A Claude Code plugin that turns agent generation time into learning time.

The full specification is frozen in **[PRD.md](PRD.md)**. This file is the live tracker: it says what is done, what is next, and where each piece of the spec is being executed.

## Phase status

| Phase | Doc | Status | Gate to proceed |
|---|---|---|---|
| 0 — Scaffold | [phase-0-scaffold.md](phase-0-scaffold.md) | ✅ Done | DB tables exist; server answers `tools/list`; seeds load |
| 1 — Manual tutor | [phase-1-manual-tutor.md](phase-1-manual-tutor.md) | ✅ Done | Diff-grounded quiz works end to end; no repeat questions |
| 2 — Ambient loop | [phase-2-ambient-loop.md](phase-2-ambient-loop.md) | ✅ Done | Quiz fires once per task; skip honored; no Stop loop |
| 3 — Enforced gates | [phase-3-enforced-gates.md](phase-3-enforced-gates.md) | ✅ Done | Commit blocked in Claude Code *and* bare terminal |
| 4 — Parallel tutoring | [phase-4-parallel-tutoring.md](phase-4-parallel-tutoring.md) | 🟢 Two-pane UX not run live | Concurrent writers, no corruption |
| 5 — Distribution | [phase-5-distribution.md](phase-5-distribution.md) | 🟠 Prepared, publish is yours | Clean-machine install works for Claude Code + Cursor |

Legend: ⬜ not started · 🟡 in progress · 🟢 built, awaiting live demo · 🟠 prepared, needs a human step · ✅ done · ⛔ blocked

## Working rules

1. **Phases run in order.** Do not start phase N+1 until phase N's acceptance demo passes.
2. **The PRD is the source of truth.** If reality forces a change, edit `PRD.md` first, then the affected phase doc, then the code.
3. **Check boxes as you go.** A task is checked only when it is implemented *and* covered by a test where the phase doc asks for one.
4. **Record deviations** in the "Notes / decisions" section at the bottom of each phase doc — not in commit messages, where they get lost.
5. **Verify the docs before writing config.** Plugin, hook, and MCP schemas drift (PRD §6). Phase 0 pins the verified findings in `docs/verified-schemas.md`.

## Highest-severity risk

The `Stop` hook infinite loop (PRD §15, phase 2). Treat the loop guard as P0: tests before implementation.

## Prerequisites

- Node 18+ (`better-sqlite3` native build)
- `jq` and `sqlite3` on `PATH` (hook scripts depend on both)
- Claude Code with plugin support

## Review passes

- **2026-08-26 — question quality.** Full read of skills, agents, hooks, plugin config and the MCP server against PRD goal 2. Nine gaps closed; notes in [phase-1](phase-1-manual-tutor.md#review-pass--2026-08-26-question-quality) and [phase-4](phase-4-parallel-tutoring.md). 238 tests green.

Created 2026-08-26.
