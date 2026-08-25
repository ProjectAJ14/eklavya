# Phase 3 — Enforced mode + gates

**Status:** ⬜ Not started
**Depends on:** Phase 2
**Spec:** [PRD §9.3](PRD.md#93-pretooluse-matcher-bash--pre-tool-gatesh), [§9.4](PRD.md#94-plain-git-pre-commit-hook-outside-claude-code), [§5.2](PRD.md#52-core-loop-enforced-mode)

## Objective

Make the gate real, and make it editor-agnostic on day one: blocked inside Claude Code *and* from a bare terminal.

## Tasks

### 3.1 Schema change
- [ ] Migration `002_gates_repo.sql` — add `repo TEXT` column to `gates`
- [ ] `record_attempt` / gate creation stamp the repo path
- [ ] Migration runner handles an existing populated DB without data loss

### 3.2 Gate lifecycle
- [ ] Gate row created when session concepts are first logged, with `required` from the quiz plan and configured `max_questions_per_task`
- [ ] `answered` increments per recorded attempt at/above `tier_to_ask`
- [ ] `passed` computed against `pass_threshold` (default 0.7)
- [ ] Skips (grade 0) count as answered but not as passing — verify this can't be gamed
- [ ] Gate arithmetic lives in the MCP server, not in shell

### 3.3 `PreToolUse` (Bash) → `hooks/pre-tool-gate.sh`
- [ ] Parse `tool_input.command`; early-exit 0 when it has no `git commit`
- [ ] Early-exit 0 when mode ≠ `enforced`
- [ ] Exit 0 when `gates.passed = 1`
- [ ] Otherwise deny via the verified mechanism, with the PRD §9.3 instructive message
- [ ] < 100 ms typical — it runs on every Bash call
- [ ] Guard against false positives (`git commit` inside a quoted string, `echo "git commit"`) — document the chosen heuristic

### 3.4 CLI + git hook
- [ ] `cli/eklavya-gate` — reads DB directly, exits 0/1, friendly message on failure
- [ ] `scripts/install-git-hook.sh` — installs `pre-commit`, chains to any existing hook rather than overwriting
- [ ] No-op on repos without an `.eklavya.json` enforced config
- [ ] Uninstall path documented
- [ ] `/eklavya:setup` installs the hook for real (Phase 1 stub replaced)

### 3.5 Repo-level config
- [ ] `.eklavya.json` at repo root overrides global config; example file + docs

### 3.6 Tests
- [ ] Gate pass/fail arithmetic across thresholds and partial answers
- [ ] PreToolUse: non-commit Bash commands exit 0 fast
- [ ] PreToolUse: enforced + unpassed → deny with reason; passed → allow
- [ ] `eklavya-gate` exit codes for enforced/ambient/off and missing DB
- [ ] `install-git-hook.sh` preserves a pre-existing `pre-commit` hook

## Acceptance criteria (demo)

- [ ] Enforced repo: `git commit` inside Claude Code is blocked with an instructive message
- [ ] Enforced repo: `git commit` from a bare terminal is blocked too
- [ ] Pass the quiz → both commit paths succeed
- [ ] Ambient repo: no gating anywhere, no latency regression

## Notes / decisions
