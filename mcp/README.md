# eklavya-mcp

The MCP server behind [Eklavya](../README.md): a local knowledge graph, SM-2 spaced repetition, and commit-gate state for agent-assisted learning.

Runs standalone, so any MCP client can use it — this is what makes Eklavya editor-agnostic.

```json
{
  "mcpServers": {
    "eklavya": { "command": "npx", "args": ["-y", "eklavya-mcp"] }
  }
}
```

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
eklavya doctor                      # check the install
eklavya config get
eklavya config set mode enforced [--repo]     # how hard it pushes
eklavya config set focus concept              # what it teaches
eklavya config set focus learn --topic caching
eklavya export-rules --out rules.md              # the tutor pedagogy as Markdown
eklavya db-path
```

MIT.
