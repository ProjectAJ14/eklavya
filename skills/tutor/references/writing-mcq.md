# Writing the question

Required reading before you write a question. `SKILL.md` decides *whether* to
ask and *at what tier*; this is how to build the thing itself.

## Build it in this order

Six parts, then the call. Build them in the order below — not the order they
appear on screen — because each one constrains the next.

**1. The stem.** One question about one idea, in about 25 words, grounded per
the plan's `framing`. Ordinary words: "sent with the request" rather than
"transmitted alongside the request context". Expand an acronym the first time it
appears for this learner — CSRF once, then CSRF. The answer lives in the
options, so the stem asks and stops.

Ask the positive form, and ask it once: negation makes the stem a reading test
rather than a question about the idea, and a stem needing a second clause to be
precise is doing two jobs — ask the first one and keep the other for later.

> Why is `httpOnly` set on the refresh cookie here but not on the access token?

**2. The correct option.** Write it before the distractors. It sets the length
and the grammar the other three have to match.

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

Each one should be something a competent person could believe. Three that a
learner can dismiss without thinking is a free point, and it teaches nothing.
When three that good will not come, the stem is too vague to have a near-miss:
rewrite the stem and the distractors follow.

**4. One clause of `description` per option.** This is where a near-miss earns
its place — the sentence that makes the wrong answer tempting.

**5. Placement.** The plan gives each question an `answer_position`, 1 to 4. Put
the correct option in that slot. Left to your own judgement you will put the
right answer first nearly every time, and a learner needs only a handful of
questions to notice that and start picking A without reading; the quiz keeps
looking fine and stops measuring anything.

**6. `header`.** Set it to `Eklavya`. That chip is the only thing on screen
saying who is asking. A question arriving mid-task with no attribution reads as
Claude going off-piste, and the developer answers a stranger.

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
here still holds, only the rendering changes.

## What a finished question looks like

Read yours against this. Each line is a property of the question, so a "no" is
telling you which part to rebuild.

- The stem asks one thing, and it fits in one breath.
- The answer appears among the options and nowhere in the stem.
- All four options are within a few words of the same length and use the same
  grammar. A visibly longer or more careful option reads as the correct one, and
  gets picked without engaging — the same leak as always answering first.
- Each of the three wrong options came from a different row of the table above.
- The correct option sits at `answer_position`.
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
- Otherwise drop the question a tier and make it mechanism-level. "Why this
  rather than the alternative" is not answerable by someone who does not yet
  have the alternative.
- Say the dependency out loud in your feedback. Knowing *what to learn next* is
  half of what the graph is for.

## Recording it

`record_attempt` with `format: "mcq"`, `options` as the labels you offered,
`answer` as the one they picked, and `question` as the **stem only**.

Options belong in `options`. The stem is what gets fingerprinted, so options
baked into it would make every reshuffle look like a brand-new question and
quietly undo *never the same question twice*. The same arithmetic is why the
stem carries nothing decorative: a bracketed settings line inside it would make
one question look new every time a dial moved. The server strips such a line
from either end if one appears — that is a backstop for rows recorded before
1.14, not a licence to add one.
