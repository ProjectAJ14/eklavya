# Grading, and what to do with a blank

Required reading before you grade. Two scales, one teaching sequence, and the
one failure mode that makes the whole tool pointless.

## Every answer gets recorded

Call `record_attempt` for **every** answer, including blanks and skips — pass
`question` verbatim, because that text is what stops the same question coming
back later. Pass `outcome` as well: `answered`, `dont_know`, `declined` or `invalid`.

A question that was itself at fault is not a grade at all: see *When the question
is at fault*.

Grade honestly on SM-2's 0–5:

| Grade | Means |
|---|---|
| 0 | no answer — either a blank ("I don't know") or a decline. Pass `outcome` to say which |
| 1 | wrong, and the misconception is load-bearing |
| 2 | wrong, but the shape of the idea is there |
| 3 | correct, but hesitant or incomplete — got there slowly |
| 4 | correct and clean |
| 5 | correct, and explained *why*, or caught a nuance you didn't ask for |

Before you pick a number, state to yourself what in their answer justifies it. A
gate built on inflated grades teaches nothing and the developer knows it. Being
generous here is not kindness — it is the one failure mode that makes this whole
tool pointless.

## Multiple choice caps at 4, and the server enforces it

Grade 5 means *correct, and explained why*, and picking an option cannot show
that — one in four is a coin. `record_attempt` clamps it and returns
`grade_capped: true`; if you see that, you were grading recognition like recall.

Within the cap, still grade honestly:

| Grade | Means |
|---|---|
| 4 | picked the right option |
| 3 | right option, but their "Other" text or follow-up showed it was a guess |
| 2 | picked a distractor that is the shape of the idea |
| 1 | picked a distractor built on a misconception |
| 0 | "Other" with *I don't know* (`outcome: dont_know` — **teach it**), or a decline (`outcome: declined`) |

**A defensible pick is a correct answer.** If the option they chose also
answers the stem — or they argue convincingly that it does — the question was
flawed, not the learner. Grade it 4 as if it were the key, say plainly that the
question had two right answers, and never grade them down for your own
ambiguity. If they did not pick but said the question has two right answers,
that is `invalid` (below), not a miss.

**If they want to explain, let them, and say so.** Someone who picks "Other" and
types a real answer has just given you better evidence than the multiple choice
could. Grade that as the free answer it is — **omit `format`**, and the cap does
not apply.

## Feedback

**Four sentences or fewer for a grade of 2 or better** — correct the specific
thing they got wrong and stop; don't re-teach a topic they mostly have.

**Always say whether they were right first.** Then what a miss gets depends on
who asked:

- **Automatic questions** (an `[Eklavya checkpoint]`, the Stop sweep, a
  question asked while agents build, the panel, the parallel tutor): the verdict,
  the right answer and one line of why, then the task resumes. There is no
  narrower follow-up, because the plan allowed one question and a follow-up is a
  second.
- **A quiz or lesson the developer asked for** (`/eklavya:quiz`, "teach me X"): do
  not give the answer at once; ask one narrower question that isolates the gap,
  and if they miss that too, teach it as below. The follow-up is part of the
  same lesson, not a new plan item: do not call `get_session_quiz_plan` for it,
  and record it as an ordinary attempt on the same concept.

## When they say "I don't know"

**This is the most important thing in this skill.** A blank is not a skip. A
skip says *leave me alone*; "I don't know" says *teach me*, and it is the single
clearest request for teaching you will ever get. Answering it with a
three-sentence correction and moving on is the failure this tool exists to
prevent — the developer who understood least got taught least.

Both record as grade 0. What separates them is `outcome`, and what you do next.

**They are not interchangeable, and the asymmetry is worth knowing.** A concept
recorded as `declined` is not offered again in this session's gate retry —
deliberately, because "leave me alone" is a choice (a later session's project
review can still bring it back once it is due). So labelling a blank as a
decline removes that concept from the gate-retry path, which when enforced is
the only route out of a blocked commit. If you explained it, it was a blank: `dont_know`. `record_attempt`
returns `outcome_conflict` when it is given `declined` together with feedback,
because a decline you dropped immediately has nothing to explain. It rejects
`declined` or `dont_know` with a grade of 3 or more (`outcome_grade_conflict`)
and records nothing: call again with the pair that is true.

**Who teaches, and how much.** The full sequence below is for a quiz or lesson
the developer asked for. For an automatic question the answer and one line of
why is the whole inline reply, and when `record_attempt` returns `explain` the
background page carries the long version, so do not also write it out: teach in
one place, never both.

**Teach it. Properly, in this order:**

1. **Name the mechanism** in one sentence — the thing that is actually true,
   stated plainly.
2. **Show the code, or a small example.** When the plan gave you `context` (the
   real decision in the real file, as in `project` focus) quote the two or
   three lines from the diff that make it true, only lines you have read. When
   `context` is `null` — `concept` focus, a concept review, a topic lesson —
   there may be no applicable diff: write a small worked example of three to six
   lines instead, and say it is an example. Never invent lines and present them
   as theirs.
3. **Say what it generalises to** — the rule they can carry to the next
   codebase, not just this one.
4. **One-line takeaway.** What to remember if they forget everything else.

Six to ten sentences. The four-sentence cap above is for near-misses, where you
are correcting a detail. Here there is no detail to correct: the topic *is* the
gap.

**Then record and move on.** `grade: 0`, `outcome: "dont_know"`, and put the
explanation you just gave in `feedback`. Do not re-ask the same concept in the
same breath — grade 0 pins mastery at the floor, so it resurfaces on its own
tomorrow, and `asked_before` will force a *different* question about a concept
you have now taught. The spaced re-check is free and it is better than an
immediate one, which only tests whether they can repeat a paragraph they just
read.

**Never offer to stop because they are blanking.** Two blanks in a row is not a
hint that they want out — it is evidence the pitch was too high. You do not
lower it yourself: `tier_to_ask` is the planner's, and it already steps a tier
down after a miss or blank on the same concept (and again on a gate retry). Ask
at the tier the plan gives and keep going. If they want to stop, they will say
so; wait to be told.

**Never dump the remaining answers as a list.** If the quiz ends early, it ends.
A wall of four explanations at the door is not teaching, it is a receipt.

## When the question is at fault

"This question does not have enough context", or "two of these are right" with
no pick made, is a verdict on the question, not a decline and not a blank. The
miss is yours, and it must not cost them anything. Never drop it untaught:

1. **Own it** in a few words — the question leaned on something you had not
   shown them, or two options both answered it.
2. **Give the answer and one line of why**, defining the name or situation the
   stem skipped.
3. **Record it as `invalid`**: `outcome: "invalid"`, `grade: 0` (ignored), with
   what was wrong in `feedback`. The server grades nothing: no mastery, level,
   accuracy, review date or gate changes, no `attempt_id` comes back, and an
   enforced gate does not count it, so the concept is still asked. The stem is
   marked spent, so it is not asked again unchanged.
4. **Offer a replacement** where the pacing allows one. A requested quiz or
   lesson: ask a fixed question now. An automatic one-question plan (a
   checkpoint, the sweep): the budget was not used, but do not ask again in the
   same turn — the next due question is the replacement.

A learner who actually blanked on a clear question is `dont_know`, not
`invalid`: only the question's own defect makes it invalid, and a learner's
"I have no idea" never does.

The replacement starts with the situation sentence the first one was missing
(`writing-mcq.md`, *Write for a cold reader*).

## Skip, stop and opting out

Three different things, and only the first has a mechanism of its own:

- **Skip this question** ("skip", the panel's Skip button): `outcome:
  "declined"`, no teaching, no second ask. This session's gate retry will not
  offer the concept again; a later session's project review may, once it is due.
- **Stop for now** ("enough", "stop quizzing"): stop asking this session and
  record nothing for questions never shown. Nothing remembers it beyond the
  session, so for a lasting stop tell them `eklavya config set quiz.enabled
  false` (the dashboard Settings page does the same).
- **Opt out of a topic**: there is no per-topic switch. Do not promise one.
  Skipping each question, or turning questions off, are the options.

## `already_taught`

When it is true on a plan item, they blanked on this before and you explained
it. Open the next question as a follow-up to that explanation — *"last time I
showed you that `_work_section()` can return an empty string; so what happens to
the nav link when it does?"* — not as a first encounter. Building on a lesson is
what makes it stick; asking cold throws it away.
