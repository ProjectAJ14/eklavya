# Editing skills and agent instructions

Skills define model behavior; the runtime owns data and arithmetic. A stale
sentence can change the product without raising an error. Read the root
`CLAUDE.md`, then verify instructions against the tool implementation.

## Entry points and ownership

Each skill has a directory and `SKILL.md` with `name` and `description`.
`disable-model-invocation: true` makes the entry user-invoked only. The shipped
slash commands are `gate`, `learn`, `level`, `memory`, `mode`, `pack`, `progress`,
`quiz` and `setup`. Recount from frontmatter when changing this inventory.

| Location | Responsibility |
|---|---|
| `skills/tutor/` | Shared pedagogy; commands defer to it rather than duplicate it |
| `user-skill/eklavya/` | Plain-chat configuration and CLI help, installed to `~/.claude/skills/`; does not teach |
| `user-skill/eklavya-artifacts/` | Create pages through `eklavya artifacts new`, which owns paths, metadata and template |
| `agents/tutor.md` | Read-only file access and selected learning/memory tools; teaches builder-logged concepts and uses lettered text without `AskUserQuestion` |
| `agents/explainer.md` | Background artifact writer; no Eklavya MCP tools, grading or concept logging |

Never move `user-skill/` entries into `skills/`: they would register twice.
Keep artifact design instructions and the explainer's summary aligned.

Model-invocable descriptions should state triggering conditions, in third person,
starting “Use when”; put workflow, tool order and grading in the body. A summary
in the description invites the model to skip reading the rules. User-invoked
command descriptions instead serve as concise help. Agent descriptions also
need their role so they can be selected from a roster.

## Check the API before writing instructions

Open the relevant file in `mcp/src/tools/` before saying “call X with Y”. Verify
the input schema and every returned field the instruction uses. Learning tools
mostly have individual files; config, memory read/write, code and collections
tools are grouped. `tools/index.ts` is the advertised inventory.

Normally omit `session_id`: tools that support it resolve the current session.
Use an explicit ID only when supplied by the host or required by the task.
`log_session_concepts`, `upsert_concepts`, `get_session_quiz_plan`,
`record_attempt`, `get_gate_status`, `get_config` and `set_config` accept it for
session resolution. `memory_timeline` also accepts it, but as a filter: omitting
it shows the whole project. Check each schema instead of assuming all tools
accept the same fields.

Memory follows “search, choose, then get”. Search returns a small index;
`memory_get` returns the chosen narrative. Hydrating every result defeats the
context-saving design.

## Preserve the tutoring contract

- Read defaults from `mcp/src/config.ts`: focus is `concept`. Search every skill,
  user skill, agent and manual page when changing a shared setting.
- Planner output is authoritative. Interleaved questions are capped at one only
  when unenforced and without an explicit topic; explicit `max` wins. Unenforced
  Stop hooks can still ask questions.
- Settings belong in `eklavya statusline`, not a hand-composed question header.
  Follow the plan's `ask_attribution` for host-specific `[Eklavya]` attribution;
  never hardcode a terminal-only rendering rule. Do not display tier/counter
  lines above a stem.
- `stripAskHeader` in `ask.ts` remains necessary for old recorded questions and
  stable fingerprints. Removing it changes duplicate detection for history.
- Honor list caps and truncation. Profile `known` is strongest-first, not most
  recent; graph results can be incomplete. Recount seed totals before quoting.
- Keep `declined` distinct from `dont_know`, MCQ grading capped as the runtime
  requires, and one-question/resume behavior intact.

The tutor entry point chooses whether to act and points to required references:

| Reference | Read before |
|---|---|
| `tutor/references/writing-mcq.md` | Writing the stem, options and recorded question |
| `tutor/references/grading.md` | Grading, feedback, blanks and repeated teaching |
| `tutor/references/focus-and-level.md` | Applying focus, earned levels, cadence and gate retries |

Mark references REQUIRED at their point of use. Do not use eager `@` imports.
Keep the entry point within the packaging test's 2,000-whitespace-token limit.
Every referenced file must exist and every reference file must be reachable from
the entry point; the packaging test checks both directions.

For craft, describe the desired shape in build order, followed by a checklist.
For pressure failures such as grade inflation, retain explicit prohibitions and
the rationalization they prevent. Avoid vague exceptions that let the model
renegotiate a recipe; genuine framing exceptions belong in planner output.

## Bundling and host limits

`copy-assets.mjs` bundles the tutor directory. `eklavya export-rules` strips
frontmatter and inlines reference files alphabetically for consumers that do
not load them on demand. Missing references must fail export, not emit partial
pedagogy. Keep shared tutor material independent of plugin paths, hook mechanics
and slash commands; the tutor agent supplies the plain-text fallback for
`AskUserQuestion`.

Rule export does not provide another editor with Claude Code hooks. Do not
advertise equivalent ambient learning on a host without that integration.
Delegation policy lives in `docs/subagent-policy.md`; the tutor exemption from
the implementer's “do not ask” directive must remain deliberate.

## Documentation and checks

Update the corresponding manual page in the same PR: commands in `commands`,
settings in `dials`/`configuration`, grading in `grading-engine`, levels in
`levels-and-tiers`, artifacts in `dashboard`, and setup in `first-run`.
Update the landing command list if the public command set changes. Search other
skills for duplicated claims rather than fixing only the entry you touched.

Run the relevant packaging, CLI and tool tests from `mcp/` through `npm test`
so bundled assets are rebuilt. Tutor behavior changes also require before/after
evaluation (`eval/README.md`) and the live checkpoint acceptance check
(`CONTRIBUTING.md`). A successful build alone cannot verify prompt behavior.
Build `web/` for documentation edits and record any check not run.
