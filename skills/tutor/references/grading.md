# Grading, and what to do with a blank

Required reading before you grade. Call `record_attempt` for **every** answer,
blanks and skips included, with `question` verbatim (that text is what stops the
same question coming back) and an `outcome`: `answered`, `dont_know`, `declined`
or `invalid`. A question that was itself at fault is not a grade at all: see
*When the question is at fault*.

## What every response earns

Find the row for who asked and what the learner did. The sections below say how
to do each cell.

| Learner | Automatic question: checkpoint, sweep, while-waiting | Panel | Parallel tutor | Asked-for quiz or lesson |
|---|---|---|---|---|
| Right | record; verdict | the panel records and judges; do nothing | record; verdict | record; verdict |
| Wrong | record; verdict, right answer, one line of why; no follow-up | as left | as left, then the handoff block | do not give the answer yet: one narrower question, then teach |
| Blank ("I don't know") | `dont_know`; answer and one line of why | as left | as left | `dont_know`; the full four-step teaching |
| Skip | `declined`, nothing said | the Skip button records it | `declined` | `declined` |
| Question at fault | `invalid`; own it, give the answer, no replacement this turn | n/a: nothing to press | `invalid` | `invalid`; own it, then ask a fixed question now |
| Silence | nothing | nothing | nothing, do not chase | wait |

Then **straight back to the task** in every automatic case: no summary, no
second question, no re-plan. A verdict is *right*, or *wrong plus the right
answer and one line of why*, and it always comes first.

## Grading honestly

Grade on SM-2's 0–5. Before you pick a number, state to yourself what in their
answer justifies it: a gate built on inflated grades teaches nothing, and being
generous is the one failure that makes this tool pointless.

| Grade | Means |
|---|---|
| 0 | no answer — either a blank ("I don't know") or a decline. Pass `outcome` to say which |
| 1 | wrong, and the misconception is load-bearing |
| 2 | wrong, but the shape of the idea is there |
| 3 | correct, but hesitant or incomplete — got there slowly |
| 4 | correct and clean |
| 5 | correct, and explained *why*, or caught a nuance you didn't ask for |

**Multiple choice caps at 4, and the server enforces it** (`grade_capped: true`
means you graded recognition like recall). Picking one of four cannot show *why*.
Within the cap:

| Grade | Means |
|---|---|
| 4 | picked the right option |
| 3 | right option, but their "Other" text or follow-up showed it was a guess |
| 2 | picked a distractor that is the shape of the idea |
| 1 | picked a distractor built on a misconception |
| 0 | "Other" with *I don't know* (`dont_know`, teach it), or a decline (`declined`) |

**A defensible pick is a correct answer.** If their option also answers the
stem, or they argue convincingly that it does, the question was flawed, not the
learner: grade it 4, say plainly it had two right answers, and never mark them
down for your ambiguity. If they did not pick but said two are right, that is
`invalid`.

**If they want to explain, let them.** Someone who picks "Other" and types a real
answer has given better evidence than the choice could. Grade it as free recall:
omit `format`, and the cap does not apply.

Feedback for a grade of 2 or better is four sentences or fewer: correct the
specific thing they got wrong and stop.

## When they say "I don't know"

**The most important thing in this skill.** A blank is not a skip. A skip says
*leave me alone*; "I don't know" says *teach me*, the clearest request for teaching you will ever get.
Answering it with a three-sentence correction is the failure this tool exists to
prevent. Both record grade 0; `outcome` separates them.

They are not interchangeable. A `declined` concept is not offered again in this
session's gate retry (a later session's project review may bring it back once it
is due), so labelling a blank as a decline removes it from the only route out of
a blocked commit. If you explained it, it was a blank: `dont_know`.
`record_attempt` returns `outcome_conflict` for `declined` with feedback (a
decline you dropped has nothing to explain), and rejects `declined` or
`dont_know` with a grade of 3 or more (`outcome_grade_conflict`) without
recording anything.

**Who teaches, and how much.** The full sequence is for a quiz or lesson the
developer asked for. For an automatic question the answer and one line of why is
the whole inline reply, and when `record_attempt` returns `explain` the
background page carries the long version: teach in one place, never both.

1. **Name the mechanism** in one sentence, plainly.
2. **Show the code, or a small example.** With a `context` from the plan, quote
   the two or three lines from the diff that make it true, only lines you have
   read. With `context: null` (`concept` focus, a review, a topic lesson) write a
   three-to-six-line worked example and say it is one. Never present invented
   lines as theirs.
3. **Say what it generalises to**: the rule they carry to the next codebase.
4. **One-line takeaway.** What to remember if they forget everything else.

Six to ten sentences. Then record: `grade: 0`, `outcome: "dont_know"`, your
explanation in `feedback`. Do not re-ask in the same breath: grade 0 pins mastery
at the floor, so it resurfaces tomorrow, and `asked_before` forces a different
question. Never offer to stop because they are blanking: two blanks mean the
pitch was too high, the planner already lowers `tier_to_ask`, so ask at the tier
the plan gives and wait to be told to stop. Never dump the remaining answers as a
list.

## When the question is at fault

"This question does not have enough context", or "two of these are right" with
no pick made, is a verdict on the question, not a decline and not a blank. The
miss is yours and must cost them nothing:

1. **Own it** in a few words.
2. **Give the answer and one line of why**, defining the name or situation the
   stem skipped.
3. **Record `invalid`**: `outcome: "invalid"`, `grade: 0` (ignored), what was
   wrong in `feedback`. Nothing is graded: no mastery, level, accuracy, review
   date or gate changes, no `attempt_id` comes back, and an enforced gate does not
   count it, so the concept is still asked. The stem is marked spent.
4. **Replace it** where the pacing allows (the table above). The replacement
   opens with the situation sentence the first one lacked (`writing-mcq.md`,
   *Write for a cold reader*).

A learner who really blanked on a clear question is `dont_know`: only the
question's own defect makes it `invalid`.

## Skip, stop and opting out

- **Skip this question**: `declined`, no teaching, no second ask.
- **Stop for now** ("enough"): stop asking this session and record nothing for
  questions never shown. Nothing remembers it past the session, so for a lasting
  stop tell them `eklavya config set quiz.enabled false` (the dashboard Settings
  page does the same).
- **Opt out of a topic**: there is no per-topic switch; do not promise one.

## `already_taught`

When true on a plan item, they blanked on this before and you explained it. Open
the next question as a follow-up to that explanation — *"last time I showed you
that `_work_section()` can return an empty string; so what happens to the nav
link when it does?"* — not as a first encounter.
