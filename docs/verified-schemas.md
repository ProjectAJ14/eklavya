# Verified Claude Code schemas

Fetched **2026-08-26**, PostToolUse section re-verified **2026-08-27**, from the official docs, per PRD §6. Re-verify before changing any plugin/hook/MCP config — these schemas drift.

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

What we actually ship (a launcher script, so a marketplace install can fall back
to `npx eklavya-mcp` when `dist/` is absent):

```json
{
  "mcpServers": {
    "eklavya": {
      "command": "${CLAUDE_PLUGIN_ROOT}/mcp/bin/eklavya-mcp.sh",
      "env": { "EKLAVYA_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}" }
    }
  }
}
```

- Plugin MCP servers start automatically when the plugin is enabled.
- `${CLAUDE_PLUGIN_ROOT}` is substituted directly for plugin-provided configs (no `:-` default needed, unlike project-scoped `.mcp.json`).
- `CLAUDE_PLUGIN_ROOT` is also exported into the server subprocess's environment.
- Optional per-server `"timeout"` in **milliseconds**.
- **`command` must not be quoted.** See deviation D4 — this shipped broken once.

### Tool names are namespaced by plugin

A plugin's MCP tools resolve as **`mcp__plugin_<plugin-name>_<server-name>__<tool>`**,
so Eklavya's `get_learner_profile` is `mcp__plugin_eklavya_eklavya__get_learner_profile`.
Hook `matcher`/`if` fields and agent `tools:` allowlists take the scoped name;
one written against the bare server key never fires.

The bare form `mcp__eklavya__<tool>` is still correct when the server comes from a
**project-level** `.mcp.json` — which is how this repo runs it during development
and how a Cursor user wires it up. `agents/tutor.md` therefore lists both, and
whichever install it lands in, one set resolves.

This is also why the `PostToolUse` matcher is the regex `mcp__.*log_session_concepts`
rather than either literal name: the checkpoint hook has to fire whether Eklavya
was installed as a plugin or wired up through a project-level `.mcp.json`. A
matcher containing anything outside `[A-Za-z0-9_\- ,|]` is treated as an
unanchored regex, so the `.` and `*` are what select that behaviour.

## 3. Hooks — `hooks/hooks.json` at plugin root

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/hooks/session-start.sh" }] }
    ],
    "PostToolUse": [
      {
        "matcher": "mcp__.*log_session_concepts",
        "hooks": [{ "type": "command", "command": "\"${CLAUDE_PLUGIN_ROOT}\"/hooks/checkpoint-quiz.sh" }]
      }
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
- `PostToolUse`: `tool_name`, `tool_input`, `tool_use_id`, `tool_output`
- `Stop`: `stop_reason`, `last_assistant_message`
- `SessionStart`: `session_start_reason` (`startup|resume|clear|compact|fork`), `model`

`agent_id` / `agent_type` are present **only inside a subagent**, which is how
`checkpoint-quiz.sh` knows not to ask a question nobody is watching: a subagent
has no `AskUserQuestion`.

### PostToolUse output (verified 2026-08-27)

Fires after a tool call **succeeds**, and cannot block — the tool already ran.
What it can do is put text in front of the model mid-turn, which is the whole
mechanism behind interleaved quizzing.

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "seen by the model, mid-turn",
    "systemMessage": "shown in the transcript to the user and the model"
  }
}
```

Exit 2 also surfaces stderr to the model here, but as a *warning* — an error face
on a working feature. `checkpoint-quiz.sh` therefore uses exit 0 + JSON, unlike
the Stop hook, which has something to actually prevent (deviation D1).

### Events not in the older snapshot

The event list has grown since this file was first written. Ones worth knowing
about, none of which Eklavya uses yet:

`Setup`, `UserPromptExpansion`, `PermissionRequest`, `PermissionDenied`,
`PostToolUseFailure`, `PostToolBatch` (once per resolved batch of parallel calls
— a cheaper seam than `PostToolUse` if checkpointing ever needs one),
`StopFailure`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`,
`TeammateIdle`, `MessageDisplay`, `InstructionsLoaded`, `ConfigChange`,
`CwdChanged`, `DirectoryAdded`, `FileChanged`, `WorktreeCreate`,
`WorktreeRemove`, `PostCompact`, `Elicitation`, `ElicitationResult`.

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

## Unverified — the ask footer's newline (2026-08-27)

Phase 9 prints a dial readout as the last line of an `AskUserQuestion` stem,
separated by a blank line:

```
Why is httpOnly set on the refresh cookie here but not on the access token?

concept · easy · tier 2
```

**Not yet observed in a real render.** Whether Claude Code preserves the newline
inside a question stem, collapses it to a space, or trims it is unconfirmed, and
the tool schema does not say. Nothing breaks either way — the footer still reads
as a trailing clause if the break is lost — but the shape of
`stripAskFooter`'s regex (`ask.ts`) depends on it: it anchors to a trailing
**line**, so a collapsed newline would leave the footer inside the fingerprinted
stem.

Check this the first time a question lands in a live session, then pin the answer
here. If newlines are collapsed, the footer becomes ` — concept · easy · tier 2`
and the regex loses its `\n` anchor.

## Deviations from the PRD

These override the PRD where they conflict. The PRD text was written against an older schema.

### D1 — Stop hook blocks via exit 2 + stderr, not `{"decision":"block"}`
PRD §9.2 specifies `{"decision": "block", "reason": "..."}` on stdout. The current hooks reference documents no Stop-specific JSON output shape; what it *does* document unambiguously is that **exit 2 prevents stopping and continues the conversation, using stderr as the blocking message**.

**Decision:** `stop-quiz-check.sh` writes the tutor instruction to **stderr and exits 2**. This is schema-stable and needs no guessing at a JSON envelope. Revisit if a documented Stop JSON shape reappears.

### D2 — `stop_hook_active` is not documented; the loop guard must be entirely ours
PRD §9.2 and the phase-2 plan lean on `stop_hook_active` to avoid re-blocking. That field is absent from the current stdin field list.

**Decision:** the loop guard is a **DB-side marker keyed by session** (PRD §9.2 already requires one as the primary mechanism). It must be correct with zero help from the harness. If `stop_hook_active` is present at runtime we honor it as a belt-and-braces extra check, but nothing depends on it.

This raises, not lowers, the severity of the P0 Stop-loop risk (PRD §15). Test the guard first.

### D4 — `.mcp.json` `command` is spawned directly, so it must not be quoted
`hooks.json` commands run through `sh -c` in shell form, which is why
`"\"${CLAUDE_PLUGIN_ROOT}\"/hooks/x.sh"` is right there. An MCP server's
`command` is **not** — it is exec'd, so the quote characters become part of the
path and the server silently never starts. Every MCP tool then goes missing while
the plugin still reports as loaded.

**Decision:** `"command": "${CLAUDE_PLUGIN_ROOT}/mcp/bin/eklavya-mcp.sh"`, no
quotes. Neither the test suite nor plugin validation caught this class of error
until a fresh install was simulated; `test/packaging.test.ts` now guards it.

### D3 — `hooks.timeout` is in seconds, MCP server `timeout` is in milliseconds
Easy to get backwards. Noted so nobody "fixes" one to match the other.
