# Changelog

## [0.1.0] - 2026-08-26

First release. Eklavya turns coding-agent generation time into learning time: while Claude Code implements a task, it teaches the developer the concepts behind that exact work, tracks mastery locally, and can hold commits until the developer demonstrates understanding.

### Added
- **Knowledge graph and spaced repetition** — SQLite at `~/.eklavya/knowledge.db` (WAL, foreign keys), numbered migrations, and 87 seeded concepts with 88 prerequisite edges across `web-auth`, `react`, `node-backend` and `git`. SM-2 scheduling with a recency-weighted mastery score and read-time decay for concepts left unreviewed
- **Nine MCP tools** — learner profile, session concept logging, quiz planning with per-concept difficulty escalation, graded attempts, gate status, graph growth with slug normalization and near-duplicate folding, prerequisite-ordered graph queries, and config read/write across global and repo scope. `session_id` is optional everywhere; the server resolves the current session itself
- **The tutor skill** — the pedagogy: profile before asking, one question at a time, every question grounded in the diff just written, a per-tier question rubric, and a grading rubric that demands justification to resist inflation
- **Five commands** — `/eklavya:quiz`, `/eklavya:learn`, `/eklavya:progress`, `/eklavya:gate`, `/eklavya:setup`
- **Ambient loop** — `SessionStart` injects a one-line learner profile and stamps the session id; `Stop` turns a finished task into a quiz, exactly once per batch of logged work
- **Enforced mode** — `PreToolUse(Bash)` holds `git commit` until the session quiz passes, and a git `pre-commit` hook plus `cli/eklavya-gate` enforce the same rule from a bare terminal, VS Code or Cursor. Per-repo `.eklavya.json` overrides global config, so a lead can pin enforced mode on one codebase
- **Parallel tutoring** — an `eklavya-tutor` subagent (read-only, so tutoring never races implementation) and a documented two-pane workflow where one session builds while another teaches, sharing one database
- **`eklavya` CLI** — `doctor`, `config get/set`, `db-path`, and `export-rules`, which generates a Cursor rules file from the same `skills/tutor/SKILL.md` Claude Code reads, so the two editors cannot drift apart

### Notes
- Everything is local. No accounts, no sync, no telemetry. Deleting `~/.eklavya/` removes all learning history
- Hook scripts need `jq` and `sqlite3` on `PATH`; without them the hooks quietly do nothing rather than breaking a session
- 220 tests, including the full loop over the real stdio transport, hook scripts driven with fixture JSON, a real `git commit` blocked and then released by the gate, and three processes writing to one database concurrently
