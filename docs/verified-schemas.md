# Verified Claude Code schemas

Fetched **2026-08-26**, PostToolUse section re-verified **2026-08-27**, from the official docs. Re-verify before changing any plugin/hook/MCP config — these schemas drift.

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

What we actually ship (a Node launcher, so it works on Windows and can fall back
to `npx eklavya` when no runtime is installed yet):

```json
{
  "mcpServers": {
    "eklavya": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "server"]
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
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "session-start"],
            "timeout": 10,
            "statusMessage": "Eklavya: loading learner profile"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "prompt-submit-nudge"],
            "timeout": 10
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "subagent-start"],
            "timeout": 10
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "pre-tool-gate"],
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "mcp__.*log_session_concepts",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "checkpoint-quiz"],
            "timeout": 10,
            "statusMessage": "Eklavya: checking if it is time to ask"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "stop-quiz-check"],
            "timeout": 15,
            "statusMessage": "Eklavya: checking what you learned"
          }
        ]
      }
    ]
  }
}
```

Six events, one command. Every hook is exec form — `"command": "node"` plus
`args` — and every one of them dispatches through the same `hooks/run.mjs`, which
resolves a runtime and imports `dist/hooks/<name>.js`. The logic lives in
`mcp/src/hooks/*.ts`; there are no `.sh` files under `hooks/` any more, and the
only place the shell names still appear is `mcp/src/hooks/lib.ts`, which names
`hooks/lib.sh` deliberately, as the thing it replaced.

**Superseded:** this block used to show shell form —
`"command": "\"${CLAUDE_PLUGIN_ROOT}\"/hooks/session-start.sh"` — with a note that
`${CLAUDE_PLUGIN_ROOT}` must be quoted because plugin paths can contain spaces.
That was correct for shell form and is now moot: exec form passes `args` to the
process directly, so there is no shell to quote for. See the Update under D4 for
why the shell form had to go.

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
- `UserPromptSubmit`: `prompt` (the text the developer just submitted; Eklavya does not read it)

- `SubagentStart`: `agent_type` — the agent's name, bare when it is a user-level
  agent and `<plugin>:<name>` through `/plugin`. Contract rather than
  observation: the evidence is ponytail's `hooks/ponytail-subagent.js` reading
  `JSON.parse(input).agent_type`, and ponytail does not treat its presence as
  guaranteed either — it fails open when the field is missing, and so does
  `subagent-start.ts`.

`agent_id` / `agent_type` are present **only inside a subagent**, which is how
`checkpoint-quiz` knows not to ask a question nobody is watching: a subagent
has no `AskUserQuestion`. (`checkpoint-quiz.ts` reads `agent_id` and returns
immediately when it is set; `agent_type` is read by `subagent-start.ts`, which
uses it to stay silent for `eklavya-tutor`.)

### SubagentStart output (contract, not yet observed)

Unlike `SessionStart`, raw stdout is **not** accepted as context here — the
`hookSpecificOutput` form is required and anything else is dropped without an
error:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SubagentStart",
    "additionalContext": "..."
  }
}
```

Taken from ponytail's `hooks/ponytail-runtime.js`, which branches on exactly
this (*"SessionStart accepts raw stdout, but SubagentStart needs the
hookSpecificOutput JSON form or the context is dropped"*). Like the
`UserPromptSubmit` shape above, this is the contract Eklavya builds to rather
than something re-verified against a live terminal here.

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
on a working feature. `checkpoint-quiz` therefore uses exit 0 + JSON, unlike
the Stop hook, which has something to actually prevent (deviation D1).

### UserPromptSubmit output (in use since 1.15)

Fires before the model sees the developer's message, and can put text in front of
it — the seam `prompt-submit-nudge` uses to restate the log directive in a
session that has gone quiet.

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "seen by the model, before it reads the prompt"
  }
}
```

Eklavya uses the explicit JSON form rather than relying on plain stdout. Plain
text is documented to work on `SessionStart`, and the exit-code table below says
stdout not starting with `{` is treated as text on any event — but the JSON form
names the event, and a hook that runs on *every* prompt is the wrong place to
depend on the looser reading. This shape is the one Eklavya emits; it has not
been re-verified against a live terminal the way the `AskUserQuestion` rendering
below was, so treat it as the contract we build to rather than an observation.

### Events not in the older snapshot

The event list has grown since this file was first written. `SubagentStart` came
off it when `subagent-start.ts` started using it — see `docs/subagent-policy.md`.
The rest are worth knowing about and Eklavya uses none of them yet:

`Setup`, `UserPromptExpansion`, `PermissionRequest`, `PermissionDenied`,
`PostToolUseFailure`, `PostToolBatch` (once per resolved batch of parallel calls
— a cheaper seam than `PostToolUse` if checkpointing ever needs one),
`StopFailure`, `SubagentStop`, `TaskCreated`, `TaskCompleted`,
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

## Verified — how `AskUserQuestion` renders a stem (2026-09-05)

Observed in a live terminal session, with three copies of the same line in one
stem:

```
[ambient · concept · easy · tier 2 mechanism]
`[ambient · concept · easy · tier 2 mechanism]`
*[ambient · concept · easy · tier 2 mechanism]*
```

- **Newlines are preserved.** Blank lines survive as blank lines, so a settings
  line on its own row stays on its own row. `stripAskHeader`'s regex (`ask.ts`)
  anchors to a `\n`, and that anchor holds.
- **Markdown is not parsed.** All three rendered identically; the backticks and
  the asterisks appeared as literal characters. There is no code span, no
  emphasis, no dim.
- **The whole `question` field is drawn in one bold weight** — the same weight as
  the stem. Nothing in the string can change colour or weight.

That is why the settings line moved above the stem and gained brackets in 1.9:
position and bracket were the only two signals available to separate a readout
from prose. Raw ANSI was not tried and should not be — it would have to survive
the JSON hop through the MCP response, and it means nothing to a non-terminal
renderer.

**In 1.14 the line left the question entirely.** The findings above are the
reason: a field with no dim, no weight and no colour is a poor place to put a
readout, and the readout in question was ambient session state rather than part
of any one question. The dials now come from `eklavya statusline`
(`mcp/src/statusline.ts`), which the host renders in its own status bar — where
ANSI *does* work, so `enforced` can be amber. `stripAskHeader` stays in
`ask.ts` for the rows recorded while the line existed; their stems still contain
it and `questionFingerprint` hashes that text.

## Deviations from the original design

Each of these overrides what Eklavya was first designed against, because the
schema moved after the design was written.

### D1 — Stop hook blocks via exit 2 + stderr, not `{"decision":"block"}`
The original design specified `{"decision": "block", "reason": "..."}` on stdout. The current hooks reference documents no Stop-specific JSON output shape; what it *does* document unambiguously is that **exit 2 prevents stopping and continues the conversation, using stderr as the blocking message**.

**Decision:** `stop-quiz-check` writes the tutor instruction to **stderr and exits 2**. This is schema-stable and needs no guessing at a JSON envelope. Revisit if a documented Stop JSON shape reappears.

### D2 — `stop_hook_active` is not documented; the loop guard must be entirely ours
The original design leaned on `stop_hook_active` to avoid re-blocking. That field is absent from the current stdin field list.

**Decision:** the loop guard is a **DB-side marker keyed by session**, which was always the primary mechanism. It must be correct with zero help from the harness. If `stop_hook_active` is present at runtime we honor it as a belt-and-braces extra check, but nothing depends on it.

This raises, not lowers, the severity of the Stop-loop risk. Test the guard first.

### D4 — `.mcp.json` `command` is spawned directly, so it must not be quoted
`hooks.json` commands run through `sh -c` in shell form, which is why
`"\"${CLAUDE_PLUGIN_ROOT}\"/hooks/x.sh"` was right there when this was written.
An MCP server's
`command` is **not** — it is exec'd, so the quote characters become part of the
path and the server silently never starts. Every MCP tool then goes missing while
the plugin still reports as loaded.

**Decision:** `"command": "node"` with the script path in `args`, no quotes.
Neither the test suite nor plugin validation caught this class of error until a
fresh install was simulated; `test/packaging.test.ts` now guards it.

**Update (the Node port):** the same reasoning now applies to `hooks.json` as
well, and more forcefully. Shell form on Windows resolves to Git Bash,
PowerShell, or WSL's bash depending on what is installed, and a `.sh` hook fails
differently in each (claude-code#18610, #21847, #23556, #73971). Every hook is
therefore exec form — `"command": "node"`, `"args": [".../run.mjs", "<name>"]` —
which the hooks reference names as the one portable shape, because `node.exe` is
a real executable and exec form needs no shell at all. There is exactly ONE
`.mcp.json`, and it uses `${CLAUDE_PLUGIN_ROOT}`. An earlier attempt kept a
repo-relative path for project scope and rewrote it for the npm payload, which
shipped the relative one to every marketplace install -- the marketplace clones
this repository and serves it as the plugin, so the repo file IS what users
get. A bare `hooks/run.mjs` resolves against the process cwd, which for a
plugin-scoped MCP server is the user's project, so the server died with
"Cannot find module". Contributors who want the server while working in this
repo should use `claude --plugin-dir "$(pwd)"`, which sets the variable.

### D3 — `hooks.timeout` is in seconds, MCP server `timeout` is in milliseconds
Easy to get backwards. Noted so nobody "fixes" one to match the other.
