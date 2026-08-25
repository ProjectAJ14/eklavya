# Verified Claude Code schemas

Fetched **2026-08-26** from the official docs, per PRD §6. Re-verify before changing any plugin/hook/MCP config — these schemas drift.

Sources:
- https://code.claude.com/docs/en/plugins
- https://code.claude.com/docs/en/plugins-reference
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp

---

## 1. Plugin manifest — `.claude-plugin/plugin.json`

Only `name` is required. Relevant fields:

```json
{
  "name": "eklavya",
  "displayName": "Eklavya",
  "version": "0.1.0",
  "description": "...",
  "author": { "name": "...", "email": "...", "url": "..." },
  "homepage": "...",
  "repository": "...",
  "license": "MIT",
  "keywords": ["..."]
}
```

**Layout rule (documented common mistake):** only `plugin.json` goes inside `.claude-plugin/`. `commands/`, `skills/`, `agents/`, `hooks/`, `.mcp.json` all live at the **plugin root**.

Component paths can be overridden in the manifest (`"hooks": "./config/hooks.json"`, `"mcpServers": "./mcp-config.json"`), but the default locations are what we use.

## 2. MCP registration — `.mcp.json` at plugin root

```json
{
  "mcpServers": {
    "eklavya": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/mcp/dist/server.js"],
      "env": { "EKLAVYA_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}" }
    }
  }
}
```

- Plugin MCP servers start automatically when the plugin is enabled.
- `${CLAUDE_PLUGIN_ROOT}` is substituted directly for plugin-provided configs (no `:-` default needed, unlike project-scoped `.mcp.json`).
- `CLAUDE_PLUGIN_ROOT` is also exported into the server subprocess's environment.
- Optional per-server `"timeout"` in **milliseconds**.

## 3. Hooks — `hooks/hooks.json` at plugin root

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/hooks/session-start.sh" }] }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/hooks/pre-tool-gate.sh" }]
      }
    ]
  }
}
```

Note the quoting of `${CLAUDE_PLUGIN_ROOT}` in shell form — plugin paths can contain spaces.

### Matcher syntax
| Format | Evaluation |
|---|---|
| `"*"`, `""`, omitted | match all |
| letters, digits, `_`, `-`, spaces, `,`, `\|` | exact string or `\|` list, e.g. `Bash`, `Edit\|Write` |
| anything else | unanchored JavaScript regex |

### Handler fields
`type` (`command` \| `http` \| `mcp_tool` \| `prompt` \| `agent`), `command`, `args`, `timeout` (seconds), `if` (e.g. `"Bash(git *)"`), `statusMessage`, `once`, `async`, `shell`.

With `args` → exec form (no shell). Without `args` → shell form (`sh -c`).

### Stdin JSON (command hooks)
Common: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `effort`, `agent_id`, `agent_type`.

- `PreToolUse`: `tool_name`, `tool_input` (`.tool_input.command` for Bash), `tool_use_id`
- `Stop`: `stop_reason`, `last_assistant_message`
- `SessionStart`: `session_start_reason` (`startup|resume|clear|compact|fork`), `model`

### Exit codes
| Code | Meaning |
|---|---|
| `0` | success; stdout parsed as JSON if it starts with `{`, else treated as plain text |
| `2` | blocking error; block message comes from the JSON decision or from **stderr** |
| other | non-blocking |

### PreToolUse deny (preferred: exit 0 + JSON)
```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "..."
  }
}
```

### SessionStart context injection
Plain-text stdout is added to Claude's context. (`systemMessage` is also available for transcript messages.)

---

## Deviations from the PRD

These override the PRD where they conflict. The PRD text was written against an older schema.

### D1 — Stop hook blocks via exit 2 + stderr, not `{"decision":"block"}`
PRD §9.2 specifies `{"decision": "block", "reason": "..."}` on stdout. The current hooks reference documents no Stop-specific JSON output shape; what it *does* document unambiguously is that **exit 2 prevents stopping and continues the conversation, using stderr as the blocking message**.

**Decision:** `stop-quiz-check.sh` writes the tutor instruction to **stderr and exits 2**. This is schema-stable and needs no guessing at a JSON envelope. Revisit if a documented Stop JSON shape reappears.

### D2 — `stop_hook_active` is not documented; the loop guard must be entirely ours
PRD §9.2 and the phase-2 plan lean on `stop_hook_active` to avoid re-blocking. That field is absent from the current stdin field list.

**Decision:** the loop guard is a **DB-side marker keyed by session** (PRD §9.2 already requires one as the primary mechanism). It must be correct with zero help from the harness. If `stop_hook_active` is present at runtime we honor it as a belt-and-braces extra check, but nothing depends on it.

This raises, not lowers, the severity of the P0 Stop-loop risk (PRD §15). Test the guard first.

### D3 — `hooks.timeout` is in seconds, MCP server `timeout` is in milliseconds
Easy to get backwards. Noted so nobody "fixes" one to match the other.
