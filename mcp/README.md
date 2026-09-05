# eklavya

[Eklavya](https://github.com/ProjectAJ14/eklavya) — learn while your agent works. This package is
the whole thing: the installer, the MCP server, the CLI, and the Claude Code plugin it installs.

## Install

```bash
npx eklavya install
```

That checks your Node version, installs the runtime and its SQLite driver, registers the plugin
with Claude Code and enables it, and creates the database. Restart Claude Code afterwards, then
run `/eklavya:setup` to pick a mode. Re-running it is how you upgrade; `npx eklavya uninstall`
removes it and keeps your history unless you pass `--purge`.

Requires **Node 22+** — below that the SQLite driver has no prebuilt binary and would need a C++
toolchain to compile.

## As a standalone MCP server

The server runs on its own, so any MCP client can use it — this is what makes Eklavya
editor-agnostic.

```json
{
  "mcpServers": {
    "eklavya": { "command": "npx", "args": ["-y", "eklavya", "serve"] }
  }
}
```

> Renamed from `eklavya-mcp` after 1.7.0, and the separate `eklavya-mcp` binary folded into
> `eklavya serve` at the same time — one package, one command. The old package still exists on
> npm so older installs keep resolving, but it is no longer updated.

State lives in `~/.eklavya/knowledge.db` (SQLite, WAL). Override with `EKLAVYA_HOME` or `EKLAVYA_DB`.

## Tools

| Tool | Purpose |
|---|---|
| `get_learner_profile` | what the developer already knows; call before teaching |
| `log_session_concepts` | record what the current task exercises, with code context |
| `get_session_quiz_plan` | what to ask, and at which difficulty tier |
| `record_attempt` | grade 0–5, update mastery and the review schedule |
| `get_gate_status` | whether this session's quiz gate has passed |
| `upsert_concepts` | grow the graph, with slug normalization and dedupe |
| `get_concept_graph` | a domain in prerequisite order |
| `get_config` / `set_config` | global and per-repo settings |

`session_id` is optional on every tool — the server resolves the current session itself.

## CLI

```bash
eklavya install                     # install into Claude Code, runtime included
eklavya uninstall [--purge]         # remove it; --purge also deletes your history
eklavya doctor                      # check the install
eklavya config get
eklavya config set mode enforced [--repo]     # how hard it pushes
eklavya config set focus concept              # what it teaches
eklavya config set focus learn --topic caching
eklavya export-rules --out rules.md              # the tutor pedagogy as Markdown
eklavya dashboard [--port <n>]                   # your learning history, served locally
eklavya db-path
```

MIT.
