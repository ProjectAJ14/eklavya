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

**3b. Choose a focus.** One more question, because it changes every quiz. Mode is how hard Eklavya pushes; focus is what it teaches.

- **project** (default) — asks about the code just written. Best when learning a codebase.
- **concept** — asks the transferable version of the same ideas. Best when learning a stack.
- **learn** — you name a topic and it teaches that, using your real code as the example where the work touches it.

`set_config` with `focus`, plus `focus_topic` if they chose `learn` — that combination is useless without one. If they have no preference, say project is the default and move on; this should not become an interview. `/eklavya:mode` changes it later.

**4. If they chose enforced, install the git hook.** The `PreToolUse` hook only covers commits made inside Claude Code. The git `pre-commit` hook covers every other path — a bare terminal, VS Code, Cursor:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/install-git-hook.sh
```

It chains to any existing `pre-commit` hook rather than replacing it, and only acts on repos whose `.eklavya.json` sets `"mode": "enforced"` — so installing it is safe even if they later switch to ambient. Mention `--uninstall` restores the previous hook.

Skip this step for ambient or off.

**5. Say what happens next.** In ambient mode: build something, and questions will follow. Point at `/eklavya:progress` and `/eklavya:quiz`. In enforced mode, add that commits are held until the session quiz passes, and `/eklavya:gate` shows what is outstanding.
