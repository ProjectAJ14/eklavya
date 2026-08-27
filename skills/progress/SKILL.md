---
name: progress
description: Show the Eklavya mastery map — what the developer knows, what is shaky, and what is due for review.
disable-model-invocation: true
---

# /eklavya:progress

Render the learning map. Read-only: do not quiz, do not teach.

1. `get_learner_profile` (no domain — you want everything).
2. `get_concept_graph` with `include_mastery: true` for the two or three most active domains.
3. `get_gate_status` if the mode is `enforced`.

Present, briefly:

- **This project's level** — first, in one line: the band (`easy`, `medium`, `hard`), `passed`/`needed` passing answers toward the next one, and any other condition still short. It comes from the profile's `level` block. Say `pinned` if it is, and then no runway — a pinned level never promotes. This is per project, so name the repo if it is not obvious.
- **Per domain** — known / learning / unseen, as a count and a rough bar. Lead with the domain they have moved most in.
- **Due for review** — how many, and the specific slugs, with the tier each will be asked at. Those tiers are already clamped to the level above. This is the actionable part.
- **Weakest** — the `weak` list, with one clause each on what that concept actually is, so the slug means something.
- **Mastered** — `known_total`, and the most recent few from `known`. This is the part that makes the rest feel worth doing.
- **What to do next** — one concrete suggestion: `/eklavya:quiz` if things are due, `/eklavya:learn <topic>` if a domain is mostly unseen.

Keep it under 20 lines. A wall of statistics is not a progress report.

If nothing has been recorded yet, say so plainly and suggest building something first — the tool has nothing to show until there is work to ground it in.
