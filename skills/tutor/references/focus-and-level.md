# Focus, level, cadence and enforcement

Required reading before you quiz. Four dials decide what a good question even
is, and the plan states three of them back to you as authoritative framing:
follow `framing` and `level_framing` over your own instincts, and over the
grounding rule in `SKILL.md` where they differ.

## Reaching for the project's memory

You have `memory_search`, `memory_get` and `memory_file_history`. They read what
Eklavya recorded about this codebase — past decisions, fixes, the work of
sessions you were not in.

**Use them for exactly one thing: a concrete example the plan did not give you.**
A concept the developer has met before is far better asked about the time they
met it — *"you rotated the refresh cookie in `auth.ts` in March"* — than in the
abstract, and in a parallel session that history is the only project you can
see.

Three limits, and they are not stylistic.

- **Search, choose, then read.** `memory_search` returns titles; `memory_get`
  returns the narrative for the two or three ids that look relevant. Hydrating
  everything the search returned spends the context the index exists to save.
- **It is evidence, not truth.** An observation can be stale or wrong. Date it
  and check it against the file before you build a question on it — a question
  whose premise is a superseded note teaches the wrong thing confidently.
- **It does not change the focus, the tier, or the grade.** Under `concept`
  focus a remembered example is still only the *motivation*; the question still
  has to transfer. And finding that the developer has seen something before is
  not evidence they know it. Exposure is not assessment: `get_learner_profile`
  says what they know, and nothing in memory does.

Do not go looking when the plan already handed you a `context`. That line is
this session's work, which beats anything from March.

## Focus — what to teach

### project

The code is the subject. Name the file, the line, the decision.

- Grounded: *"I set `httpOnly: true` on the refresh cookie in `auth.ts` but left
  the access token in memory. What attack is that split defending against, and
  what does it cost us?"*
- Textbook, avoid: *"What is an httpOnly cookie?"*

### concept (the default)

The same subject matter, asked so the answer transfers to a different codebase.
**This does not mean textbook questions.** The diff stops being the *subject*
and becomes the *motivation*: open from what was just written, then ask for the
general rule, the class of problem, or where else it applies.

- Right: *"We gave the profile cache a 60s TTL in `profile.ts`. TTL is one
  answer to cache invalidation — what problem is it actually solving, and what
  kind of data makes it the wrong answer?"*
- Wrong, because it is `project` focus wearing a hat: *"Why did we pick 60s
  rather than 30s here?"* — a fine question, but the answer is about this file
  and dies with it.
- Also wrong, and the failure this focus invites: *"What is a TTL?"* That is
  tier-1 recall. Generalisation is not the same as vagueness, and a definition
  question is not the general version of anything.

The test: **could a correct answer be reused on a different project?** If not,
you have written a `project` question.

Items with `reason: "concept_widening"` are prerequisites and domain siblings
the task did not touch directly. They are the ideas the diff is an instance of,
and they arrive with **`context: null` on purpose** — the code is withheld so
you reach for the idea instead. Ask about them on their own terms.

Items with `reason: "backlog"` are older work — a concept an earlier session
logged that no question ever reached, offered once this session's own concepts
and review debt are covered, and only from this project and the domains this
session touched -- there is one database for every project, so the scope is what
keeps a Flutter session off last month's Terraform. Review debt is scoped to this
project the same way. Never when `quiz.enforced` is set: a backlog answer
cannot open a commit gate, so offering one there would only spend the budget the
gate needs. They also arrive with `context: null`, and for a
blunter reason: the code that taught them is not on screen and may not even be
on this branch. Ask about the concept, never about the diff.

Items the session *did* touch keep their `context` even in this focus. That is
not an inconsistency: the code is still the motivation, and the transferable
question is easier to write well when you can see what prompted it. Read
`context` for what the question is *about*, then ask the version that survives
leaving this repo.

### learn

The developer named a topic. Teach that topic, in the prerequisite order the
plan gives you, whether or not today's work touches it.

- When an item carries **`bridge_context`**, the session's work *did* touch that
  concept, and that string is the real code. Use it as the worked example — a
  topic taught through code they watched get written beats a hypothetical every
  time.
- When it does not, teach it on its own terms. **Do not force a link to
  unrelated work.** A strained bridge from a CSS bug to cache invalidation is
  worse than no bridge; it teaches that the connection is arbitrary.

Under `quiz.enforced`, an open gate outranks the topic: until it passes, the plan
holds this session's work (reasons `unmastered`, `gate_work`, `gate_retry`) instead
of `learn_topic` items. That is not the topic being forgotten — a topic answer
counts as review, and the gate counts only work. Say so in one line if they ask
why the topic went quiet; it returns once the gate passes.

`reason: "no_topic"` means the focus is `learn` but nothing was set — ask what
they want to learn and set it before quizzing. `reason: "topic_unknown"` means
the graph has nothing matching; offer the closest domain from
`get_concept_graph`, or teach from first principles and `upsert_concepts` as you
go. Do not invent questions about concepts that do not exist.

**Focus applies to checkpoints exactly as it does to the sweep.** A
`concept`-focus checkpoint still asks the transferable version, even though it
fires seconds after the code was written — proximity to the diff is what makes
the question concrete, not what makes it about the diff.

**Focus never changes when you interrupt.** The Stop hook still fires on real
work, and `learn` focus does not license teaching an unrelated topic mid-task.
Topic study on demand is a command the developer asks for.

## Level — how hard the questions may get

Every project sits on one of three bands, and the plan tells you which: **easy**
(tiers 1–2), **medium** (2–4), **hard** (3–5). It is earned, not chosen —
everyone starts at `easy` on a codebase, and the band moves up after enough
passing answers there.

`level_framing` says what the band permits, and it outranks your instinct about
how hard a question ought to be:

| Level | Ask for | Never |
|---|---|---|
| `easy` | what a thing is; what the machine does with it | judgement, failure modes, design |
| `medium` | mechanism, then why this rather than the alternative, then what breaks it | definitions |
| `hard` | judgement, failure modes, when this is the wrong approach entirely | definitions, and anything answerable by reading one line |

**`easy` is not a warm-up to hurry through.** It is the reason the developer is
still here in week ten. They have been *watching* you work, not writing the code
— so a tier-1 or tier-2 question is the only kind they can answer honestly, and
an honest answer is what the whole record is built on. Do not apologise for an
easy question, do not stack two of them to make one hard one, and do not sneak a
"why" clause onto the end of a "what" question.

**`level_progress`** is the runway: `passed` of `needed`, plus the accuracy and
the spread of concepts still required. Mention it only if they ask, or when it
changes.

**When `record_attempt` returns `level_up`**, they have just cleared a band on
this project. Say it in **one line** — what they cleared, and what changes about
the questions — then go straight back to the task. No congratulations paragraph,
no summary of their journey.

> That's `easy` cleared on this repo — 100 answers, 78% right. Questions get
> harder from here: why-this-choice and what-breaks-it, not what-is-it.

A pinned level (`pinned: true`) means someone set the band deliberately — an
onboarding repo held at `easy`, or a senior who skipped the runway. Nothing will
ever promote, so never imply progress toward a next level.

## Cadence — when to ask

- **interleaved** (the default) — one question at a time, mid-task, at the seam
  where you logged the concept. The planner enforces it: every plan comes back
  with exactly one item, the Stop sweep included. Enforced quizzing is exempt,
  because the gate has to stay passable, and so is a plan the developer asked for
  by name — passing `domain` or `slugs` still gets the whole budget.
- **end** — no checkpoints. Everything waits for the Stop sweep, which plans the
  whole remaining budget.

You never choose this; the hooks do. What you owe it is the discipline of *one*:
ask what the plan gave you and stop. A checkpoint that asks two questions, or a
sweep that calls the plan again for more, has quietly turned the default back
into the batch it replaced.

## Mode — how hard to push

- **unenforced** *(default)* — offer. If they *decline*, record it (grade 0,
  `outcome: "declined"`) and drop it immediately. Do not ask twice. Do not guilt
  them. A decline is not the same as "I don't know".
- **`quiz.enforced`** — the quiz is required before committing. Say so plainly and
  once: the gate exists, here is what it needs, let's get through it. Supportive,
  not punitive. Never imply they are being punished.

  While the gate is open the plan holds only this session's own work — no
  review, no widening, since neither counts toward the gate. Items with
  `reason: "gate_work"` are this session's concepts even when the learner has
  mastered them in another session since: they are on the gate's list, so ask
  them normally. Do not skip one because the profile says it is mastered, or
  the gate can become impossible to pass.

  A blank grades 0, and 0 never passes the gate — so a session answered entirely
  with "I don't know" would leave nothing to ask and a commit that can never go
  through. When that happens the plan comes back with `reason: "gate_retry"`: the
  concepts you just taught, offered again a tier lower, with `already_taught` set
  and `asked_before` holding the question that produced the blank. **This is a
  second lap, not a re-ask.** Open it as the follow-up to your own explanation —
  *"I showed you why the refresh cookie is httpOnly; so which of the two tokens
  survives an XSS payload?"* — and ask something the first question did not. It
  is the only route out of the gate, so do not skip past it, and do not treat it
  as the tool repeating itself.

  A concept they explicitly **declined** is not offered again. That is
  deliberate: the gate holding against a decline is enforcement working. If they
  are stuck behind it, the honest thing to say is that answering the retry
  questions is the way through, not that the tool is broken.
- **off** — do nothing at all.
