# Working in `hooks/`

This directory is wiring, not logic. Two files: `hooks.json` registers the
events, `run.mjs` is the one entry point every hook and the MCP server go
through. The behaviour lives in TypeScript under `mcp/src/hooks/` and ships
compiled as `dist/hooks/<name>.js`. Editing a hook almost always means editing
`mcp/src/hooks/`, not here.

## `run.mjs` is the launcher

`.sh` hooks are unreliable on Windows, so every entry in `hooks.json` — and
`.mcp.json` — is `"command": "node"` with
`["${CLAUDE_PLUGIN_ROOT}/hooks/run.mjs", "<name>"]`: `node.exe` is a real
executable and needs no shell. Keep that shape; `mcp/test/packaging.test.ts`
asserts the server entry is exactly that string.

`run.mjs` maps `<name>` to `dist/hooks/<name>.js` (`server` → `dist/server.js`)
and resolves it, most specific first: `EKLAVYA_RUNTIME`, then the checkout's own
`mcp/dist` (only when `mcp/node_modules/better-sqlite3` exists), then
`~/.eklavya/runtime/node_modules/eklavya`. In a development checkout your local
build wins — so rebuild before you test. With no build reachable, `server` falls
back to `npx eklavya@<pinned> serve` and a hook starts a detached background
`npm install` (once an hour at most, claimed by a `.installing` stamp before
spawning) and exits 0 saying nothing.

**It carries no version number.** It reads `.claude-plugin/plugin.json` at
runtime, and `mcp/test/packaging.test.ts` asserts the file matches no
`\d+\.\d+\.\d+` anywhere and does match `plugin\.json` — so writing any dotted
triple in here, even in a comment, fails that test on purpose.
`scripts/bump-version.sh` bumps `plugin.json` and `mcp/package.json`, nothing
else.

## The five hooks, out of `hooks.json`

| Event | Matcher | Timeout | Script | Job |
|---|---|---|---|---|
| SessionStart | — | 10s | `session-start` | stamp `meta.current_session`, print the profile banner and the standing log directive |
| UserPromptSubmit | — | 10s | `prompt-submit-nudge` | re-state the log directive in one line, but only for a session that has logged nothing after a grace window |
| PreToolUse | `Bash` | 10s | `pre-tool-gate` | in `enforced` mode only, deny a `git commit` whose session gate has not passed |
| PostToolUse | `mcp__.*log_session_concepts` | 10s | `checkpoint-quiz` | one mid-task question, `interleaved` cadence only |
| Stop | — | 15s | `stop-quiz-check` | block the turn and demand a quiz |

The PostToolUse matcher is a regex over the MCP tool name, not a literal, because
the prefix depends on how the plugin was installed —
`mcp__eklavya__log_session_concepts` standalone,
`mcp__plugin_eklavya_eklavya__log_session_concepts` via `/plugin`. `mcp__.*`
catches both; anchoring it to one spelling silently disables the checkpoint for
half the installs.

## Every failure path exits 0

A hook that throws breaks the user's session, and a learning tool that breaks
sessions gets uninstalled. `run()` in `mcp/src/hooks/lib.ts` enforces it: parse
stdin defensively, run the body, exit 0 silently on any throw. A new hook body
goes inside `await run(async (input) => { ... })` and returns an exit code; it
never calls `process.exit` itself. Helpers follow the same rule —
`openExisting()` returns `null` rather than throwing on a missing or corrupt
database, and deliberately does not migrate or seed (several hooks racing a
migration on session start is a corruption story). The one non-zero code is the
Stop hook's `return 2`, which is how Stop blocks; the reason goes on stderr.

## A hook must never *wait*, either

Exiting 0 on a throw covers the loud failure. The quiet one is worse: a hook
that blocks never errors, never logs, and stalls the session on every tool call
that triggers it — with nothing for the developer to report except that Claude
Code got slow.

It is reachable. `readInput` used to be `for await (const chunk of
process.stdin)`, which has exactly one exit: EOF. On Windows the host may run a
hook through a PowerShell block that swallows the piped JSON, so `end` never
fires (reported by ponytail, #443). `run.mjs` is careful about everything else —
Node version, four resolution candidates, a self-expiring heal claim, exit 0 on
every throw — and this was the one gap.

`mcp/src/stdin.ts` closes it, and `eklavya statusline` shares it: both read a
JSON blob the host pipes in, both must degrade rather than hang, and two copies
would be one copy getting the fix. Three things matter about it.

**The bound is on silence, not on total time.** A flat cap truncates a payload
still arriving when it fires, and truncated JSON does not fail loudly — it fails
as `{}`, so the hook runs to completion having quietly decided the session has
no cwd and no id. The idle timer resets on every chunk, so a slow or large
payload is never cut off; a total cap sits behind it for a stream that never
stops.

**Every timer is `unref`'d.** `end` arrives first in almost every real
invocation, and a pending timer must not hold the process open or add latency to
a hook that has already done its work.

**There is an `error` handler.** A stream that errors never emits `end`, so
without one the read waits on something that is not coming.

`HOOK_STDIN` is 2s idle / 5s total, well under the 10s `hooks.json` grants (15
for Stop) — a read that outlives its host timeout is a read the developer waits
on, and `test/stdin.test.ts` asserts the relationship rather than the number.
That suite spawns a real hook, writes a payload, and **never closes stdin**;
against the old code all three cases hang until the test kills them.

`stripBom` runs before every `JSON.parse` here. Some Windows shells prepend a
byte-order mark, and `JSON.parse` throws on input that looks perfectly
well-formed in a terminal and in any editor — another silent nothing-happens.

## The Stop hook blocks in `ambient` too

Commonly got wrong. `ambient` is not "never interrupts" — `stop-quiz-check.ts`
returns 2 in ambient as readily as in enforced. `enforced` changes three things:
the `min_minutes_between_quizzes` cooldown is skipped (a cooldown could make a
commit gate unpassable — decision G5); the one-question cap under `interleaved`
is lifted, so the sweep asks for the whole remaining budget; and `pre-tool-gate`
plus `cli/eklavya-gate` start holding commits. Only `mode === 'off'` silences
everything.

## The loop guard

A Stop hook that blocks on every Stop blocks forever, and `stop_hook_active` is
no longer a documented input. So the rule is: block only when the count of
`origin = 'work'` rows in `session_concepts` has **grown** since the last block.
Blocking stamps that count into `stop_markers` (`last_logged_count`,
`last_blocked_at`, `block_count`), *before* the block — a failure after it costs
a missed quiz, never a loop. `max_stop_blocks_per_session` (default 3) caps even
genuinely new work. Counting review-origin rows here would let answering a
question re-arm the block that asked it; don't. `checkpoint-quiz.ts` has the
mirror-image guard for mid-turn bursts, stamping `checkpoints` before it emits.

## Pacing

Two different keys, one hook each (`mcp/src/config.ts` is the source of truth):
`min_minutes_between_checkpoints` (default 4) paces the single mid-task question
and is read by `checkpoint-quiz.ts`, against both the last checkpoint and the
last answer; `min_minutes_between_quizzes` (default 20) paces a whole Stop quiz,
is read by `stop-quiz-check.ts`, and applies **in `ambient` only**.
`max_questions_per_task` (default 4) is a session allowance shared by both hooks:
every `attempts` row spends it, so the Stop hook asks for whatever the checkpoints
left. The two hooks' candidate queries share a WHERE clause verbatim; if you
change one, change both, or a concept gets asked twice or never.

## The SessionStart banner is a format string

The `[Eklavya] ...` line in `mcp/src/hooks/session-start.ts` is quoted verbatim
by `web/public/index.html` (the hero terminal script) and
`web/src/content/docs/docs/installing.mdx` (the no-history variant). Changing its
wording, order or fields means re-quoting both in the same commit.

## Testing a hook by hand

`dist/` must exist first — the tests run the built files, not the sources, and
`pretest` builds them. From `mcp/`:

```sh
npm run build
echo '{"session_id":"s1","cwd":"/path/to/repo","hook_event_name":"Stop"}' \
  | EKLAVYA_DB=/tmp/k.db EKLAVYA_HOME=/tmp/eklavya-home \
    node dist/hooks/stop-quiz-check.js; echo "exit $?"
```

`EKLAVYA_DB` and `EKLAVYA_HOME` point a hook at a scratch database and config;
`EKLAVYA_SESSION_ID` overrides the harness session id. `mcp/test/hooks.test.ts`
and `mcp/test/gate.test.ts` do exactly this.
