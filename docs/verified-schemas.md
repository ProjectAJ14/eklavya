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

### The tool inventory

Twenty tool definitions live under `mcp/src/tools/`, in two halves. The learning
half is the original nine; the memory half is eleven more, added by the memory
program.

| Tool | Half | Defined in |
|---|---|---|
| `get_learner_profile` | learning | `get_learner_profile.ts` |
| `log_session_concepts` | learning | `log_session_concepts.ts` |
| `get_session_quiz_plan` | learning | `get_session_quiz_plan.ts` |
| `record_attempt` | learning | `record_attempt.ts` |
| `get_gate_status` | learning | `get_gate_status.ts` |
| `upsert_concepts` | learning | `upsert_concepts.ts` |
| `get_concept_graph` | learning | `get_concept_graph.ts` |
| `get_config`, `set_config` | learning | `config_tools.ts` |
| `memory_search`, `memory_get`, `memory_timeline`, `memory_file_history`, `memory_status` | memory | `memory_read_tools.ts` |
| `memory_write`, `memory_correct`, `memory_delete` | memory | `memory_write_tools.ts` |
| `memory_collections` | memory | `collection_tools.ts` |
| `code_outline`, `code_find_symbol` | memory | `code_tools.ts` |

**Only seventeen of them are registered.** `TOOLS` in `mcp/src/tools/index.ts`
imports `codeOutline`, `codeFindSymbol` and `memoryCollections` but never lists
them in the array, so the server advertises the nine learning tools and the
eight `memory_*` read/write tools and nothing else. The three missing ones are
described in `web/src/content/docs/docs/memory.mdx` and in
`skills/memory/SKILL.md` as though they were available, and
`server.integration.test.ts` compares the advertised names against `TOOLS`
rather than against a fixed list, so it agrees with whatever the array happens
to hold. Adding the three names to the array is the whole fix; until then the
manual is ahead of the server.

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
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "capture-tool"],
            "timeout": 10
          }
        ]
      },
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

Seven hooks over six events, one command. `PostToolUse` carries two of them: an
unmatched `capture-tool`, which records every tool call as memory evidence, and
the matched `checkpoint-quiz`. Registering two handler groups on one event is
how the two jobs keep their own matchers — a single group would force the
capture hook to inherit the checkpoint's regex and capture nothing but Eklavya's
own tool calls.

Every hook is exec form — `"command": "node"` plus
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
- `UserPromptSubmit`: `prompt` (the text the developer just submitted)

Three of those descriptions moved when memory capture landed, and two of them
are places where the field the docs name and the field the payload carries are
not the same word. `HookInput` in `mcp/src/hooks/lib.ts` is the list of what
Eklavya actually reads.

- **`PostToolUse` results arrive as `tool_response`, not `tool_output`.**
  `capture-tool.ts` reads `tool_name`, `tool_input` and `tool_response`; the
  last of these is what tells it whether the call failed (`success: false`, an
  `error` string, or `is_error`), and a failure is the one case where the result
  rather than the arguments is worth storing. `tool_output` is what the
  reference page calls it and nothing in this repo has observed a payload under
  that key, so `lib.ts` declares `tool_response` and leaves `tool_output`
  unread. If a host sends only `tool_output`, every tool call is recorded as a
  success — which is the failure mode `hosts.ts` describes as `toolOutcomes:
  false` rather than something to paper over.
- **`UserPromptSubmit`'s `prompt` is now read.** It used to say "Eklavya does
  not read it". `prompt-submit-nudge.ts` captures it as a `prompt` event
  whenever `memory.enabled`, before its `mode` check, through the same privacy
  filter as everything else. It is the single most useful thing a session
  produces for recall, and it is also the most sensitive, which is why it goes
  through `redact` and the path exclusions on the way in rather than on the way
  out.
- **`SessionStart`'s reason arrives as `source`.** `session-start.ts` reads
  `input.source` and records `startup` when it is absent; it uses it only to
  word the lifecycle event (`session resumed` versus `session started`). The
  docs name the field `session_start_reason`. Both spellings are declared
  nowhere together, so if the payload ever carries only
  `session_start_reason` the lifecycle line degrades to `source=startup` on a
  resume — cosmetic, and deliberately not defended against with a fallback that
  nothing has confirmed is needed.

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
on a working feature. `checkpoint-quiz` therefore uses exit 0 + JSON, and since
2026-09-22 so does the Stop sweep, for the same reason (deviation D1).

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

## Verified — what Claude Desktop does with `header` (2026-09-20)

Observed by comparing one question in a terminal against one in the Claude
Desktop app, from the same plugin build:

- **The terminal paints the `header` chip** above the stem, and appends its own
  `Chat about this` row below the options.
- **Claude Desktop paints no chip.** Its card is a chevron and a close button,
  the stem in bold, numbered option rows with descriptions, an `Other` row with
  a free-text box, and Skip/Submit. There is no slot in that design for a
  header, and `Eklavya` appeared nowhere on screen.
- **Claude Desktop has no status bar**, so the `statusLine` half of the same job
  is missing there too.

`header` is a field every client receives and each one renders as it likes, so
this is not something the plugin can fix by setting it differently. Both places
Eklavya's attribution lived were terminal paint, and a Desktop learner got a
question signed by nobody.

`needsInlineAttribution` (`mcp/src/surface.ts`) is the answer: on a host that
draws a card, the plan's `ask_attribution` asks for `[Eklavya]` on its own line
above the stem instead. It is a separate axis from `Surface` — the Code tab is
still `code` for every pedagogical decision — and `stripAskHeader` takes the
prefix back off before the stem is stored, or the same question would
fingerprint two ways for a learner who works on both.

---

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

### D1 — Stop hook continues the turn with `additionalContext`, not exit 2 and not `{"decision":"block"}` (revised 2026-09-22)
The original design specified `{"decision": "block", "reason": "..."}` on stdout. For several releases this was exit 2 + stderr instead, because the hooks reference then documented no Stop-specific JSON shape. It documents three now, and the difference between them is what the developer sees:

| Form | Effect | How it renders |
|---|---|---|
| exit 2 + stderr | continues the turn | **hook error** — the command line, in red, with the whole instruction under it |
| `{"decision":"block","reason":…}` | continues the turn | hook error, same face |
| `hookSpecificOutput.additionalContext` | continues the turn | `Stop hook feedback`, no error notification |

All three pass through the same loop protections: the `stop_hook_active` input and the harness's cap of 8 consecutive continuations.

**Decision:** `stop-quiz-check` writes the tutor instruction to **`hookSpecificOutput.additionalContext` on stdout and exits 0**. Eklavya asking its question is the feature working, not the session erroring, and a page of model-facing instructions addressed to the developer in red is the opposite of what an ambient tool should look like. Every hook in `mcp/src/hooks/` now exits 0.

**`additionalContext` is not a private channel, and there is no flag that makes it one.** Verified against the 2.1.278 bundle: the `stop_hook_summary` renderer prints every Stop `additionalContext` string to the terminal verbatim, as gold sub-lines under `Ran N stop hooks`, wrapped and effectively untruncated. `suppressOutput` does not reach that path, and the tone is chosen by the harness (`red` on error, `gold` when any additionalContext is present, `dim` otherwise) — a hook cannot ask to be dimmed. The only lever a hook has is **how much it says**.

So the Stop sweep says only what it alone knows — the concepts, the size of the sweep, whether the gate is pressing — in three lines. Everything about *how* to ask (the MCQ shape, `answer_position`, `ask_attribution`, `framing`, `tier_to_ask`, the record format) is returned by `get_session_quiz_plan`, which is the very next call the model makes; repeating it in the hook bought nothing and spent a screen of the developer's terminal on Eklavya reciting its own prompt. The mid-work checkpoint is under no such constraint: `PostToolUse` `additionalContext` is not rendered, and its one-line `systemMessage` is all the developer sees — which is why that hook still spells everything out.

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
