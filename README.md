# Eklavya

**Learn while your agent works.**

Eklavya is a Claude Code plugin that turns agent generation time into learning time. While a coding agent implements a task, Eklavya teaches you the concepts behind that exact work — adaptive Socratic questions grounded in the code just written, mastery tracked in a local knowledge graph, and optionally a commit gate until you can show you understood it.

> Named for Ekalavya, who mastered archery practicing before a silent statue of his guru. Here, the statue talks back.

**Status: Phase 0 (scaffold) complete.** The MCP tool surface is registered but the tool logic lands in Phase 1. See [`prd/README.md`](prd/README.md) for the delivery tracker and [`prd/PRD.md`](prd/PRD.md) for the full spec.

## Prerequisites

| Requirement | Why |
|---|---|
| Node 18+ | MCP server; `better-sqlite3` builds a native binding |
| `sqlite3` on `PATH` | hook scripts read the knowledge DB directly, without an MCP round trip |
| `jq` on `PATH` | hook scripts parse the hook input JSON |
| Claude Code | plugin host |

## Local development

```bash
cd mcp
npm install     # approve the better-sqlite3 install script if npm asks
npm test        # builds, then runs unit + stdio integration tests
```

Load the plugin without installing it:

```bash
claude --plugin-dir /path/to/eklavya
```

## Where your data lives

Everything is local and yours: `~/.eklavya/knowledge.db` (SQLite, WAL mode) plus `~/.eklavya/config.json`. No accounts, no sync, no telemetry. Delete the directory and Eklavya forgets you completely.

Point `EKLAVYA_DB` or `EKLAVYA_HOME` somewhere else to experiment without touching your real history.

```bash
sqlite3 ~/.eklavya/knowledge.db '.tables'
sqlite3 ~/.eklavya/knowledge.db 'select domain, count(*) from concepts group by domain'
```

## Layout

```
.claude-plugin/plugin.json   plugin manifest
.mcp.json                    registers the eklavya MCP server
commands/                    /eklavya:quiz, :learn, :progress, :setup, :gate   (Phase 1)
skills/tutor/                the pedagogy                                       (Phase 1)
hooks/                       SessionStart, Stop, PreToolUse(Bash)               (Phase 2-3)
cli/, scripts/               git pre-commit gate, editor-agnostic               (Phase 3)
mcp/                         MCP server: knowledge graph, SM-2, gates
docs/verified-schemas.md     plugin/hook/MCP schemas as verified against the docs
prd/                         spec and per-phase delivery tracker
```

## Official docs this plugin is built against

Re-verify before changing plugin, hook, or MCP config — these schemas drift. Findings are pinned with a date in [`docs/verified-schemas.md`](docs/verified-schemas.md).

- https://code.claude.com/docs/en/plugins
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp

## License

MIT
