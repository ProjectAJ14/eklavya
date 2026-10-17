---
name: setup
description: Check the Eklavya installation and database without changing your settings.
disable-model-invocation: true
---

# /eklavya:setup

Check that Eklavya works on this machine. Keep this to one short exchange.
Do not ask the developer to choose settings or reset their saved choices.
The installer supplies defaults. Change a setting only when the developer
explicitly asks for that change.

## Check Node and the server

Run `node --version`. Node.js must be 22 or newer. If it is missing or older,
say how to install it on this platform and stop. The recommended npm install
also needs npm, which the Node.js installer includes.

Call `get_config` and report whether the server replied. This call returns
`global_path` and the effective configuration. Read that configuration before
saying whether questions or memory are on; do not assume defaults describe an
existing installation.

If the call fails, check `/plugin` for errors. From a terminal, the command
`npm install -g eklavya && eklavya install` repairs or finishes the install.
Then restart Claude Code. `eklavya doctor` can identify a broken runtime,
database driver or plugin registration.

## Check the database

If `get_config` reports `surface: "cowork"`, its successful reply confirms the
server and database. Do not check `~/.eklavya/knowledge.db` from Cowork's shell:
that shell runs in a separate VM and cannot see the user's local database.

Elsewhere, if `sqlite3` is available, run:

```bash
sqlite3 ~/.eklavya/knowledge.db 'select domain, count(*) from concepts group by domain'
```

The starter domains are `web-auth`, `react`, `node-backend` and `git`. The
installer creates and seeds this database. If `sqlite3` is missing, use
`eklavya doctor` instead; it is optional for ordinary questions and memory.
Do not tell the developer to install extra tools for this check.

## Say what happens next

With questions on, ask the developer to start a task. Point to
`/eklavya:progress` for learning history and `/eklavya:quiz` for a question now.
If questions are off, keep them off. When memory is on, mention
`/eklavya:memory` for past work.

For a new install, memory summaries and prompt feedback use `claude-sonnet-5`
through the developer's Claude Code login. Captured session evidence goes to
that model; search and stored history stay local. Existing settings may use a
different model or local summaries. If they ask about capture or privacy, link
[Memory](https://eklavya-run.web.app/docs/memory/).

The quiz side panel is on by default on supported Claude Code builds. If auto
mode blocks it, link
[the ten auto-mode permissions](https://eklavya-run.web.app/docs/installing/).
Do not grant permissions or change settings as part of this check.

If the developer asks to enable commit enforcement, follow
[the commit gate guide](https://eklavya-run.web.app/docs/commit-gate/).
The terminal Git hook also needs `jq`, `sqlite3` and project-level enforcement.
Do not offer or install it during an ordinary setup check.
