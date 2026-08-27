---
name: mode
description: Show or change how Eklavya teaches — the focus (project, concept, learn), the enforcement mode (ambient, enforced, off), the cadence (interleaved, end) and the difficulty (auto, easy, medium, hard).
disable-model-invocation: true
---

# /eklavya:mode [project|concept|learn|ambient|enforced|off|interleaved|end] [topic]

Eklavya has **four independent dials**, and conflating them is the most common confusion. Say which one you are changing.

| Dial | Question it answers | Values |
|---|---|---|
| `mode` | How hard does Eklavya push? | `ambient`, `enforced`, `off` |
| `focus` | What does it teach? | `concept` (default), `project`, `learn` |
| `cadence` | When does it ask? | `interleaved` (default), `end` |
| `difficulty` | How hard may the questions get? | `auto` (default), `easy`, `medium`, `hard` |

`difficulty` is the one that is normally *earned* rather than set: on `auto`, each project starts at `easy` and climbs. **`/eklavya:level` is the command for it** — send them there rather than explaining the ladder here, and only set it from this command if they explicitly asked to pin a level.

They combine freely. `enforced` + `learn` is an intern who must pass a gate on a topic they chose; `ambient` + `project` is a gentle nudge grounded in today's diff. The default pairing is `ambient` + `concept`: teach the idea, use today's code as the way in. `off` is the exception — it wins outright and `focus` is never read.

## No arguments

Call `get_config` and report the effective settings in two lines: mode and what it means, focus and what it means, then cadence and difficulty in a clause each. If `overridden_by_repo` is non-empty, say which settings this repo is overriding and where the file is — someone whose personal focus silently stopped applying needs to be told why, not left to guess.

Then offer the three focus choices below in one line each. Do not lecture.

## The three focus values

- **project** *(default)* — quizzes the code just written. Questions name the file, the line, the decision. Best when you are learning a codebase.
- **concept** — same subject matter, asked so the answer transfers. The diff becomes the motivation rather than the subject: *"we cached this for 60s — what class of problem does a TTL solve, and when is it the wrong tool?"* Best when you are learning a stack rather than a repo.
- **learn** — you name a topic; Eklavya teaches it in prerequisite order, whether or not today's work touches it. When the work *does* touch it, your real code becomes the worked example.

## The two cadence values

- **interleaved** *(default)* — one question mid-task, at the moment a concept is logged, while the code is still on screen. The end-of-task quiz then only asks for what is left of `max_questions_per_task`, which is a session budget rather than a batch size. This is the tool working as advertised: learning while the agent builds, not a pile of questions once it stops.
- **end** — no mid-task questions at all. Everything waits for the end of the task. Reach for it when someone is pairing, demoing, or genuinely cannot be interrupted — and mention `min_minutes_between_checkpoints` first, since spacing the questions out is usually what they actually want.

## Setting it

`set_config` with `focus`, and `focus_topic` when they chose `learn`. Ask for the topic if they picked `learn` without naming one — a `learn` focus with no topic teaches nothing, and the planner will refuse with `reason: "no_topic"`.

Scope matters and is worth one question when it is ambiguous:

- **global** (default) — their own setting, everywhere. This is where a personal `learn` topic belongs.
- **repo** — writes `.eklavya.json` at the repo root, and beats global for everyone working in it. This is where a lead pins `enforced` or `project` for onboarding.

Warn before writing `focus` at repo scope: it overrides every contributor's personal focus in that project, including a `learn` topic they set for themselves. That is sometimes exactly right, but it should be deliberate.

## Changing mode

Same tool, `mode` key. Follow `/eklavya:setup` step 4 if they move **to** `enforced` — the git `pre-commit` hook is what covers commits made outside Claude Code, and enforced mode without it only gates half the ways to commit.

## Confirm

Say the new state back in one line — `Mode: ambient. Focus: learn (caching). Cadence: interleaved. Difficulty: auto (easy on this repo).` — and what changes next time they build something. If they set `learn`, add that `/eklavya:learn` teaches the topic on demand rather than waiting for a task to touch it.
