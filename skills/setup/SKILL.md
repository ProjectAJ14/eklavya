---
name: setup
description: First-run Eklavya setup — check prerequisites, create the database, choose how hard it pushes, and say what memory does.
disable-model-invocation: true
---

# /eklavya:setup

Get Eklavya working on this machine. Be brief; this should take one exchange.

**1. Check prerequisites.** Run `node --version`. That is the whole list — the server, the CLI and all seven hooks are Node, so nothing else has to be on `PATH`. Node must be 22+; below that the SQLite driver has no prebuilt binary and would need a C++ toolchain to install. If it is older, say so and how to upgrade on this platform, and stop: the rest of setup will not work.

Optionally run `eklavya doctor`, which reports the same thing plus the runtime, the SQLite driver, the plugin's registration, the chat skill, the database and the effective config. It exits non-zero and names the repair — `eklavya install` — if any of those has broken. That is also the command to reach for later, whenever Eklavya has gone quiet: the hooks never fail loudly, so a broken install looks exactly like a quiet one.

**2. Confirm the database.** Call `get_config` and report `global_path`. If that same call reports `surface: "cowork"`, stop there — `global_path` came back, so the server is running and the database is behind it; that is the confirmation. **Do not run the shell check below in Cowork.** It runs in a sandbox VM with its own filesystem, finds no `~/.eklavya/knowledge.db`, and would have you report a broken install on a healthy one.

Everywhere else, check the DB:

```bash
sqlite3 ~/.eklavya/knowledge.db 'select domain, count(*) from concepts group by domain'
```

The server creates and seeds it on first start, and `npx eklavya install` creates it up front, so this should already show `web-auth`, `react`, `node-backend` and `git`. If the file is missing, the MCP server is not running — check `/plugin` for errors, and check that the runtime is installed (`npx eklavya install` finishes it in one step).

**3. Decide how hard it pushes.** Ask which fits, and explain in one line each:

- **questions, unenforced** (default) — asked after tasks, always skippable
- **enforced** — the session quiz must pass before a commit goes through; for interns and onboarding
- **no questions** — `quiz.enabled: false`. Say in the same breath that this stops the questions only: memory keeps recording, and `memory.enabled` is the separate switch for that. People choose this one meaning "off" and are surprised either way if nobody tells them which half stopped.

Then `set_config` with their choice — `quiz: { enforced: true }` for the gate, `quiz: { enabled: false }` for silence. Use `scope: "project"` if they want it to apply to this codebase only — that writes `~/.eklavya/projects/<checkout>/config.json`, in their own home directory. Nothing is written into the repository, so the setting is theirs and not their team's. Otherwise global.

**3b. Choose a focus.** One more question, because it changes every quiz. The setting above is how hard Eklavya pushes; focus is what it teaches.

- **concept** (default) — asks the transferable version of the same ideas. Best when learning a stack.
- **project** — asks about the code just written. Best when learning a codebase.
- **learn** — you name a topic and it teaches that, using your real code as the example where the work touches it.

`set_config` with `focus`, plus `focus_topic` if they chose `learn` — that combination is useless without one. If they have no preference, say concept is the default and move on; this should not become an interview. `/eklavya:mode` changes it later.

**4. If they chose enforced, install the git hook.** Skip this entire step when `get_config` reports `surface: "cowork"` — Cowork does not commit, so there is nothing to gate and no repo to install into. Say once that enforcement will ask its questions but block nothing here, and move on; everything else in this setup applies unchanged. Trust that field rather than checking the environment yourself: a shell command in Cowork runs inside a sandbox VM and cannot see the variable this is read from.

The `PreToolUse` hook only covers commits made inside Claude Code — which includes the Code tab in Claude Desktop, the same engine on the same config. The git `pre-commit` hook covers every other path — a bare terminal, VS Code, Cursor:

```bash
"${CLAUDE_PLUGIN_ROOT}"/scripts/install-git-hook.sh
```

It chains to any existing `pre-commit` hook rather than replacing it, and only acts on projects whose config sets `quiz.enforced` (or the retired `"mode": "enforced"`) — so installing it is safe even if they turn enforcement off later. Mention `--uninstall` restores the previous hook.

Skip this step unless they chose enforced.

**4b. Say what memory does, in two sentences, and do not ask a question about it.**

Eklavya also records what each session did — the prompts, the edits, the tool
failures — and hands the relevant part back at the start of the next one, so
next week's session starts knowing what last week's did. It is on by default,
it is local (the summariser and the search index both run on this machine, no
key and no account), and it is a separate switch from the one they just
chose: `quiz.enabled: false` stops the questions and keeps the history.

Say that and move on. It needs no decision now, and turning it into a fifth
question makes setup an interview. If they ask where it goes or what is
excluded, point at `/eklavya:memory` and the [memory page](https://eklavya.dev/docs/memory/)
rather than reciting the exclusion list.

**5. Say what happens next.** With questions on: build something, and they will follow. Point at `/eklavya:progress` and `/eklavya:quiz`. With the gate on, add that commits are held until the session quiz passes, and `/eklavya:gate` shows what is outstanding. With questions off, say that memory is still recording and `/eklavya:memory` is where to look at it.
