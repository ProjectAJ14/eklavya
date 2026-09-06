# Editing a skill

`skills/` is where Eklavya's behaviour actually lives. The MCP server holds the
data and the arithmetic; these files hold everything the model does with it.
A wrong sentence here is a wrong product, and nothing fails loudly when it is.

## What a skill is, mechanically

One directory, one `SKILL.md`, YAML frontmatter with `name` and `description`.
**`disable-model-invocation: true` is what turns a skill into a
`/eklavya:<name>` slash command** — the model can no longer load it on its own,
and the developer types it. Without that line the skill is model-invocable only.

Seven have it, and they are the seven slash commands:

`gate`, `learn`, `level`, `mode`, `progress`, `quiz`, `setup`.

`skills/tutor/SKILL.md` deliberately does not. It is the pedagogy — one
question at a time, honest grading, never the same question twice — and every
other skill defers to it rather than restating it. `quiz` says "follow the
`tutor` skill for how to ask and grade"; keep it that way. Pedagogy duplicated
into a command skill is pedagogy that drifts from the one place Cursor reads.

## The description is a trigger, not a summary

For a model-invocable skill the `description` is the only part always in
context; the body is read only once the model has decided to load it. So a
description that summarises the workflow becomes a shortcut the model takes
*instead of* reading the body — it answers from the summary and never opens the
file. The body becomes documentation nobody reads.

`skills/tutor/SKILL.md` had exactly that shape. It read "Use while implementing
any non-trivial task (to log the concepts it touches), and whenever quizzing,
grading, or explaining" — three steps named, and nowhere in it the words *one
question, mid-task*. Which is the failure the interleaved cadence had to fix:
questions arriving in a pile at the end of the work.

So, for `tutor` and anything else without `disable-model-invocation`:
**triggering conditions only**, third person, opening "Use when". Never the
number of questions, never the order of the tool calls, never the grading.
Those live in the body, which is where the model has to go to get them.

The seven slash commands are exempt, and it is not a technicality:
`disable-model-invocation: true` means the model never matches on their
description at all. The developer types the command and the description is its
one line of help, so those should say what they do. `agents/tutor.md` keeps one
identity clause for the same kind of reason — a subagent is picked from a roster
by what it is, not loaded by trigger.

## Three directories, and why they are not one

- **`skills/`** ships inside the plugin. Slash commands plus `tutor`.
- **`user-skill/eklavya/`** is copied to `~/.claude/skills/eklavya/` by
  `npx eklavya install` (`installSkill()` in `mcp/src/install.ts`). It is
  model-invocable, so plain chat — "Eklavya is quizzing me too much" — reaches
  it, and it works where the plugin is not loaded. **Never move it under
  `skills/`**: it would then register twice, once per surface. It drives the
  `eklavya` CLI and the read/write config tools; it does not teach or quiz.
- **`agents/tutor.md`** is the subagent. It has the Eklavya MCP tools and
  read-only file access — and **no `AskUserQuestion`** — so it renders the four
  options as lettered text. Any change to the *Multiple choice* section of
  `skills/tutor/SKILL.md` has to hold for a plain-text renderer too.

## A skill is a prompt, but it is also an API client

Nine tools, all in `mcp/src/tools/`: `get_learner_profile`,
`log_session_concepts`, `get_session_quiz_plan`, `record_attempt`,
`get_gate_status`, `upsert_concepts`, `get_concept_graph`, `get_config`,
`set_config`.

**Before you write "call `X` with `Y`", open `mcp/src/tools/<X>.ts`.** Check
`Y` is in the `inputSchema`, and check the field you are telling the model to
read is in what the handler returns. A skill that names a field the server
never returns fails silently — the model improvises a plausible value and the
developer sees a confident number nobody computed.

`config_tools.ts` holds `get_config` and `set_config`; the rest are one file
per tool name.

### Not every tool takes `session_id`

`log_session_concepts`, `upsert_concepts`, `get_session_quiz_plan`,
`record_attempt` and `get_gate_status` take it, optionally.
`get_learner_profile`, `get_concept_graph`, `get_config` and `set_config` have
no such argument at all. **Omit it everywhere.** The server resolves the
current session itself, which is what lets the subagent's answers count toward
the same gate. Only pass one if a hook handed you an id.

## The facts that have drifted before

Check every one of these against the code when you touch a skill.

- **`focus` defaults to `concept`, not `project`** (`DEFAULT_CONFIG` in
  `mcp/src/config.ts`). This was wrong in three skills at once. Grep before you
  write it: `grep -rn 'focus' skills/ user-skill/ agents/`.
- **The `interleaved` one-question cap has exemptions.** In
  `mcp/src/tools/get_session_quiz_plan.ts`:
  `capped = cadence === 'interleaved' && mode !== 'enforced' && !explicitTopic`,
  and then `max = args.max ?? (capped ? 1 : max_questions_per_task)`.
  So `enforced` mode is exempt, an explicit `domain` or `slugs` is exempt, and
  an explicit `max` wins outright because it is read first. Read that code
  rather than trusting prose about it — including this paragraph.
- **The Stop hook blocks in `ambient` too.** `mcp/src/hooks/stop-quiz-check.ts`
  blocks in both modes; what `enforced` changes is that it skips the
  `min_minutes_between_quizzes` cooldown, takes the whole remaining budget
  instead of one question, and gates commits. Do not write "ambient never
  interrupts".
- **`get_learner_profile`'s lists are capped, and `known` is ordered by score.**
  `LIST_CAP = 8` covers `weak`, `due_for_review`, `projects`,
  `recent_concepts` and `skipped`; `KNOWN_CAP = 30` covers `known`, with the
  real count in `known_total`. `known` is sorted strongest-first, **not** by
  date. `get_concept_graph` caps at 200 nodes and sets `truncated`.
- **The seed catalogue holds 87 concepts today** — 33 `web-auth`, 19 `git`, 18
  `react`, 17 `node-backend`, in `mcp/src/seed/*.json`. If you state that
  number in a skill, recount it first; a seed file gains concepts and the
  sentence does not.

## `ask_header`

Composed centrally in `mcp/src/ask.ts` — mode, focus, level, tier label, and
`question: N of M` only when a plan holds more than one. It is central so it
cannot drift; a skill must never assemble its own.

Three rules, all learned the hard way and all documented in that file: it goes
**above** the stem with a blank line after it, the brackets stay, and it is
**never passed back to `record_attempt`**. The stem alone is what gets
fingerprinted, so a settings line inside it would make one question look new
every time the level changed. `stripAskHeader()` is a backstop, not a licence.
It is absent when `quiet` is set.

## The site ships with the change

The seven commands and `user-skill/` are documented in
`web/src/content/docs/docs/commands.mdx`, and the landing page's `#commands`
section lists them. Adding, renaming or removing a command, or changing its
arguments, means updating both in the same commit. The root `CLAUDE.md` has
the full rule and the source-of-truth table — follow it there rather than
keeping a second copy of it here.

## `skills/tutor/SKILL.md` has two readers

`mcp/scripts/copy-assets.mjs` bundles it to `mcp/dist/assets/tutor-skill.md`,
and `eklavya export-rules` (`mcp/src/cli.ts`) strips the frontmatter and wraps
it as a Cursor rules file. So that file is consumed by two editors.

Consequence: **no Claude-Code-only instructions in its body.** Slash-command
names, plugin paths and hook mechanics belong in the command skills, not in
the pedagogy. `AskUserQuestion` is the one unavoidable exception, and
`agents/tutor.md` already carries the fallback for renderers that lack it.

## Consistency

The same behaviour described in two skills has drifted apart before — that is
how `focus: project` got into three files. The four dials appear in
`skills/mode/SKILL.md` and `user-skill/eklavya/SKILL.md`; the level bands
appear in `skills/level/SKILL.md` and the *Level* section of `tutor`; the
cadence cap appears in `mode`, `quiz` and `tutor`. **When you change one, grep
the others for the same claim.** Where any of them disagrees with the code,
`mcp/src/config.ts` and the tool file are right and the skill is wrong.
