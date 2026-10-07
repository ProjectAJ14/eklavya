# Tutor question eval around the quiz side panel (2026-10-07)

Command, from the repository root, every run: `npm run eval -- run --limit 8 --focus project --difficulty hard`.
The harness plans with the real planner, then generates each question from the **shipped**
`skills/tutor/SKILL.md` and `references/writing-mcq.md`, scores it deterministically and has a
model judge it. The raw run directories are git-ignored scratch; this file is the record.

What changed in the tutor text for this PR:

- `skills/tutor/SKILL.md`: a few sentences naming `present_question` and `presentation: "panel"`
  next to the `AskUserQuestion` instruction (the file stays under its 2,000-word cap).
- `skills/tutor/references/panel.md`: new; read only when the plan says `"panel"`.
- Runs 3 and 4 ran with the panel instructions still inside `writing-mcq.md`; the file is identical to
  `main` again for runs 1, 2 and 5 and for the commit that ships.

The planner's output for the eight fixture items (concepts, tiers, answer slots) was identical in
every run.

| Run | Tutor text | Generated | Passed every check | Slot adherence | Correct option longest | Judge: answerable / keyed right | One defensible answer | Tier below plan |
|---|---|---|---|---|---|---|---|---|
| 1 before (`3a461db`) | pre-panel | 5 of 8 | 3 of 5 | 5 of 5 | 1 of 5 | 3/3, 3/3 | 3 of 3 | 0 of 3 |
| 2 before (`3a461db`, second run) | pre-panel | 8 of 8 | 3 of 8 | 7 of 8 | 2 of 8 | 8/8, 8/8 | 6 of 8 | 0 of 8 |
| 3 after | panel text in `writing-mcq.md` | 8 of 8 | 5 of 8 | 8 of 8 | 5 of 8 | 7/7, 7/7 | 7 of 7 | 2 of 7 |
| 4 after (same code, second run) | panel text in `writing-mcq.md` | 8 of 8 | 6 of 8 | 8 of 8 | 1 of 8 | 8/8, 8/8 | 5 of 8 | 3 of 8 |
| 5 after (shipped text) | panel text in `panel.md` | 6 of 8 | 2 of 6 | 4 of 6 | 2 of 6 | 6/6, 6/6 | 3 of 6 | 1 of 6 |

How to read it:

- **No difference the checks can see.** Passing every check was 6 of 13 before and 13 of 22 after.
  Runs 3 and 4 are the same code and differ from each other by as much as either differs from the
  baseline (correct option longest 5 of 8 against 1 of 8; stem length 7 of 8 against 8 of 8).
  `description_not_conspicuous` and `correct_not_conspicuous` fail in both columns, so they were
  present before this change.
- **Two numbers lean the wrong way and are not explained away.** The judge called 6 of 21 "after"
  questions easier than the planned tier against 0 of 11 before, and found one defensible answer in
  15 of 21 against 9 of 11. Both are judge opinions on small samples, the "after" runs vary widely
  among themselves, and the tutor text that shipped differs from the baseline only by a few sentences
  about a tool the card path never calls. They are not evidence of a regression and not evidence of
  none: a larger sample, with the baseline run as many times as the "after", would settle it.
- Slot adherence in run 5 (4 of 6) is the lowest of the five; runs 1 to 4 were 5 of 5, 7 of 8, 8 of 8
  and 8 of 8. Two generation failures per run happen in the baseline too (run 1 lost 3).

Limitations: five runs, eight items each, one fixture project, one generating model and one judge
model, with run-to-run noise as large as the differences measured. A tutor-behavior claim about the
panel itself (a model calling `present_question` correctly) is not covered by this harness, which
exercises the card path; that is checked in the live acceptance transcript instead.
