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
  options as lettered text. Any change to
  `skills/tutor/references/writing-mcq.md` has to hold for a plain-text
  renderer too.

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

## The dials are in the status bar, not above the stem

Until 1.14 every plan item carried `ask_header` and the tutor printed it above
the question: `[mode: ambient · focus: concept · level: easy · tier: 2
mechanism]`. It existed for a real reason — on `concept` focus a deliberately
transferable question reads as a vague one, and on `easy` a tier-2 question
reads as shallow rather than as a runway — but it spent four settings' worth of
screen above *every* stem to say something that is true for the whole session.

Ambient state belongs somewhere ambient. `statusLine` in `mcp/src/statusline.ts`
composes `[EKLAVYA ambient · concept · interleaved · easy]` for
`eklavya statusline`, which the host's status bar runs. `askHeader` is deleted,
the plan no longer carries `ask_header`, and both hooks now say *ask the stem on
its own*.

Two consequences for anyone editing a skill:

- **Never tell the model to compose a settings line.** Not the dials, not the
  tier, not `question: 2 of 3`. A line a skill assembles is a line the server
  cannot keep consistent, which is the reason this was centralised in the first
  place.
- **`stripAskHeader` stays, and must.** Every attempt recorded while the line
  existed still has it inside the stem, and `questionFingerprint` (`store.ts`)
  hashes that text. Delete the stripper and the entire back catalogue changes
  fingerprint at once, so *never the same question twice* breaks for every
  question ever asked. It is now a guard for history, plus a model that invents
  a line anyway.

The tier is deliberately nowhere on screen. A status bar refreshes on the host's
cadence, so a tier there would sometimes name the previous question's
difficulty, and a stale readout is worse than none. `level` covers what the tier
was explaining: `easy` already means tiers 1-2.

## The tutor skill is an entry point plus references

`skills/tutor/SKILL.md` was 5,296 words in one file, loaded whole whenever the
model decided a task was non-trivial. It is now the part that decides *whether
to act* — the log loop, checkpoint versus sweep, the shared budget, the tier
ladder, the plan's authoritative fields, and a Red Flags table of the
rationalizations that have each shipped a worse session — with the craft in
three siblings:

| File | Holds |
|---|---|
| `references/writing-mcq.md` | the four-option shape, `answer_position`, distractors, plain language, the second question about a concept, `prereqs_unmet`, and how to record a stem |
| `references/grading.md` | both scales, the mcq cap, feedback length, the four-step sequence a blank earns, `already_taught` |
| `references/focus-and-level.md` | the three focuses, the earned level bands, the cadence contract, the enforced-mode gate retry |

Two rules keep that split working.

**Mark a reference REQUIRED at the point of use, never as an `@`-link.** An
`@`-path is resolved eagerly by the host, which pulls the whole file into
context and undoes the split. "Read `references/grading.md` before you grade",
written where grading comes up, is what makes the model open it exactly when it
needs it.

**The entry point does not grow back, and the pointers stay honest.**
`test/packaging.test.ts` fails above 2,000 whitespace tokens, and asserts the
set of files named in SKILL.md is *equal* to the set on disk. Both directions
matter. A pointer with no file is the worse half — the model is told the rules
are elsewhere, cannot find them, and improvises, while nothing errors. A file
with no pointer is the quieter half: it ships, `export-rules` inlines it, and
Claude Code is never told to read it, so the same pedagogy differs by surface.
An earlier version of that test harvested pointers from SKILL.md *and*
`agents/tutor.md` into one list and asserted the list was non-empty — which
passed with no pointers in SKILL.md at all, the exact state it was written to
catch.

## Match the form to the failure

Two failures need opposite wording, and using the wrong form measurably makes
things worse. superpowers A/B tested this on their own dispatch-prompt
guidance: the "don't do X" version produced **more** of the unwanted content
than the "here is the shape" version — the distributions fully separated — and
it did worse than giving no guidance at all.

- **The model knows the rule and breaks it under pressure.** Discipline. Ban
  it, and name the excuse next to it: that is what the Red Flags table at the
  top of `SKILL.md` is, and what the shared budget, one-question and
  spent-question rules live in.
- **The model complies and produces the wrong shape.** Craft. Bans backfire
  here. Describe the shape you want, in build order, and let the prohibitions
  fall out of it as properties of the finished thing.

Writing a good multiple-choice question is the second kind, and
`references/writing-mcq.md` was written as the first kind — *never restate the
answer, no double negatives, avoid "which is NOT", do not number the options*.
It is now a six-part recipe in build order followed by a checklist of
properties, so the same rules arrive as "the answer appears among the options
and nowhere in the stem" rather than as separate bans to weigh.

**No nuance clauses in the recipe.** superpowers measured this separately: one
appended "unless it matters" turns a reliable recipe into a noisy one, because
it reopens the negotiation the recipe had settled. `writing-mcq.md` carried
exactly one — *"Save the precise term for when the precision is the point"* —
and it is gone. If an exception is real, it belongs in the plan's `framing`,
which is server-side and authoritative, not in a hedge the model gets to weigh.

`references/grading.md` keeps its prohibitions on purpose. Inflating a grade
and offering to stop because someone is blanking are pressure failures, not
shape failures: the model knows what honest grading is.

## The tutor skill has two readers

`mcp/scripts/copy-assets.mjs` bundles the whole `skills/tutor/` directory to
`mcp/dist/assets/tutor/`, and `eklavya export-rules` (`mcp/src/cli.ts`) strips
the frontmatter and wraps it as a Cursor rules file. So the pedagogy is
consumed by two editors.

**Cursor has no progressive disclosure**, and that is the reason `export-rules`
concatenates SKILL.md with every `references/*.md` in alphabetical order and
says so in its preamble. A rules file is one document with `alwaysApply: true`,
so "read `references/grading.md`" there is a pointer to nothing. Had the split
shipped without the inlining, Cursor would have got the dispatch logic and none
of the craft — and every test would still have passed. `test/cli.test.ts` now
asserts a line from each reference reaches the output.

Alphabetical rather than a hand-kept order: in an always-apply document the
whole thing is in context at once, so order carries no meaning, and a listed
order is one more place a new reference gets forgotten.

**A missing reference is a hard failure there, not a warning.** `export-rules`
reads the pointers out of SKILL.md and refuses to emit anything if one of them
did not bundle, naming the file. It has to: the preamble promises the material
is further down the document, so a half-bundled export is worse than none — the
model is assured the rules are present and hunts for them instead of falling
back on what it has. `copy-assets.mjs` only warns when a copy fails, so that
state is reachable rather than hypothetical.

Consequence of the two readers: **no Claude-Code-only instructions in any of
the four files.** Slash-command names, plugin paths and hook mechanics belong
in the command skills, not in the pedagogy. `AskUserQuestion` is the one
unavoidable exception, and `agents/tutor.md` already carries the fallback for
renderers that lack it.

## Consistency

The same behaviour described in two skills has drifted apart before — that is
how `focus: project` got into three files. The four dials appear in
`skills/mode/SKILL.md` and `user-skill/eklavya/SKILL.md`; the level bands
appear in `skills/level/SKILL.md` and `tutor/references/focus-and-level.md`;
the cadence cap appears in `mode`, `quiz` and that same reference. **When you
change one, grep the others for the same claim.** Where any of them disagrees with the code,
`mcp/src/config.ts` and the tool file are right and the skill is wrong.
