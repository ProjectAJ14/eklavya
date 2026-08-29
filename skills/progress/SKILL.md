---
name: progress
description: Show the Eklavya mastery map — which projects you have been learning on, what those sessions actually taught, what you skipped, and what is due for review.
disable-model-invocation: true
---

# /eklavya:progress

Render the learning map. Read-only: do not quiz, do not teach.

1. `get_learner_profile` (no domain — you want everything).
2. `get_concept_graph` with `include_mastery: true` only if you need a domain's
   shape to explain something the profile already flagged. Usually you do not.
3. `get_gate_status` if the mode is `enforced`.

## What the report has to answer

In this order, because this is the order a learner asks them:

1. **Which project has this been happening on?** `projects` — repo, `answers`,
   `passed`, `last_active`. Show the basename, not the full path, unless two
   basenames collide. Compute accuracy yourself and show it as a percentage.
   A repo of `null` anywhere means work recorded before the repo column
   existed: label that row `unattributed`, never drop it and never guess.
2. **What have I actually learned?** `recent_concepts` — and lead with the
   `context` line, not the slug. `mason-lifecycle-hooks` means nothing;
   "moved `flutter create` into pre_gen so brick files overlay it" is the
   memory that makes the slug mean something. Slug second, in parentheses.
3. **What did I skip?** `skipped` — `declined` means they chose to pass,
   `dont_know` means they blanked and were taught. Say which. This is the
   actionable list: those come back a tier lower, so it is a backlog, not a
   scolding. If it is empty, say so in one clause; it is good news.
4. **What is due?** `due_for_review` — the count, then the slugs with their
   `tier_to_ask`. Already clamped to the level, so do not re-explain tiers.
5. **What is shaky?** `weak` — each with a one-clause gloss of what the concept
   actually is. A bare slug list is not a report.
6. **What is mastered?** `known_total`, then the most recent few. If it is 0,
   name the concepts closest to it instead (one more correct rep, not a first)
   — a zero with no runway attached reads as failure and it is not.

Finish with **one** concrete next step: `/eklavya:quiz` when anything is due,
`/eklavya:learn <topic>` when a domain the developer clearly works in is
mostly unseen.

Then one line pointing at `eklavya dashboard` — the same data as a local page,
with the history and the full concept list this report deliberately truncates.
Mention it once, at the end; it is the deeper view, not a replacement for
answering the question they just asked.

## How to render it

Keep it under 20 lines. A wall of statistics is not a progress report.

- **Lead with movement, not inventory.** The first line is the level, the
  project, and what changed. Counts of things that have not happened yet go
  last or nowhere.
- **Never draw a bar whose biggest segment is `unseen`.** A three-part
  known/learning/unseen bar on a new learner is a chart of absence: every row
  looks identical and the one number that moved is invisible. Per domain, one
  line: `general — 21 in progress, 0 mastered, 46 not yet seen`. Collapse
  domains with no activity at all into a single trailing line naming them.
- **Tables only when every column is populated for every row.** Two columns
  of zeros is prose pretending to be data.
- The seed catalogue is large on purpose. Never present the unseen count as a
  gap to close — nobody is meant to learn all 174 concepts, and framing it
  that way makes the honest numbers feel like failure.

## When there is nothing yet

If `projects`, `recent_concepts` and `attempts` are all empty, say so plainly
in two lines and suggest building something first — the tool has nothing to
show until there is work to ground it in. Do not render empty sections.
