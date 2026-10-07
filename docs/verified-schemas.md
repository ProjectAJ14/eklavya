# Claude Code integration contracts

This reference separates Eklavya's current implementation from dated host
observations. It is not a copy of the complete upstream schema. Re-verify the
affected contract before changing manifests, hook payloads or host support.

Official references: [plugins](https://code.claude.com/docs/en/plugins-reference),
[hooks](https://code.claude.com/docs/en/hooks),
[MCP](https://code.claude.com/docs/en/mcp).

**Documentation check: 2026-09-24.** The current hooks reference documents
`source` for SessionStart, `tool_response` for PostToolUse and `stop_hook_active`
for Stop. Earlier notes here called these absent or differently named; those
notes are superseded. SubagentStart documents `agent_id` and `agent_type`.
Stop `additionalContext` continues the turn without a hook-error notification.
These are upstream-documentation checks, not a new live-session validation.

## Plugin and server registration

The shipped definitions are [plugin.json](../.claude-plugin/plugin.json),
[.mcp.json](../.mcp.json) and [hooks.json](../hooks/hooks.json). Read those files
instead of copying a full manifest into this reference. Components live at the
plugin root; `.claude-plugin/` holds the plugin metadata.

Eklavya starts its MCP server with an executable plus separate arguments:

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

Keep `command` unquoted: quote characters become part of an executable name.
Keep the plugin-root variable in the script argument: the user's project is
not the plugin directory. Contributors use `claude --plugin-dir /path/to/eklavya`
so the host supplies the root. The Node launcher supports local runtime
resolution and package fallback without relying on a platform-specific shell.

Plugin tools use `mcp__plugin_eklavya_eklavya__<tool>`; a standalone registration
uses `mcp__eklavya__<tool>`. Agent allowlists cover both. The checkpoint matcher
`mcp__.*log_session_concepts` deliberately accepts either prefix.

## Tool inventory

[`TOOLS`](../mcp/src/tools/index.ts) registers all 20 tools. Verify this array,
not imports alone, when changing the advertised inventory.

| Group | Tools | Definition files under `mcp/src/tools/` |
|---|---|---|
| Learner and graph | `get_learner_profile`, `log_session_concepts`, `upsert_concepts`, `get_concept_graph` | Named files |
| Assessment | `get_session_quiz_plan`, `record_attempt`, `get_gate_status` | Named files |
| Config | `get_config`, `set_config` | `config_tools.ts` |
| Memory reads | `memory_search`, `memory_get`, `memory_timeline`, `memory_file_history`, `memory_status` | `memory_read_tools.ts` |
| Memory writes | `memory_write`, `memory_correct`, `memory_delete` | `memory_write_tools.ts` |
| Collections and code | `memory_collections`, `code_outline`, `code_find_symbol` | `collection_tools.ts`, `code_tools.ts` |

Session-aware learning and configuration tools accept `session_id` for
resolution. `memory_timeline` uses it as an optional session filter. Inspect each
schema; normally omit resolution IDs so server and hooks use the same checkout
session.

## Hooks used by Eklavya

Nine implementations use six events. PreToolUse has two registrations (`Bash`
for the commit gate, `^Read$` for file history). PostToolUse has four registrations:
capture for all tools, checkpoints on both concept logging and work tools, and the
delegation nudge on work tools plus `Agent`/`Task`.
All launch `node` with `args`. Timeouts are in seconds: 10 for each registration,
15 for Stop. Do not copy timeout units from another integration schema.

| Event | Data used by Eklavya | Result |
|---|---|---|
| SessionStart | Session identity, checkout, `source` | Visible profile plus model recall/directive |
| UserPromptSubmit | Identity, `agent_id` and `prompt` | Capture, recall, logging nudge and, next to a task-sized prompt, the delegation line |
| SubagentStart | `agent_type`, session identity | Implementer logging directive; tutor exempt |
| PreToolUse | `tool_name`, `tool_input.command` or `tool_input.file_path`, `agent_id` | Optional commit denial; before a Read, the file's past work as `additionalContext` |
| PostToolUse | `tool_name`, `tool_input`, `tool_response`, `agent_id`, `duration_ms` (Bash; 2.1.286) | Capture, eligible checkpoint and the delegation nudge |
| Stop | Identity, `agent_id`, optional `stop_hook_active`, `last_assistant_message` (2.1.283; absent on older hosts) | Records the turn's final message as memory evidence, then the memory seam and eligible quiz continuation |

[`HookInput`](../mcp/src/hooks/lib.ts) is the exact list Eklavya reads. An
upstream field existing does not imply the integration uses it. Capture currently
uses PostToolUse, not PostToolUseFailure; do not promise complete failed-tool
coverage on hosts that route failures to a separate event. A failure that does
arrive is `tool_error` evidence and follows the same path exclusions as a read
or edit (`prepare` in `mcp/src/memory/capture.ts`).

## Output and audience

The common envelope keeps visible status and model instructions distinct:

```json
{
  "systemMessage": "Message for the developer",
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Instruction for the model"
  }
}
```

`systemMessage` is top-level. Eklavya uses explicit JSON for SessionStart,
UserPromptSubmit, SubagentStart and checkpoints; it does not use plain stdout
for a visible banner. `mcp/test/hooks.test.ts` checks the audiences separately.

| Hook | Developer sees | Model reads |
|---|---|---|
| Session start | Profile, health/update notices and relevant warnings | Recall and standing directive |
| Prompt / subagent start | No separate Eklavya message | Recall/nudge or directive |
| Checkpoint | Short quick-question status | Question instruction |
| Stop | One line: `Eklavya: one question on csrf before this turn ends -- call get_session_quiz_plan and follow it.` The host renders all Stop `additionalContext` and has no model-only channel | The same line; the rules (verdict, skip, restatement) arrive as the plan's `on_skip` and `on_finish` |
| Commit gate | Host-rendered denial | Denial reason |
| Capture | Nothing | Nothing |

All Eklavya hooks exit 0, including expected quiz continuation and operational
failures. PreToolUse denies with `permissionDecision: "deny"` and
`permissionDecisionReason` inside `hookSpecificOutput`. The Read hook returns
only `hookSpecificOutput.additionalContext`, with no `permissionDecision`: Claude
Code 2.1.283 reads `additionalContext` on PreToolUse independently of any
decision, so context never doubles as an approval. Stop returns
`additionalContext`; exit 2 and `decision: "block"` have historically produced
an error presentation for a working quiz.

## Loop protection and delegation

Eklavya honors `stop_hook_active` when supplied, but its database markers,
pacing, block cap and question budget must prevent loops independently. Current
upstream documentation also describes an eight-continuation host cap; it is not
a substitute for the product's own guard.

`agent_id` suppresses automatic checkpoint and Stop quizzing inside delegates,
the second-file delegation nudge and the prompt-time delegation line. The nudge
reads the parent's own `Agent`/`Task` calls: `tool_input.subagent_type` and
`run_in_background`. Any type other than Explore, Plan, `claude-code-guide`, the
tutor and the explainer counts as handing off the build. That is the only evidence the host
gives at launch time; whether the agent then edits is not known to the hook.
SubagentStart inspects the agent type to exempt the tutor from the implementer's
“do not ask” directive. Missing type fails open by supplying the directive.
See [subagent policy](subagent-policy.md) for capture, replay and host limits.

## Dated rendering observations

These observations explain existing compatibility code. Reproduce them on the
target host before changing the behavior; they are not universal UI guarantees.

| Date / host | Observation | Consequence |
|---|---|---|
| 2026-09-05, terminal | Question newlines survived; Markdown markers rendered literally; the question had one bold weight | Do not rely on Markdown or ANSI inside the stem |
| 2026-09-20, Claude Desktop comparison | Desktop lacked the terminal header chip and status bar | The plan's `ask_attribution` can request inline `[Eklavya]`; skills follow that field |
| 2026-10-01, 2.1.286 CLI | Every Bash PostToolUse carries `duration_ms`. `tool_response.bashEditDiff.changedFiles` lists files a command edited under the session's cwd, and is absent for edits in a sibling worktree (after `cd` or by absolute path), through `git -C`, and outside git | The delegation nudge reads git in the command's own window (`duration_ms`) rather than `bashEditDiff`, which misses the main-checkout-plus-worktree layout |
| 2026-10-01, 2.1.286 CLI | A background `Agent` call reaches PostToolUse at launch with `tool_input.run_in_background: true` and `tool_response.status: "async_launched"`; SubagentStart and the subagent's own PostToolUse calls carry `agent_id` and `agent_type` | The nudge records the delegation at launch and stands down. The host also runs an agent in the background when the model omits `run_in_background`: the launch result says `async_launched` ("Async agent launched"), which is what the nudge and the eval read |
| 2026-10-01, 2.1.286 CLI | Under `--print`, AskUserQuestion is not offered. With `--input-format stream-json` and `--permission-prompt-tool stdio` it is, and arrives as a `can_use_tool` control request; `updatedInput.answers` (question to option label) is what the model receives as the answer | `eval/delegation-harness.mjs` drives sessions this way |
| 2026-09-26, 2.1.283 binary | `last_assistant_message` is a Stop input field | Capture it when present; a host without it records no assistant evidence, as before |
| 2026-09-26, 2.1.283 CLI | The MCP server and hooks both inherit `CLAUDE_CODE_SESSION_ID` (equal to the hook's stdin `session_id`) and `CLAUDE_CODE_MESSAGING_SOCKET` (one per `claude` process). `/clear` in a running process was not probed | Tools resolve the host's session before the checkout pointer; hooks record the current id per socket so a stale startup id is overridden |
| 2026-09-22, 2.1.278 bundle | Stop context appeared in terminal feedback; suppression did not hide that path | Keep the sweep short; the planner supplies detailed pedagogy |
| 2026-09-30, 2.1.285 bundle | `stop_hook_summary` hides the row only when there is no error and no `additionalContext`; each string prints as `Stop hook feedback: ...` | The sweep is one line for the developer; never add model instructions to it |
| 2026-09-23, 2.1.280 bundle | Top-level `systemMessage` produced visible hook messages; SessionStart plain output was model context | Use the common JSON envelope and test both channels |

Settings now live in `eklavya statusline`, not a question header. Keep
`stripAskHeader` for historical stems and host attribution so duplicate-question
fingerprints remain stable.

## Mods (function hooks): quiz side panel spike

Stage 0 of `docs/design/quiz-side-panel-handoff.md`, run against a throwaway
mod on the **2.1.292 terminal CLI**, session in auto permission mode, 2026-10-07.
The Desktop Code tab was **not** tested; no row below holds for Desktop.
Declarations come from the build's own `claude-code.d.ts`; "observed" rows come
from a probe log, not from reading.

| # | Observation | Status | Consequence |
|---|---|---|---|
| 1 | `$.mcp.call(server, tool, args)`, `$.mcp.connect`, `$.ui.open({id,title,focus,closeOnEscape,holdToasts,rows,columns})` resolving `{isPlaced}` or `{isPlaced:false, reason}`, `$.ui.panes()`, `$.state` / `atom` / `read` / `update`, `$.prompt.submit`, `$.model.complete({model,prompt})` resolving `{isAnswered, text, usage}` or `{isAnswered:false, reason}`, `$.command.register` + `command.run`, `$.session.id()` (a Promise) all exist. Elements come from `$.ui.resolve(e)`. | Declared and used | Handoff names hold, except: there is no post-tool event, see 3 |
| 1 | `claude plugin validate` rejects a hooks module that passes `$` to a helper function, aliases it, or uses `import()`. | Observed | Every `$.` call is written inline in the mod; helpers return values only |
| 2 | `$.mcp.call` reached this plugin's server as `plugin:eklavya:eklavya` and `plugin_eklavya_eklavya` (about 1 to 1.7 s for `get_config`). The name `eklavya` failed: "no connected MCP tool". | Observed, terminal | Try the plugin-scoped spellings in order; never assume one |
| 2 | The first `$.mcp.call` after a reload was refused twice in two reloads: "The server-side auto mode classifier gave no verdict ... Issue the action again once, as-is". The immediate retry succeeded. | Observed in auto mode only; other modes not tried | The mod retries once on this refusal, then shows the error state |
| 3 | A `tool.call` hook sees the model's own `mcp__plugin_eklavya_eklavya__*` call, and `await next(e)` returns after it completes (413 ms for `get_config`). It also sees the mod's own `$.mcp.call` calls. | Observed, terminal | Option (a): the mod hooks `tool.call` for `present_question`, awaits `next`, then syncs. It must ignore its own `panel_*` calls |
| 4 | With a 60 s `Bash` and a background `Agent` (6 steps, 8 s apart) both running, 14 pane button presses each awaited a 7 s model call inside the handler. Bash took 60 s end to end and the agent 53 s; neither paused. | Observed, terminal | Blocker 4 passes on the terminal. Feedback rendering during the run was not inspected |
| 5 | `ui.open` from a command the person typed resolved `{isPlaced:true}`; `$.ui.panes()` listed it shown and not focused. Unasked opens, narrow widths, 110 vs 144 columns, and another mod's pane were not tried. | Partly observed | Treat any `reason` as unplaced; the width floors stay the declaration's words (144 unasked, 110 asked) |
| 6 | A pane button handler awaited `$.model.complete` for about 5.6 to 7.5 s and was not cut off. A 15 s call was not reached. | Partly observed | Typed-answer grading is feasible at 7 s; the 10 s hook budget is unproven either way, so the mod keeps the model prompt short and treats a cut-off as the error state |
| 7 | `void $.prompt.submit({text})` returned in 0 ms. Delivery after the turn was not checked. | Partly observed | Decision 4's route stays unconfirmed; the visible "Ask Claude to explain" fallback is the baseline |
| 8 | A command registered with `$.command.register({name})` ran as `/eklavya-spike`, unprefixed. | Observed | The reopen command is `/eklavya-panel`; it does not collide with `/eklavya:quiz` |
| 9 | `session.start` fired when the mod loaded, with `surface: "terminal"` and the session id. `session.end` carries `reason`, and after `/clear` **no `session.start` fires**. | Start observed; clear from the declaration | The mod syncs on `session.end`, on its next `tool.call` and on each prompt, not only on `session.start` |
| 10, 11 | Per-mod disable and where a mod is declared inside a distributed plugin | Not tested | Stage 3 finds the declaration the validator accepts for the packaged plugin |

## Updating this reference

Record the date, source and scope of verification: upstream docs, source code,
unit test, captured payload or live UI. Correct stale claims rather than adding
a contradictory note below them. Keep examples aligned with shipped manifests
and update hook tests, agent allowlists and affected manual pages in the same PR.
