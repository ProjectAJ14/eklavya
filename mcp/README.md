# Eklavya

[Eklavya](https://github.com/ProjectAJ14/eklavya) teaches the concepts behind
agent-written code and keeps local project memory. This package includes the
Claude Code plugin, installer, CLI and MCP server.

## Install in Claude Code

With Node 22 or newer:

```bash
npx eklavya install
```

Follow the settings prompts, then restart Claude Code. The installer registers
the plugin, installs the managed runtime and chat/artifact skills, and prepares
local storage. `/eklavya:setup` lets you revisit settings.

Read the [installation guide](https://eklavya-run.web.app/docs/installing/) for
verification and [updates and removal](https://eklavya-run.web.app/docs/updates/)
for maintenance. Uninstall preserves learner data unless you explicitly use
`--purge`.

## Standalone MCP connection

An MCP client can connect directly:

```json
{
  "mcpServers": {
    "eklavya": { "command": "npx", "args": ["-y", "eklavya", "serve"] }
  }
}
```

This exposes tools. Automatic capture, checkpoints and session instructions
depend on host integration; an MCP connection alone does not provide Claude
Code's learning loop.

## Available tools

| Purpose | Tools |
|---|---|
| Learner state and concepts | `get_learner_profile`, `log_session_concepts`, `upsert_concepts`, `get_concept_graph` |
| Questions and assessment | `get_session_quiz_plan`, `record_attempt`, `get_gate_status` |
| Settings | `get_config`, `set_config` |
| Find and read memory | `memory_search`, `memory_get`, `memory_timeline`, `memory_file_history`, `memory_status` |
| Maintain memory | `memory_write`, `memory_correct`, `memory_delete`, `memory_collections` |
| Inspect code | `code_outline`, `code_find_symbol` |

Search first, choose relevant entries, then use `memory_get` for their full
content. Session-aware learning and configuration tools resolve the current session
when `session_id` is omitted. In `memory_timeline`, it instead filters results
to one session; omission shows the project timeline. Other tools may not accept
that argument.

## CLI and data

```bash
npx eklavya doctor
npx eklavya memory status
npx eklavya config get
npx eklavya dashboard
npx eklavya db-path
```

The [CLI reference](https://eklavya-run.web.app/docs/cli/) lists all commands and
flags. [Configuration](https://eklavya-run.web.app/docs/configuration/) lists
defaults and scopes. The [memory guide](https://eklavya-run.web.app/docs/memory/)
covers retrieval, processing, providers, privacy and sync.

State is local under `~/.eklavya/`, including `knowledge.db` (SQLite, WAL).
`EKLAVYA_HOME` and `EKLAVYA_DB` override those paths. Questions and memory have
independent switches. External processing is optional and explicitly configured;
see [your data](https://eklavya-run.web.app/docs/your-data/).

MIT.
