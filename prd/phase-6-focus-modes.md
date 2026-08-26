# Phase 6 — Focus: what Eklavya teaches

**Status:** implemented
**Spec:** PRD §10a, §5.2, §7 (migration 005)

## The problem

`mode` was carrying a question it was never designed to answer.

`ambient | enforced | off` says *how hard Eklavya pushes*. It governs whether the Stop hook blocks, whether commits are gated, whether the cooldown applies. What it never said is *what gets taught* — that was hardcoded: the concepts this session's diff touched, asked about that diff.

That default is right for learning a codebase and wrong for two other real cases:

- someone learning a **stack** rather than a repo, who wants the transferable version of the same ideas;
- someone learning a **topic on purpose**, who wants Eklavya to follow their curriculum and use whatever code happens to be in front of them as the example.

Adding those as `mode` values would have made them mutually exclusive with `enforced`, which is nonsense — an intern gated on a topic they chose is a coherent and useful setup — and would have broken every `.eklavya.json` written against 1.0.

## The shape

Two independent dials. `focus` is *(selection source, framing)* over the planner that already existed:

| focus | selection | framing |
|---|---|---|
| `project` (default) | session concepts + `context` | the code is the subject |
| `concept` | widened to prerequisites and domain siblings | the diff is the motivation; the answer must transfer |
| `learn` | `focus_topic`, prereq-ordered | teach the topic; `bridge_context` carries real code where the work overlaps |

`mode: off` is the only interaction: it wins and `focus` is never read.

## The four conflicts, and how each is resolved

These were found by writing the plan against the existing code rather than around it. Each one is a place where the new dial contradicted something already true.

### 1. `concept` focus contradicted the tutor skill's strongest rule

`skills/tutor/SKILL.md` says *"ground every question in the diff you just wrote"*, with `"What is an httpOnly cookie?"` as the explicit anti-example. That is nearly a description of what `concept` focus asks for. Left alone, the model would either ignore the setting or start asking flashcard questions.

Resolved by **inverting the direction of grounding rather than dropping it**: the diff becomes the motivation, not the subject. The skill now carries this as its own section with two anti-examples — one for the `project` question wearing a concept hat, one for the definition question — and the planner hands over `context: null` in this focus so the code is not available to lean on. The test is stated as a question the tutor can actually apply: *could a correct answer be reused on a different project?*

### 2. `learn` focus threatened what Eklavya is allowed to interrupt for

The Stop hook fires on growth in logged work. A declared topic may have nothing to do with today's task, so the trigger is wrong for it in both directions.

Resolved by **not touching the trigger**. `learn` focus changes what is asked when the hook fires naturally, never when it fires. Pure topic study stays a pull — `/eklavya:learn`, `/eklavya:quiz <topic>`. This is the rule that keeps a standing topic from becoming nagging, and it is stated in the skill, the PRD and the README because it is the one property a user would notice being violated.

### 3. Widening opened a hole in the gate

`required` is derived from the concepts the session's work touched. `passedCount` counted anything in `session_concepts` — and `record_attempt` inserts a row there for whatever it is quizzed on, so that review debt is not free. The two ends measured different things. `concept` focus widening to domain siblings, and `learn` focus selecting from an unrelated topic, would have turned a trickle into the main path: a gate whose bar was set by today's diff, cleared without a single question about today's diff.

Resolved by migration 005, which records `session_concepts.origin` as `work` or `review`:

- `answered` still counts everything — review debt stays real;
- `passedCount` counts only `work` — the bar the work set must be earned on the work;
- `required` is also computed from `work` only. This is the mirror image and matters just as much: letting review rows raise the bar would raise it past anything the learner could clear, which is the deadlock Phase 5's gate-retry fix had just closed.
- `origin` is upgraded `review → work` but never downgraded, so a concept quizzed as review debt and *then* genuinely touched by the task counts as work.

The Stop hook's loop guard needed the same filter: it re-arms on growth in logged concepts, and without it, answering a question would insert a review row, grow the count, and re-arm the block that asked the question.

### 4. Repo-over-global stopped being harmless

Repo config beating global is correct — it is how a lead pins `enforced`. But a repo pinning `focus` silently switches off a `learn` topic someone set for themselves.

Resolved by keeping the precedence and **ending the silence**: `loadConfig` returns `overrides`, `get_config` returns `overridden_by_repo`, and the SessionStart banner names any setting the repo is overriding.

## What is not in this phase

Question **formats** — multiple choice via `AskUserQuestion`, cloze fill-in-the-blank, and the grade cap that keeps a 1-in-4 guess from scoring like understanding. Independent of focus and deliberately separate: it changes *how* a question is asked, not *what about*.
