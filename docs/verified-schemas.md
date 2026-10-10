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

Ten implementations use six events. PreToolUse has three registrations (`Bash`
for the commit gate, `^Read$` for file history, `^AskUserQuestion$` for the
`[Eklavya]` line on hosts without a header chip). PostToolUse has four registrations:
capture for all tools, checkpoints on both concept logging and work tools, and the
delegation nudge on work tools plus `Agent`/`Task`.
All launch `node` with `args`. Timeouts are in seconds: 10 for each registration,
15 for Stop. Do not copy timeout units from another integration schema.

| Event | Data used by Eklavya | Result |
|---|---|---|
| SessionStart | Session identity, checkout, `source` | Visible profile plus model recall/directive |
| UserPromptSubmit | Identity, `agent_id` and `prompt` | Capture, recall, logging nudge and, next to a task-sized prompt, the delegation line |
| SubagentStart | `agent_type`, session identity | Implementer logging directive; tutor exempt |
| PreToolUse | `tool_name`, `tool_input.command`, `tool_input.file_path` or `tool_input.questions[].header`/`question`, `agent_id` | Optional commit denial; before a Read, the file's past work as `additionalContext`; on a card host, a refusal of an `Eklavya`-headed question that lacks `[Eklavya]` (the refusal is a `permissionDecision: "deny"`; not yet observed on a live Desktop session) |
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

## Mods (function hooks): quiz side panel

Observed on the **2.1.292 terminal CLI**, with the plugin loaded from a checkout
(`claude --plugin-dir`), 2026-10-07. The Desktop Code tab was **not** tested and no row
holds for it. `PANEL_SURFACES` in `mcp/src/panel-state.ts` lists `desktop` anyway (enabled
2026-10-08 at the maintainer's request): the planner still falls back to the card when the
mod never reports in or reports `placed: false`. Verify rows 5, 12 and 13 on a Desktop build
and record them here.
"Declared" rows come from the build's own `claude-code.d.ts`; "observed" rows from a probe
log or a driven session.

| # | Observation | Status | Consequence |
|---|---|---|---|
| 1 | `$.mcp.call(server, tool, args)`, `$.ui.open({id,title,focus,closeOnEscape,holdToasts,rows,columns})` resolving `{isPlaced}` or `{isPlaced:false, reason}`, `$.ui.panes()`, `$.state` / `atom` / `read` / `update`, `$.prompt.submit`, `$.model.complete({model,prompt})`, `$.command.register` + `command.run`, `$.session.id()` / `cwd()` / `surfaces()` / `version()` (all Promises) exist. Elements come from `$.ui.resolve(e)`. | Declared and used | The handoff's names hold, except there is no post-tool event: see 3 |
| 1 | `claude plugin validate` rejects a hooks module that aliases `$`, passes it to anything but a function declared at the top level of the file, shadows `on` or `next`, or uses `import()`. A render matcher's `requestId` must be a literal to be recognised. | Observed | `register.tsx` keeps every `$` call in the hook or a top-level function, and the pane id literal in the matcher |
| 1 | `modules` sits beside `hooks` in the same `hooks.json`, a module path outside `hooks/` validates, and a `types` entry in the manifest names the `$.state` contract. | Observed | The mod ships at `hooks/panel/` under `./panel/register.tsx`; the npm payload copies it (not its tests) |
| 2 | `$.mcp.call` reaches this plugin's server as `plugin:eklavya:eklavya` and `plugin_eklavya_eklavya` (about 0.4 to 1.7 s). The bare name `eklavya` failed while the plugin was loaded as a plugin. | Observed | The mod tries the spellings in order |
| 2 | In auto permission mode the first `$.mcp.call` after a reload was refused twice in two reloads: "The server-side auto mode classifier gave no verdict ... Issue the action again once, as-is"; the retry succeeded. | Observed in auto mode, in the probe only | The mod asks once more on that refusal |
| 3 | A `tool.call` hook sees the model's own `mcp__plugin_eklavya_eklavya__*` call, and `await next(e)` returns after it completes. It also sees the mod's own `$.mcp.call` calls. In a driven session the pane drew within seconds of the model's `present_question` call. | Observed | Option (a): the mod syncs after `present_question`, and ignores its own `panel_*` calls |
| 3 | A busy event can run before the PostToolUse command hooks that choose how to ask, so the heartbeat is refreshed before the tool runs, not after. The server may still be starting when `session.start` fires, so a failed sync must not throttle the next one. | Observed (a first live run chose the card for this reason) | `beat` runs before `next(e)`; the throttle is stamped only on success |
| 4 | With a 60 s `Bash` and a background `Agent` both running, 14 pane button presses each awaited a 7 s model call in the handler; neither tool paused. In a driven session the model kept working (tool calls, edits, a final answer) while its question sat in the pane. | Observed | Blocker 4 passes on the terminal |
| 5 | Opened from a command the person typed, `ui.open` resolved `{isPlaced:true}`. Opened unasked in a 170-column fullscreen terminal the pane docked beside the transcript; in a 100-column one it waited (`isPlaced:false`, the question stored `unplaced`), and `/eklavya-panel` then drew it inline at any width. | Observed | Unplaced questions wait and are reopened by command; 144 and 110 columns are the host's thresholds, not logic here |
| 6 | A pane button handler awaited `$.model.complete` for about 5.6 to 7.5 s and was not cut off; a typed answer was graded this way end to end. A 15 s call was not reached. | Partly observed | Typed-answer grading works at that latency |
| 7 | `$.prompt.submit({text})` returned in 0 ms and the prompt was delivered after the turn: the model received it framed ("a prompt a plugin submits between turns") and acted on it, starting the explainer agent. | Observed | Now the fallback only: a miss calls `$.agent.spawn` with `subagentType` `eklavya:eklavya-explainer` and asks once more when the spawn is denied or throws, and queues this prompt only after a second refusal. Observed live in auto mode (2026-10-08): the spawn was refused as `eklavya:eklavya-explainer denied by auto mode · Classifier unavailable`, and this prompt then started the explainer. Auto mode drops `Agent` allow rules, so no setting exempts the spawn. The transcript row of this prompt and of Next's is drawn as one short line by a `ui.render` hook on `UserMessage` rows whose `origin` is the eklavya plugin; the model still receives the full text (mod tests only, not yet observed live) |
| 8 | A command registered with `$.command.register({name})` ran as `/eklavya-panel`, unprefixed. | Observed | It does not collide with `/eklavya:quiz` |
| 9 | `session.start` fires when the mod loads, with `surface: "terminal"`. After `/clear` the pane resets and the old session's question stays unanswerable; `session.end` carries `reason`. | Observed | The mod syncs on `session.end`'s next event, on each prompt and on tool calls |
| 10 | Whether Claude Code can disable one mod separately from its plugin | Not tested | Documented only as `quiz.panel` false |
| 11 | The distributed plugin (`hooks.json` with command hooks and `modules`, manifest `types`) passes `claude plugin validate`, and loaded from a checkout it ran the mod beside the command hooks. | Observed | `scripts/test-panel-mod.sh` validates the staged mod and the distributed plugin |
| 12 | Keys: after Ctrl+X then Tab the pane holds the keyboard and a Button's hotkey presses it; Esc closes the pane (`closeOnEscape`); Tab does not reach an `Input` that appears on a later draw unless it is `autoFocus`; a click focuses it. | Observed | The answer box is `autoFocus`, so Other then typing works from the keyboard |
| 13 | A bordered `Box` card holding a plain `Button` (the whole answer text) and a `Markdown` note drew in the maintainer's terminal; a click on the text selects the card. The block-character logo drew only once its `Box` had `flexShrink={0}`: beside a long topic line it wrapped without it. | Observed | Cards, the press target and the logo rely on those two props |
| 14 | `$.clock.after` closing a finished result after 15 s, and `$.ui.focus` moving the focus mark onto the picked answer. | Not tested live | Only the mod's test host ran them, and it refuses `$.ui.focus` (it holds no keyboard); a failed move is caught and the pick stands |

## Updating this reference

Record the date, source and scope of verification: upstream docs, source code,
unit test, captured payload or live UI. Correct stale claims rather than adding
a contradictory note below them. Keep examples aligned with shipped manifests
and update hook tests, agent allowlists and affected manual pages in the same PR.
