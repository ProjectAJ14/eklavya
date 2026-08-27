---
name: level
description: Show or pin Eklavya's difficulty level for this project — the easy/medium/hard band the questions are drawn from, and how far into it the developer is.
disable-model-invocation: true
---

# /eklavya:level [auto|easy|medium|hard]

Difficulty is a band, held **per project** and normally earned rather than chosen.

| Level | Tier band | The questions it asks |
|---|---|---|
| `easy` | 1–2 | what a thing is, and what the machine does with it |
| `medium` | 2–4 | why this choice here, and what breaks it |
| `hard` | 3–5 | judgement, failure modes, when the architecture is wrong |

Everyone starts a codebase at `easy`. That is the point: the developer has been *watching* the agent work, and tiers 1–2 are the questions that state can answer honestly. The band moves up on evidence — passing answers, at a real accuracy, spread across enough concepts — so week ten does not feel like week one.

It is per project because "how hard should this be" is a question about a codebase, not about a person. The same developer is a different learner on their fourth Node service and their first Rust one.

## No arguments

1. `get_learner_profile` — the `level` block has everything: the band, the next one, `passed` of `needed`, the accuracy so far and the concept spread.
2. `get_config` if you need to say whether it is pinned, and by which file.

Report it in three lines or fewer:

- **Where they are** — the level, and one clause on what that band asks for.
- **The runway** — `passed`/`needed` passing answers, plus whichever other condition is still short (accuracy, or distinct concepts). Say the number; a progress bar nobody can total is not progress.
- **What is next** — the band above, and what changes about the questions when they reach it. If they are on `hard`, say that this is the top and the tier ladder keeps working inside it.

If `pinned` is set, say who pinned it (global config or this repo's `.eklavya.json`) and that nothing will promote while it stands. Do not report a runway toward a level a pin makes unreachable.

## With an argument

`set_config` with `difficulty`.

- **`auto`** — back to earning it. The project's own record is still there; it resumes where its evidence left it.
- **`easy` / `medium` / `hard`** — pins the band and stops progression. A hard set, not a floor.

Scope, and ask when it is ambiguous:

- **global** (default) — their own setting on every project. `hard` here is a senior saying they do not want the runway.
- **repo** — `.eklavya.json` at the root, and it beats global for **everyone** working in that project. `easy` here is an onboarding codebase that stays gentle whoever opens it.

Two things to say plainly before writing:

- Pinning at repo scope overrides every contributor's personal setting in that project.
- Pinning `hard` on a codebase someone has just met is the failure levels exist to prevent. If they are pinning up because the questions feel trivial, check the level first — they may simply be near a promotion.

## Confirm

One line: the new setting, the band it means, and what the next question will look like. Then stop — do not run a quiz unless they ask. `/eklavya:quiz` is for that.
