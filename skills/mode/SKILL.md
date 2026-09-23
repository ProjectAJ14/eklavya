---
name: mode
description: Show or change how Eklavya teaches — whether it quizzes at all and whether it gates commits (quiz.enabled, quiz.enforced), the focus (project, concept, learn), the cadence (interleaved, end) and the difficulty (auto, easy, medium, hard).
disable-model-invocation: true
---

# /eklavya:mode [on|off|enforced|project|concept|learn|interleaved|end] [topic] [--session]

Eklavya has **independent switches**, and conflating them is the most common confusion. Say which one you are changing.

| Setting | Question it answers | Values |
|---|---|---|
| `quiz.enabled` | Does it ask questions at all? | `true` (default), `false` |
| `quiz.enforced` | Do unanswered questions hold commits? | `false` (default), `true` |
| `focus` | What does it teach? | `concept` (default), `project`, `learn` |
| `cadence` | When does it ask? | `interleaved` (default), `end` |
| `difficulty` | How hard may the questions get? | `auto` (default), `easy`, `medium`, `hard` |
| `memory.enabled` | Is the work recorded and recalled? | `true` (default), `false` |

**`quiz` and `memory` are separate, and this is the thing to get right.** Turning the questions off does not stop Eklavya recording what the session did — that is `memory.enabled`, and it is a deliberate second decision. Someone who says "turn Eklavya off" has usually asked for silence, not amnesia: set `quiz.enabled: false` and tell them memory is still running, rather than switching both and losing their history. If they want everything off, they will say so, and then it is both.

These replaced a single `mode` dial whose values were `ambient`, `enforced` and `off`. Configs still using it keep working — `off` reads as `quiz.enabled: false`, `enforced` as `quiz.enforced: true` — but do not write it. `off` is exactly the word that made people believe their memory had stopped.

`difficulty` is the one that is normally *earned* rather than set: on `auto`, each project starts at `easy` and climbs. **`/eklavya:level` is the command for it** — send them there rather than explaining the ladder here, and only set it from this command if they explicitly asked to pin a level.

They combine freely. `quiz.enforced` + `learn` is an intern studying a topic they chose who still passes a gate on the day's work before committing — while the gate is open the plan serves the work, and the topic resumes once it passes; unenforced + `project` is a gentle nudge grounded in today's diff. The default pairing is unenforced + `concept`: teach the idea, use today's code as the way in. `quiz.enabled: false` is the exception — it wins outright, `focus` is never read, and it forces `quiz.enforced` off with it, since a gate nothing asks questions for could never be passed.

## No arguments

Call `get_config` and report the effective settings in two lines: whether questions are on and whether they gate commits, focus and what it means, then cadence and difficulty in a clause each. **Say whether memory is on in the same breath** — it is the setting people most often assume follows the others. If `overridden_by_project` is non-empty, say which settings this project is overriding and where the file is: someone whose global focus silently stopped applying needs to be told why, not left to guess.

Then offer the three focus choices below in one line each. Do not lecture.

## The three focus values

- **project** — quizzes the code just written. Questions name the file, the line, the decision. Best when you are learning a codebase.
- **concept** *(default)* — same subject matter, asked so the answer transfers. The diff becomes the motivation rather than the subject: *"we cached this for 60s — what class of problem does a TTL solve, and when is it the wrong tool?"* Best when you are learning a stack rather than a repo.
- **learn** — you name a topic; Eklavya teaches it in prerequisite order, whether or not today's work touches it. When the work *does* touch it, your real code becomes the worked example.

## The two cadence values

- **interleaved** *(default)* — one question mid-task, at the moment a concept is logged, while the code is still on screen. A quiz is capped at one question under this cadence, the end-of-task sweep included — except when `quiz.enforced` is set, where the gate needs a full round, and when the developer asked for a quiz themselves — and it draws on `max_questions_per_task`, which is a session budget rather than a batch size. This is the tool working as advertised: learning while the agent builds, not a pile of questions once it stops.
- **end** — no mid-task questions at all. Everything waits for the end of the task. Reach for it when someone is pairing, demoing, or genuinely cannot be interrupted — and mention `min_minutes_between_checkpoints` first, since spacing the questions out is usually what they actually want.

## Setting it

`set_config` with `focus`, and `focus_topic` when they chose `learn`. Ask for the topic if they picked `learn` without naming one — a `learn` focus with no topic teaches nothing, and the planner will refuse with `reason: "no_topic"`.

Scope matters and is worth one question when it is ambiguous:

- **global** (default) — their own setting, everywhere. This is where a personal `learn` topic belongs.
- **project** — writes `~/.eklavya/projects/<checkout>/config.json`, and beats global whenever they work in that codebase. This is where `quiz.enforced` or `focus: project` goes for a codebase they are new to. (`repo` is accepted as the older name for this scope.)

**Nothing is written into the repository.** Project settings are per developer: they are in the developer's own home directory, keyed by the checkout's path, and no teammate ever sees them. Say so if they ask about sharing — what a team can share is a concept pack, not settings.

Mention when writing `focus` at project scope that it overrides the `learn` topic they set for themselves, in that codebase only. That is sometimes exactly right, but it should be deliberate.

## Turning the gate on

Same tool, `quiz: { enforced: true }`. Follow `/eklavya:setup` step 4 when they move **to** enforcement — the git `pre-commit` hook is what covers commits made outside Claude Code, and the gate without it only covers half the ways to commit.

## "Turn it off for this session"

**Hear this phrasing — "for now", "for this session", "I'm in the middle of something", `--session` — and use `set_config` with `scope: "session"` and `quiz: { enabled: false }`.** Not global scope. Global is a file, the file outlives the afternoon, and a developer who silenced one urgent hour in April finds out in June that they turned the questions off for good. Session scope writes nothing: every question, checkpoint, banner and status bar stops until this session ends, and it forgets by itself.

It takes `quiz` and nothing else. `quiz: { enabled: true }` at that scope brings the session back — that is what "turn Eklavya back on" does — and the file-backed settings are whatever they always were. **Memory has no session switch at all**, deliberately: a day of work nobody recorded is a day nobody can look up later, and the request was for quiet, not for a hole in the history. Say so if they ask.

Say one line back — including *which* session it acted on if `set_config` reports a `session_id` you did not pass — and say the limit in it when `quiz.enforced` is set: the questions are silenced, but the commit gate reads the project config and never sees a session id, so a commit still waits for the quiz, and it keeps growing while you work in silence. Someone who wants that gone wants a project or global change, and that is a different, deliberate decision — `set_config` returns a `note` saying so.

Nothing is lost while a session is silent: concepts logged stay unmastered, and a later session offers them again once its own work and review debt are covered.

## Confirm

Say the new state back in one line — `Questions: on. Focus: learn (caching). Cadence: interleaved. Difficulty: auto (easy on this repo). Memory: on.` — and what changes next time they build something. If they set `learn`, add that `/eklavya:learn` teaches the topic on demand rather than waiting for a task to touch it.
