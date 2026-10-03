# Question quality — questions a cold reader can answer

**2026-10-03** · eklavya at `fdee0ab` plus this branch's edits · **10 questions
per run**, from the 4 question fixtures · generator and judge both Claude Code's
default model

## Why this run exists

A review of 187 real questions found that stems relying on unexplained project
context ("Task 6", "the brief", a component nickname) were answered correctly
19% of the time, against 50% for self-contained stems. Background agents now
write most of the code, so the learner usually never sees the diff the tutor is
quoting.

The judge could not see this. It was shown the diff and told the question was
for "a developer who watched an agent write the code", so `answerable` always
had context the learner lacked. The judge now makes a second, cold call that
sees only the stem and the four options, with no code, no concept description
and no keyed answer. It reports `answerable_cold` and lists the
`unexplained_names` it would need explained.

## Method

`node eval/harness.mjs run --limit 10 --focus project --difficulty hard`, twice
per arm. The baseline ran in a worktree at `fdee0ab` with this branch's `eval/`
(the new judge, the new fixture and the new generator heading), so the two arms
differ only in `skills/tutor/`. Each run was judged twice.

A fourth fixture, `plan-jargon-in-context`, was added for this. Its logged
`context` lines use the plan's own words, as a builder writes them: "Task 6 of
the plan moves the DELEGATE line...", "per the brief, the island now...". The
other three fixtures carry only code, so they cannot produce that failure.

The first candidate prompt raised `answerable_cold` but wrote 26–30-word setups
and dropped the constraints that had made the key the only answer (for
example, "pick a random bucket and save it" became a valid way to give each
item a stable bucket once "no stored state" was gone). The guide was revised
once, to a hard 25-word single setup sentence and a "drop the name, keep the
constraint" rule. The numbers below are for the revised prompt.

## Result

| | Before (run 1 · run 2) | After (run 1 · run 2) |
|---|---|---|
| Answerable cold (judge 1 / judge 2) | 7/10 · 10/10 / 7/10 · 10/10 | 10/10 · 10/10 / 10/10 · 10/10 |
| Answerable with the code shown | 10/10 · 10/10 | 10/10 · 10/10 |
| Defensible distractors (judge 1 / judge 2) | 0 · 2 / 0 · 2 | 2 · 3 / 2 · 3 |
| Tier match (judge 1) | 8 · 8 | 8 · 8 |
| Plausible distractors (judge 1) | 19/30 · 21/30 | 18/30 · 21/30 |
| Keyed correctly (judge 1) | 10/10 · 10/10 | 10/10 · 10/10 |
| Passed every deterministic check | 7/10 · 9/10 | 8/10 · 10/10 |

The three cold failures before were all names lifted from the code:
*"…as `retryOnBusy` does here?"*, *"The nudge packs three small values into one
`meta` row…"* and *"Why does `answerPosition` hash the question text…?"*. The
first judge called all three answerable because it had the diff.

## Caveats

- **Defensible distractors rose from 2 to 5 of 60**, and both judge passes agree,
  so this is not judge noise. The issue's acceptance asks for no drop on this
  measure, and it is not met. Most of the five are row-two distractors (true,
  but not what was asked), such as "cheap checks first also reads better". A
  stem that describes a general situation makes more true statements answer
  it. The judge called several only "partly defensible".
- Twenty questions per arm, two generations each. The cold gain comes from one
  baseline run, and the other baseline run was already 10/10.
- Neither arm used "Task 6" or "the brief" in a stem, even though the new
  fixture handed both the phrases. These fixtures are a single file and one
  logged line. A real session has a plan, a task list and a conversation, so the
  live failure rate is higher than this harness can show.
- The same model family generates and judges.

## What would make this wrong

A cold judge from a different model family that finds the "after" stems no
easier to answer, or a live session in which the tutor still opens with an
unexplained plan name.
