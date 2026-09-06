# Question quality — first run

**2026-09-06** · eklavya at `a35e592`+ (branch `feat/prompt-submit-nudge`) ·
3 fixtures, 8 concepts · generator and judge both Claude Code's default model

## Method

`node eval/harness.mjs run --limit 3 --focus project --difficulty hard`.

The real `get_session_quiz_plan` handler against a throwaway home, so
`tier_to_ask`, `framing` and `answer_position` are the product's own decisions
rather than the harness's. The generator was given the shipped
`skills/tutor/SKILL.md` and `references/writing-mcq.md` verbatim. Full method
and the list of things that would disprove this: `eval/README.md`.

**Three questions.** Nothing below is significant. It is here because a first
run with its weaknesses written down is worth more than no run, and because it
found something.

## What would make this wrong

- Generator and judge are the **same model family**, so the judged half may be
  measuring the judge. Not yet run with a second model.
- The fixtures are this repo's own code, hand-labelled by the person who wrote
  it, so these concepts are cleaner than a stranger's codebase would be. Treat
  every number as an upper bound.
- n=3. The run-level rates below need tens of questions before they mean
  anything.
- Retention — whether anyone knows more a week later — is not measured here and
  cannot be, without a study with people in it.

## Deterministic checks

| Check | Result |
|---|---|
| `four_options` | 3/3 |
| `answer_at_position` | **3/3** |
| `stem_length` | 3/3 |
| `answer_not_in_stem` | 3/3 |
| `option_parity` | 3/3 |
| `correct_not_conspicuous` | **1/3** |
| `positive_form` | 3/3 |
| `options_not_numbered` | 3/3 |
| `no_settings_line` | 3/3 |

Clean on every check: **1 of 3**.

## Run-level, which no judge can see

| Property | Result | Baseline |
|---|---|---|
| answer slot 1 / 2 / 3 / 4 | 0 / 2 / 0 / 1 | even |
| correct option was the longest | **3 of 3 (100%)** | 25% |

## The one finding

**The correct option was the longest one every time.** Two of the three were
long enough for it to be visible — a four-word margin over the next-longest.

This is the tell `references/writing-mcq.md` explicitly warns about: *"A visibly
longer or more careful option reads as the correct one, and gets picked without
engaging — the same leak as always answering first."* The guidance is present,
in build order, in the file the generator was given, and the generator did it
anyway.

Not acted on. At n=3 the honest read is "worth measuring properly", not "the
pedagogy is wrong": 3 of 3 against a 25% baseline is p≈0.016 if length were
independent of correctness, but with three questions from one generator on one
fixture set, that arithmetic is worth less than it looks. **What would settle
it: 30+ questions across the fixture set. If the rate stays near 100%, the
recipe needs a construction step that forces parity — write the four options,
then trim the correct one to the median length — rather than a property to
check afterwards.**

## Judged

| Question | Result |
|---|---|
| answerable from what is shown | 3/3 |
| the option marked correct is correct | 3/3 |
| stem asks one thing | 3/3 |
| tier matched what was asked | 2 match, 1 below, 0 above |
| plausible distractors | **6 of 9** |

The judge's reasons were specific rather than generic, which is the minimum bar
for trusting a verdict at all — e.g. on the tier-3 hashing question it marked
the tier **below** what was asked, and named a distractor as believable because
*"'hash' reads as 'scrambled/unguessable', and a learner may conflate uniform
spread with unpredictability"*.

Two of nine distractors judged implausible is the number to watch next, and it
is the one thing here the deterministic half will never catch.

## What ran, and what did not

Question quality only. Loop behaviour and concept extraction are not built —
see the last section of `eval/README.md`, including the contamination trap that
any future with/without benchmark has to clear.
