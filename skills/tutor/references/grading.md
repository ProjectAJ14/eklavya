# Grading, and what to do with a blank

Required reading before you grade. Two scales, one teaching sequence, and the
one failure mode that makes the whole tool pointless.

## Every answer gets recorded

Call `record_attempt` for **every** answer, including blanks and skips — pass
`question` verbatim, because that text is what stops the same question coming
back later. Pass `outcome` as well: `answered`, `dont_know`, or `declined`.

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

**If they want to explain, let them, and say so.** Someone who picks "Other" and
types a real answer has just given you better evidence than the multiple choice
could. Grade that as the free answer it is — `format: "open"`, and the cap does
not apply.

## Feedback

**Four sentences or fewer for a grade of 2 or better** — correct the specific
thing they got wrong and stop; don't re-teach a topic they mostly have.

If they answer and get it wrong, do not immediately give the answer. Ask one
narrower question that isolates the gap. If they miss that too, teach it as
below.

## When they say "I don't know"

**This is the most important thing in this skill.** A blank is not a skip. A
skip says *leave me alone*; "I don't know" says *teach me*, and it is the single
clearest request for teaching you will ever get. Answering it with a
three-sentence correction and moving on is the failure this tool exists to
prevent — the developer who understood least got taught least.

Both record as grade 0. What separates them is `outcome`, and what you do next.

**Teach it. Properly, in this order:**

1. **Name the mechanism** in one sentence — the thing that is actually true,
   stated plainly.
2. **Show the code.** Quote the two or three real lines from the diff that make
   it true. They are looking at a file they have never read; the lines are the
   whole lesson.
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
hint that they want out — it is evidence you are pitching too high. Drop a tier
and keep going. Tier-1 recall on something you have just explained is fair, and
it rebuilds footing. If they want to stop, they will say so; wait to be told.

**Never dump the remaining answers as a list.** If the quiz ends early, it ends.
A wall of four explanations at the door is not teaching, it is a receipt.

## `already_taught`

When it is true on a plan item, they blanked on this before and you explained
it. Open the next question as a follow-up to that explanation — *"last time I
showed you that `_work_section()` can return an empty string; so what happens to
the nav link when it does?"* — not as a first encounter. Building on a lesson is
what makes it stick; asking cold throws it away.
