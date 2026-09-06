# Writing the question

Required reading before you write a question. `SKILL.md` decides *whether* to
ask and *at what tier*; this is how to build the thing itself.

## Multiple choice

Use the **`AskUserQuestion`** tool. One question per call — the tool accepts up
to four, but four at once is a test, not teaching.

**Shape:**

- **Exactly four options.** One correct, three plausible.
- **Put the correct option where `answer_position` says.** The plan gives each
  question a slot from 1 to 4 — obey it. Left to your own judgement you will put
  the right answer first nearly every time, and a learner only needs a handful of
  questions to notice that and start picking A without reading. The quiz keeps
  looking fine and stops measuring anything. Write the four options, then place
  them so the correct one lands in that slot.
- **`header`**: set it to `Eklavya` (7 chars, fits). The chip is the only thing
  on screen that says who is asking. A question that arrives mid-task with no
  attribution reads as Claude going off-piste, and the developer answers a
  stranger. The tool still appends an "Other" choice automatically and that is
  the escape hatch for *"I don't know"* — name it in a `description` if a
  question needs it, not in the header.
- **`question`**: the stem, grounded per the plan's `framing`. Do not number the
  options in the text; the tool renders them.
- **`description`** on each option: one clause. This is where a near-miss gets
  to be genuinely tempting.
- **`preview`**: use it when the options are *code*. Four snippets side by side
  is a far better question than four sentences describing snippets.

A renderer without `AskUserQuestion` lays the same four options out as lettered
text. Everything here still applies; only the rendering changes.

## Distractors are the whole question

Three obviously-wrong options is a free point that teaches nothing and insults
them. Each wrong option should be something a competent person could believe:

- the right answer to the *adjacent* concept (`SameSite` vs `httpOnly` vs `Secure`)
- true, but not what was asked
- the common misconception — the one you would have to correct in a code review
- right mechanism, wrong direction or wrong actor

If you cannot write three that pass that bar, your stem is too vague. Fix the
stem, not the options.

## Say it plainly

The concept is the difficulty; the sentence should not be. A learner mid-task is
reading this in a gap between two other thoughts, and a stem they have to parse
twice gets answered from the shape of the options instead of the idea.

- **One idea per stem, and keep it short** — around 25 words. If you need a
  second clause to make it precise, the question is doing two jobs; ask the first
  one.
- **Plain words over impressive ones.** "sent with the request" beats
  "transmitted alongside the request context". Save the precise term for when the
  precision is the point — then use it, and make sure the stem teaches it.
- **Expand an acronym the first time it appears** for this learner. CSRF once,
  then CSRF.
- **Keep the four options short and the same shape.** Similar length, similar
  grammar. A visibly longer or more careful option reads as the correct one, and
  learners pick it without engaging — the same failure as always putting the
  answer first, wearing different clothes.
- **No double negatives, and avoid "which is NOT".** Negation tests reading, not
  understanding. Ask the positive form.

Plain language is not easier questions. A tier-4 failure-mode question can be
asked in fifteen ordinary words, and it is a better question for it.

**Never restate the answer in the stem.** *"What does httpOnly do — does it
block JavaScript access?"* is not a question.

## A second question about the same concept

`asked_before` tells you what is spent. What it does *not* tell you is which
direction to go next, and the grade decides that:

- Scored 4 or 5: `tier_to_ask` has already moved up, so the new question should
  ask for something the old one did not — mechanism, then judgement, then failure
  mode.
- Scored 1 or 2: come at the *same* level from a different angle. Same tier,
  different door — a concrete scenario instead of an abstraction, or their own
  code instead of a hypothetical.
- Scored 0 with `outcome: "dont_know"`: you already taught this. Ask the thing
  your explanation set up, and say so — the question should sound like the second
  half of a conversation.
- `asked_before` empty: clean slate. Use `tier_to_ask` and `description`.

## Unmet prerequisites

`prereqs_unmet` is a warning that a question would be **unfair**, not hard. If a
concept has unmet prerequisites:

- Ask about the prerequisite instead, if it is in the plan — the plan already
  orders foundations first.
- Otherwise drop the question a tier and make it mechanism-level. "Why this
  rather than the alternative" is not answerable by someone who does not yet have
  the alternative.
- Say the dependency out loud in your feedback. Knowing *what to learn next* is
  half of what the graph is for.

## Recording it

`record_attempt` with `format: "mcq"`, `options` as the labels you offered,
`answer` as the one they picked, and `question` as the **stem only**.

Options belong in `options`, never in `question`. The stem is what gets
fingerprinted, so options baked in there would make every reshuffle look like a
brand-new question and quietly undo *never the same question twice*. The same
argument is why nothing decorative goes in the stem: a bracketed settings line
inside it would make one question look new every time a dial moved. The server
strips such a line from either end if one appears — that is a backstop for rows
recorded before 1.14, not a licence to add one.
