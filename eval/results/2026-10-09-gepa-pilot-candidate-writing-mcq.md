# Writing the question

Required reading before you write a question. `SKILL.md` decides *whether* to
ask and *at what tier*; this is how to build the thing itself.

## Write for a cold reader

Assume the learner saw none of it: not the code, not the plan, not the task
list, not the conversation. A background agent usually writes the code, so the
diff you are looking at is one they have never opened. The question has to work
from the stem and the four options alone.

- **Every project-specific name gets a defining clause, or goes.** "Task 6",
  "the brief", "the plan", "the island", a component nickname, a file they never
  opened: each one is a puzzle the learner must solve before the real question.
  Say what it is — *"the hook that runs when a session starts"* — or ask
  without it.
- **The key follows from the concept, never from something only you
  observed.** A finding in a write-up they never read, the data from one
  session, your own experiment, the keyframes in a file they never opened: a
  question whose answer depends on these is unfair, not hard. If the key is a
  project-specific number, threshold or design choice the learner could only
  know by reading the code, ask about the general concept instead.
- **Situations beat abstractions.** A stem with no host, no situation and no
  example cannot be placed. Name the setting in plain words.
- **Drop the name, keep the constraint.** The project's details are often what
  made the key the only right answer: *no stored state*, *runs on every prompt*,
  *one writer*. When you replace a name with a general situation, carry those
  constraints into it, or a distractor that was wrong in the project becomes
  right in the abstract.

> Opaque: *Task 6 moves the instruction from SessionStart to UserPromptSubmit.
> What does that change?*
>
> Cold: *A Claude Code hook can inject text once when a session starts, or on
> every prompt the user sends. Why move a reminder to the per-prompt hook?*

## Build it in this order

Six parts, then the call. Build them in the order below — not the order they
appear on screen — because each one constrains the next.

**1. The stem.** Two parts, grounded per the plan's `framing`:

- **The situation** — one plain sentence of 25 words or fewer, saying what is
  happening and defining any name the question uses. One sentence, not two:
  if it will not fit, the question is carrying more setup than one idea needs.
  Leave it out when the question already stands on its own.
- **The question** — one question about one idea, **25 words or fewer, counted
  on its own, separately from the situation**. A situation does not borrow from
  the question's budget or the other way round. Count the words before you send;
  a 27-word question fails. If it is long, drop a clause (the clause usually
  belongs in the situation, or nowhere). The answer lives in the options, so
  the question asks and stops.

Ordinary words: "sent with the request" rather than "transmitted alongside the
request context". Expand an acronym the first time it appears for this learner —
CSRF once, then CSRF. The situation sets the scene and never hints at the
answer.

Ask the positive form, and ask it once: negation makes the stem a reading test
rather than a question about the idea, and a stem needing a second clause to be
precise is doing two jobs — ask the first one and keep the other for later.
Do not cram "why X, kept alongside Y" into one sentence: put the setting in the
situation and ask a short question.

> Why is `httpOnly` set on the refresh cookie here but not on the access token?

**2. The correct option.** Write it before the distractors. It sets the length
and the grammar the other three have to match.

Each option is a complete claim on its own: read alone, it says something that
is true or false. "Re-point from an ancestor" or "How often, and how recent" is
a riddle, not an option. Keep the whole option **short**: label (the claim)
about 8–14 words. The label carries the claim; do not pad it with a second
clause of "so that…" consequences. Do not cut the correct option to a stub to
save words either: a short option still states its claim in full.

**3. Three distractors**, each drawn from one of these:

| Source | Written against the stem above |
|---|---|
| the right answer to an *adjacent* concept | "It stops the cookie going to another origin" — true of `SameSite`, not this |
| true, but not what was asked | "The access token is short-lived, so it expires quickly" — true, and not why the flag is there |
| the misconception you would correct in review | "It encrypts the value, so an attacker cannot read it" |
| right mechanism, wrong direction or actor | "It stops the *server* reading the cookie, so only the browser can" |

Every row answers the stem as printed. Row two is the one to get right: it is
the only source whose option must be a **true** statement, and swapping in a
false claim about a neighbouring flag collapses it into row one — leaving three
sources instead of four, and making a learner who had the shape right
indistinguishable from one holding a misconception when you come to grade it.

Each one should be something a competent person who half-knows the topic could
believe. A distractor that contradicts the purpose of the thing, describes
behaviour nothing in the situation could produce, or is nonsense on its face
(an index that forces full scans, a cap that blocks unrelated logging) is a free
point and teaches nothing. Test each: "would a learner with a partial grasp be
tempted?" If not, replace it with a near-miss from a different row. When three
that good will not come, the stem is too vague to have a near-miss: rewrite the
stem and the distractors follow.

**Exactly one option answers the stem.** Plausible is not the same as
defensible: a distractor must be believable *and wrong as an answer to this
question*. Row two is where this breaks — a true statement answers most "why"
stems well enough, and a learner who picks it is marked wrong for being right.
Before asking, read each distractor as if it were the key: if a senior reviewer
could argue for it, narrow the stem ("why *here*", "what does *this line*
prevent") until it cannot, or replace it with a different row. Also confirm the
key really is true and really answers the stem as printed.

**4. One neutral clause of `description` per option.** The learner reads it
before answering, so it says what the option *does or claims*, never whether it
is right, why it is tempting or which misconception it is. "Tempting because…",
"a common mistake" and "this is why it works" are feedback, and feedback comes
after the answer.

Budget: label plus description together, about **20–26 visible words per
option**, never more than 30. The description is a short clause (about 8–12
words) that adds one concrete detail; it must not repeat the label or restate it
in other words. Do not write descriptions that explain a mechanism step by step.

Judge parity on what is on screen: the label and its description together. Give
every option the same grammar, the same number of claims and the same kind of
detail. Do not keep the mechanism, the example or the caveat for the correct
one. If options differ in length, shorten the long ones first and lengthen the
short ones only with real content, never filler. The correct option should not
be the longest, and it should not be systematically the shortest either: that
is a tell in the other direction. The server and the `ask-label` hook send back
an option that outruns the next by a few words, or whose description explains
itself, once; rewrite it and ask again.

The reasoning behind each option goes in `option_notes` when you record the
attempt (the card path) and in the panel's `explanation` (the panel path), both
shown only after the answer.

**5. Placement.** The plan gives each question an `answer_position`, 1 to 4.
**Put the correct option in exactly that slot** — slot 4 means the fourth option
in the list, not the first. Do this mechanically: write the three distractors,
then insert the key at index `answer_position`. Before sending, re-read the list
and check the key is in that slot and that `correct` matches it. Left to your
own judgement you will put the right answer first nearly every time, and a
learner needs only a handful of questions to notice that and start picking A
without reading; the quiz keeps looking fine and stops measuring anything. A
question whose key is in the wrong slot is a failed question however good the
rest is.

**6. `header`.** Set it to `Eklavya`, and then **do what the plan's
`ask_attribution` says** — it is the rule for the host you are actually running
on, and this file cannot be.

In a terminal the chip is the only thing on screen saying who is asking, and the
stem stays clean. Claude Desktop draws a question card with no chip in it, so
there `ask_attribution` asks for `[Eklavya]` on its own line above the stem
instead; the status bar that carries the dials does not exist there either.
Either way a question arriving mid-task with no attribution reads as Claude
going off-piste, and the developer answers a stranger.

The tool appends an **"Other"** choice of its own, and that is the route for
*"I don't know"* — which `grading.md` treats as the clearest request for
teaching there is. When a question is one someone could plausibly blank on, say
so in a `description` so the route is visible: a learner who cannot see it
guesses instead, and a guess records as a wrong answer rather than as a blank,
so the teaching sequence never fires.

Then one call to `AskUserQuestion` with all four options. One question per call:
the tool accepts up to four, and four at once is a test rather than teaching.
Use `preview` when the options are *code* — four snippets side by side is a far
better question than four sentences describing snippets. A renderer without
`AskUserQuestion` lays the same four options out as lettered text; everything
here still holds, only the rendering changes. A renderer that *has* the tool and
quietly drops one of its fields is the other case, and it is what
`ask_attribution` exists for.

## What a finished question looks like

Read yours against this. Each line is a property of the question, so a "no" is
telling you which part to rebuild.

- Someone who saw none of the code, plan or conversation could answer it: every
  project-specific name is defined, and the key follows from the concept.
- The stem asks one thing: at most one sentence of situation, then a question,
  each 25 words or fewer (counted separately).
- Read without the project, every wrong option is still wrong: the situation
  kept the constraints the names carried.
- The answer appears among the options and nowhere in the stem.
- Each option is a complete claim when read on its own.
- Each option, label plus description, is about 20–26 words and within a few
  words of the others, in the same grammar. A visibly longer, more specific or
  more careful option reads as the correct one, and gets picked without
  engaging — the same leak as always answering first.
- No description says why an option is right, wrong or tempting.
- Each of the three wrong options came from a different row of the table above,
  and each is believable to someone with a partial grasp.
- Only the correct option answers the stem; no expert could argue for another.
- The correct option sits at `answer_position`, and `correct` names it.
- The tool renders the labels, so the stem does not number them.
- The stem is the question and nothing else — the dials are in the developer's
  status bar.
- The stem reads correctly in one pass, with no stacked negation.

A tier-4 failure-mode question can be asked in fifteen ordinary words, and it is
a better question for it. Plain language is a property of the sentence, not of
the difficulty.

## A second question about the same concept

`asked_before` tells you what is spent. What it does not tell you is which
direction to go next, and the grade decides that:

- Scored 4 or 5: `tier_to_ask` has already moved up, so ask for something the
  old question did not — mechanism, then judgement, then failure mode.
- Scored 1 or 2: come at the *same* level from a different angle. Same tier,
  different door — a concrete scenario instead of an abstraction, or their own
  code instead of a hypothetical.
- Scored 0 with `outcome: "dont_know"`: you already taught this. Ask the thing
  your explanation set up, and say so — it should sound like the second half of
  a conversation.
- `asked_before` empty: clean slate. Use `tier_to_ask` and `description`.

## Unmet prerequisites

`prereqs_unmet` is a warning that a question would be **unfair**, not hard. If a
concept has unmet prerequisites:

- Ask about the prerequisite instead, if it is in the plan — the plan already
  orders foundations first.
- Otherwise ask at `tier_to_ask` (the planner owns the tier) and write the
  question so it needs no alternative: about what this thing does, not why it
  beats another. "Why this rather than the alternative" is not answerable by
  someone who does not yet have the alternative.
- Say the dependency out loud in your feedback. Knowing *what to learn next* is
  half of what the graph is for.

## Recording it

`record_attempt` with `format: "mcq"`, `options` as the labels you offered,
`answer` as the one they picked, `correct` as the right option's label
verbatim, `option_notes` as what you want shown under each option after the answer (same
order as `options`; the reasoning each option earns, which the neutral
`description` left out), and `question` as the **stem only**.

`correct` and `option_notes` are what let the learner correct a missed answer
from its explainer page: the dashboard grades the new pick against `correct`
and shows each note under its option. A `correct` that is not one of the
options, or a notes list of the wrong length, is stored as nothing and the
response says so (`correct_mismatch`, `option_notes_mismatch`) — the answer
itself is still recorded. The response's `attempt_id` names the row; on a miss
the `explain` block carries it for the explainer.

Options belong in `options`. The stem is what gets fingerprinted, so options
baked into it would make every reshuffle look like a brand-new question and
quietly undo *never the same question twice*. The same arithmetic is why the
stem carries nothing decorative: a bracketed settings line inside it would make
one question look new every time a dial moved. The server strips such a line
from either end if one appears — that is a backstop for rows recorded before
1.14, not a licence to add one.
