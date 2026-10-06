# Question quality — the correct option's description gave the answer away

**2026-10-06** · eklavya at `e15bf58` plus this branch's edits · **10 questions
per run**, from the 4 question fixtures · generator and judge both Claude Code's
default model

## Why this run exists

In a local learner database, the correct option had the strictly longest
`description` in 10 of 10 first-try MCQ attempts that stored option notes
(issue #118). A learner can pick the most carefully explained option without
knowing the concept. The tutor guide asked for parity between option labels
only, and the harness never asked the generator for descriptions, so nothing
measured this.

Re-measured with the new `eval history` rate on the maintainer's learner
database at the time of this change: the correct description was the single
longest in **27 of 30** recorded questions (90%), the correct label in 12 of 30
(40%).

## Method

The generator now returns a `descriptions` array, one per option, and both
judges see each description next to its option, as the learner does. `score`
adds a per-question check, `description_not_conspicuous` (the correct
description is fewer than 3 words longer than the next-longest), and a run rate,
"correct description was the longest", against a 25% chance baseline.

`node eval/harness.mjs run --limit 10 --focus project --difficulty hard`, twice
per arm. Every arm used this branch's `eval/`, so the arms differ only in
`skills/tutor/references/writing-mcq.md`. The baseline runs read the guide
before it was edited.

Two wordings were tried. The first said the correct description must not be
the longest and should be written last, to the others' length. It cut the rate
to 1 of 20 (5%), well **below** chance, which is a tell of its own: a learner
who notices it can rule out the longest note. The shipped wording asks for no
description to stand out as either the longest or the shortest, and says why
overcorrecting is a tell.

## Result

| | Before (run 1 · 2) | First wording (run 1 · 2) | Shipped wording (run 1 · 2) |
|---|---|---|---|
| Correct description strictly longest | 6/10 · 8/10 (70%) | 1/10 · 0/10 (5%) | 1/10 · 1/10 (10%) |
| `description_not_conspicuous` passed | 4/10 · 4/10 | 10/10 · 10/10 | 10/10 · 10/10 |
| Correct label strictly longest | 1/10 · 2/10 (15%) | 3/10 · 3/10 (30%) | 2/10 · 3/10 (25%) |
| Passed every deterministic check | 4/10 · 3/10 | 9/10 · 9/10 | 9/10 · 10/10 |
| Plausible distractors | 23/30 · 26/30 | 24/30 · 19/27 | 23/30 · 20/27 |
| Defensible distractors | 0 · 2 | 0 · 0 | 0 · 0 |
| Answerable cold | 10/10 · 10/10 | 10/10 · 9/9 | 9/9 · 9/9 |
| Keyed correctly | 10/10 · 9/10 | 9/10 · 9/9 | 9/10 · 8/9 |

The issue's acceptance bar is a longest-option rate of roughly chance (≤ 35%).
With the shipped wording the description rate is 10% and the label rate 25%.

## Caveats

- In the baseline the correct description beat the next-longest by 3 to 11
  words, so the leak is in the descriptions, not the labels, as the live data
  showed.
- 10% is still below the 25% chance rate. At 20 questions per arm the gap from
  chance is not significant, but if live history settles well below a quarter,
  that is the inverse tell described above.
- Every mis-keyed question in every arm is the same fixture,
  `busy-timeout-versus-retry`: the key explains SQLite's rollback-journal
  locking when the code runs in WAL mode. It appears before and after this
  change, so it is a content problem with that concept, not a length effect.
- Descriptions run 20–40 words in every arm, longer than the "one clause" the
  guide asks for. This change evens them out; it does not shorten them.
- Plausible distractors: 49/60 before and 43/57 under the shipped wording.
- Three judge calls failed (one unparsable, one timed out, one unparsable cold
  read), so some runs are out of 9.
- One stem exceeded the word limit in four of the six runs; unrelated.
- One generator and judge family.

## What would make this wrong

`npm run eval -- history` on attempts recorded after this ships showing the
correct description as the longest far from a quarter of the time, in either
direction.
