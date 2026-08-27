# Phase 8 — Interleaved cadence

**Status:** implemented
**Spec:** PRD §9 (hooks), §11 (config), §7 (migration 007)

## The problem

The tagline is *learn while your agent works*. What shipped through 1.3 was: learn after your agent works.

Every question came from the `Stop` hook, which by definition fires when the task is finished. Four of them arrive at once, at the exact moment the developer wanted to be done, about code they stopped thinking about ten minutes ago. That is not learning during generation time — it is a toll booth at the end of it, and the natural response is to pay it with four skips.

Two failures compound:

1. **Timing.** The question is furthest from the code it is about at precisely the moment the answer would have been cheapest to give. A question asked seconds after the line was written costs seconds; the same question twenty minutes later costs a re-read.
2. **Batching.** Four questions in a row is an interruption with a shape. One question mid-flow is a beat; four questions at a boundary is a meeting.

Both are the same root cause: the only trigger available was `Stop`.

## The seam

`PostToolUse` fires mid-turn and its `additionalContext` lands in front of the model immediately (verified 2026-08-27, `docs/verified-schemas.md`). That makes a mid-task question mechanically possible for the first time.

The matcher is **`log_session_concepts` itself**, not file edits or a wall clock. That choice is the design:

- The model has just declared *"this task exercises `jwt-verification`, and here is the line where"*. The concept and its worked example are both in hand — nothing has to be inferred.
- The code is still on screen and still in context. Proximity is the entire pedagogical advantage.
- A clock knows time has passed but not that anything was learned; an edit counter knows work happened but not what it was about. Only this seam knows both.

Considered and rejected:

| Trigger | Why not |
|---|---|
| Wall-clock timer | Fires on whatever concept happens to be pending, however stale. Closest to the naive "every 15 seconds" reading of the request, furthest from why that reading is appealing. |
| Every N file edits | Paces by volume, not by content. Fires after a rename; silent through a subtle change that taught the most. |
| `PostToolBatch` | Cheaper (once per resolved batch) but coarser, and it does not know *what* was learned. Noted in the schema doc as the fallback if per-call cost ever bites. |

## The third dial

`cadence` joins `mode` and `focus`, and stays orthogonal to both for the same reason `focus` did: every combination is coherent. `enforced` + `end` is a lead who wants the gate but not the interruption. `ambient` + `interleaved` is the default experience.

| `cadence` | Behaviour |
|---|---|
| `interleaved` (default) | one question at the seam where a concept was logged; the Stop hook sweeps up the remainder |
| `end` | the pre-1.4 behaviour, unchanged |

## The budget, which is the whole trade

`max_questions_per_task` becomes a **session budget** rather than an end-of-session batch size. Checkpoints spend from it; `stop-quiz-check.sh` subtracts `count(attempts)` and asks only for what is left, exiting silently at zero.

Without that subtraction the feature would be a straight regression — four questions mid-task *and* four at the end is worse than what it replaced. With it, turning `interleaved` on does not add a single question. It moves them to where they are cheap to answer, and a session that checkpointed its way through the budget ends in the silence it would have had if Eklavya were not installed.

The commit gate improves as a side effect: `gates.answered` counts checkpoint attempts, so an enforced session is frequently already passed by the time anyone types `git commit`.

## The burst guard

The mirror of the Stop hook's loop guard, protecting against the opposite failure. That one stops an end-of-turn loop; this one stops a mid-turn pile-up — the model logs 3–8 concepts per call and may call more than once per task, so the naive version asks eight questions in a row and gets uninstalled by lunchtime.

Three rules, all in `checkpoint-quiz.sh`:

1. **One question per checkpoint.** `max: 1`, said explicitly to the model, and repeated in the tutor skill.
2. **`min_minutes_between_checkpoints`** (default 4) since the last checkpoint *and* since the last answer. Both clocks, for the same reason the Stop hook checks both: a checkpoint the model ignored should still pace the next one.
3. **The session budget** above.

Plus the disqualifiers: `mode: off`, `cadence: end`, nothing unmastered and unasked, and — the one worth naming — **subagents**. `agent_id` is present in hook stdin only inside a subagent, which has no `AskUserQuestion` and no human watching its transcript. Checkpointing there would spend a question on a prompt nobody ever sees.

Failure is silent at every step: exit 0, no output. This hook runs on tool calls, and a hook that errors on tool calls is a plugin nobody keeps.

## Why exit 0 + JSON, not exit 2 + stderr

The Stop hook uses exit 2 because it has something to *prevent*. This hook does not — the tool already ran, and exit 2 on `PostToolUse` renders to the developer as a hook warning: an error face on a feature that is working correctly. So `additionalContext` carries the instruction to the model and `systemMessage` tells the human why their agent just stopped to ask them something.

## Tasks

- [x] Migration 007: `checkpoints` table (pacing state, separate from `stop_markers`)
- [x] `cadence` + `min_minutes_between_checkpoints` in config, CLI, `set_config`, `doctor`
- [x] `hooks/checkpoint-quiz.sh` + `PostToolUse` registration
- [x] `stop-quiz-check.sh` demoted to a sweep of the remaining budget
- [x] Tutor skill: the checkpoint contract, and the discipline of *one*
- [x] SessionStart directive names the checkpoint, since the skill may never load
- [x] README, `.eklavya.json.example`, `/eklavya:mode`
- [x] Tests: burst guard, budget sharing, subagent skip, cadence off, silent failure

## Notes / decisions

- **Hook focus defaults corrected.** `stop-quiz-check.sh` and `session-start.sh` still defaulted `focus` to `project` after 1.3 changed the config default to `concept`. On a machine with no config file the hooks framed questions one way and the server framed them another. Fixed alongside this phase.
- **Checkpoints ask about the most recently logged concept** (`ORDER BY ts DESC`), where the Stop sweep asks oldest-first. Different jobs: the sweep is clearing a backlog, the checkpoint is asking about what just happened.
- **`ignore_cooldown: true` on the checkpoint plan call.** `min_minutes_between_quizzes` (20) paces whole quizzes; the hook has already applied the finer-grained pacing that governs single questions. Without this the model is told to ask and then handed `questions_needed: 0`.

## Acceptance

Build something real in an ambient session. Questions arrive spread through the work, one at a time, each about code visible on screen — and when the task ends, Eklavya says nothing, because there is nothing left in the budget to ask.
