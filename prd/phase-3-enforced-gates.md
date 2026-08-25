# Phase 3 — Enforced mode + gates

**Status:** 🟢 Built and tested — live demo pending
**Depends on:** Phase 2
**Spec:** [PRD §9.3](PRD.md#93-pretooluse-matcher-bash--pre-tool-gatesh), [§9.4](PRD.md#94-plain-git-pre-commit-hook-outside-claude-code), [§5.2](PRD.md#52-core-loop-enforced-mode)

## Objective

Make the gate real, and make it editor-agnostic on day one: blocked inside Claude Code *and* from a bare terminal.

## Tasks

### 3.1 Schema change
- [x] Migration `002_gates_repo.sql` — add `repo TEXT` column to `gates`
- [x] `record_attempt` / gate creation stamp the repo path
- [x] Migration runner handles an existing populated DB without data loss

### 3.2 Gate lifecycle
- [x] Gate row created when session concepts are first logged, with `required` from the quiz plan and configured `max_questions_per_task`
- [x] `answered` increments per recorded attempt at/above `tier_to_ask`
- [x] `passed` computed against `pass_threshold` (default 0.7)
- [x] Skips (grade 0) count as answered but not as passing — verify this can't be gamed
- [x] Gate arithmetic lives in the MCP server, not in shell

### 3.3 `PreToolUse` (Bash) → `hooks/pre-tool-gate.sh`
- [x] Parse `tool_input.command`; early-exit 0 when it has no `git commit`
- [x] Early-exit 0 when mode ≠ `enforced`
- [x] Exit 0 when `gates.passed = 1`
- [x] Otherwise deny via the verified mechanism, with the PRD §9.3 instructive message
- [x] < 100 ms typical — it runs on every Bash call
- [x] Guard against false positives (`git commit` inside a quoted string, `echo "git commit"`) — document the chosen heuristic

### 3.4 CLI + git hook
- [x] `cli/eklavya-gate` — reads DB directly, exits 0/1, friendly message on failure
- [x] `scripts/install-git-hook.sh` — installs `pre-commit`, chains to any existing hook rather than overwriting
- [x] No-op on repos without an `.eklavya.json` enforced config
- [x] Uninstall path documented
- [x] `/eklavya:setup` installs the hook for real (Phase 1 stub replaced)

### 3.5 Repo-level config
- [x] `.eklavya.json` at repo root overrides global config; example file + docs

### 3.6 Tests
- [x] Gate pass/fail arithmetic across thresholds and partial answers
- [x] PreToolUse: non-commit Bash commands exit 0 fast
- [x] PreToolUse: enforced + unpassed → deny with reason; passed → allow
- [x] `eklavya-gate` exit codes for enforced/ambient/off and missing DB
- [x] `install-git-hook.sh` preserves a pre-existing `pre-commit` hook

## Acceptance criteria (demo)

- [ ] Enforced repo: `git commit` inside Claude Code is blocked with an instructive message
- [ ] Enforced repo: `git commit` from a bare terminal is blocked too
- [ ] Pass the quiz → both commit paths succeed
- [ ] Ambient repo: no gating anywhere, no latency regression

## Notes / decisions

**2026-08-26 — gates enforced on both paths, 30 gate tests green (191 total).** The bare-terminal half of the acceptance demo *is* machine-verified: a test stages a file in a real temp git repo, runs a real `git commit`, sees it rejected with Eklavya's message, passes the quiz, and commits successfully. The in-Claude-Code half needs the plugin loaded live.

**The macOS symlink bug — the one that would have made this look broken.** The MCP server stamped `gates.repo` from `path.resolve(cwd)` while the git hook matches on `git rev-parse --show-toplevel`, which reports the *real* path. On macOS `/tmp` is a symlink to `/private/tmp`, so the two never matched and the terminal gate silently allowed every commit. `findRepoConfig` now resolves symlinks. This is the kind of failure that looks like "the feature doesn't work" rather than an error.

**Deliberate decisions about when NOT to block:**

- **No gate row for the repo → allow.** If Eklavya never taught anything here, there is nothing to have passed, and blocking would be unpassable rather than strict.
- **The CLI fails open.** Missing `jq`, missing `sqlite3`, missing database, not a git repo — all exit 0 with a warning. A learning tool that bricks commits when a dependency is absent gets uninstalled, which teaches nobody anything.
- **Only repos with `.eklavya.json` are gated at all** (PRD §9.4), so installing the git hook is harmless everywhere else.

**Commit detection.** `git commit` counts only at a command position — start of line or after a shell separator — so `echo "git commit"` is not blocked while `npm test && git commit -m x` is. The option group allows flag values, which is what catches `git -C . commit` and `git -c user.email=x commit`; a test suite covers each form.

**Skips still cannot pass the gate.** Phase 1 built the arithmetic; phase 3 verifies it through the real hook: two skipped questions leave the commit blocked.

**`/eklavya:setup` now installs the git hook for real**, chaining to any existing `pre-commit` rather than replacing it, with `--uninstall` restoring the original.
