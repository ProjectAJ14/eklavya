# Question quality — one defensible answer per question

**2026-09-24** · eklavya at `4be74fe` plus this branch's uncommitted edits ·
**8 questions per run**, from the 3 question fixtures · generator and judge both
Claude Code's default model

## Why this run exists

A new learner reported that "3 out of 4 options are correct for some questions".
The cause was `writing-mcq.md`. One distractor source is "true, but not what was
asked", every distractor must be something a competent person could believe, and
nothing said that only one option may answer the stem. The judge counted
plausible distractors but not defensible ones, so it rewarded the defect.

The judge now also reports `defensible_distractors`: wrong options an expert
could argue also answer the stem. The target is 0.

## Method

`node eval/harness.mjs run --limit 8 --focus project --difficulty hard`, once
with the prompts on `main` and once after the edits. Both runs got the same
planner output (same slugs, tiers and slots). Each run was judged twice to
estimate how much the judge varies.

## Result

| | Before | After |
|---|---|---|
| Questions with one defensible answer (judge 1 / judge 2) | 3/8 · 3/8 | 7/8 · 6/8 |
| Defensible distractors (judge 1 / judge 2) | 5 · 5 | 1 · 2 |
| Plausible distractors (judge 1 / judge 2) | 16/24 · 18/24 | 16/24 · 14/24 |
| Keyed correctly | 8/8 | 8/8 |
| Passed every deterministic check | 7/8 | 6/8 |

A typical "before" failure: *"What makes retrying a failed write safe, in
general?"* One option marked wrong said "the database ignores a repeated write,
so a second attempt changes nothing". That describes idempotency, which is a
textbook answer to the question.

The one remaining case "after" uses a true statement ("the function returns the
same result whichever order the checks are in") as a wrong option.

## Caveats

- Eight questions per run, one generation per arm. The change in defensible
  distractors is large and matches across both judge passes; the others are not
  significant.
- Plausibility may have dropped slightly (16–18 to 14–16). Watch it on the next
  run.
- Both extra `stem_length` failures "after" came from narrowed stems (28 and 31
  words). The guide's advice to narrow the stem pulls against the 25-word
  limit.
- The same model family generates and judges.

## What would make this wrong

A second generation with the new prompts that falls back to about 3/8, or a
different judge model that finds the "after" distractors equally defensible.
