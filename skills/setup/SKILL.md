---
name: setup
description: First-run Eklavya setup — check prerequisites, create the knowledge database, and choose a mode.
disable-model-invocation: true
---

# /eklavya:setup

Get Eklavya working on this machine. Be brief; this should take one exchange.

**1. Check prerequisites.** Run `command -v jq sqlite3` and `node --version`. The hook scripts in later phases need `jq` and `sqlite3` on `PATH`; Node must be 18+. If something is missing, say which and how to install it on this platform, then continue — the MCP server still works without them.

**2. Confirm the database.** Call `get_config` and report `global_path`, then check the DB:

```bash
sqlite3 ~/.eklavya/knowledge.db 'select domain, count(*) from concepts group by domain'
```

The server creates and seeds it on first start, so this should already show `web-auth`, `react`, `node-backend` and `git`. If the file is missing, the MCP server is not running — check `/plugin` for errors.

**3. Choose a mode.** Ask which fits, and explain in one line each:

- **ambient** (default) — questions after tasks, always skippable
- **enforced** — the session quiz must pass before a commit goes through; for interns and onboarding
- **off** — installed but dormant

Then `set_config` with their choice. Use `scope: "repo"` if they want it to apply to this project only — that writes `.eklavya.json` at the repo root, which is how a lead pins enforced mode for one codebase. Otherwise global.

**4. Say what happens next.** In ambient mode: build something, and questions will follow. Point at `/eklavya:progress` and `/eklavya:quiz`.

> The git `pre-commit` hook that enforces the gate outside Claude Code is not installed yet — that ships in Phase 3. Say so if they picked `enforced`, so they know commits from a bare terminal are not gated yet.
