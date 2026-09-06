# The question-quality eval

Eklavya's claim is that the developer learns. The suite in `mcp/test/` checks
the machinery — SM-2 arithmetic, plan sizing, gate maths, migrations —
and not one of them checks the product, which is a question. This measures the
question.

It is deliberately the narrowest of the three evals worth having. The other two
are named at the bottom, and neither exists yet.

## Method

Four stages. Each writes its output, so any one can be re-run or read on its
own.

| Stage | What it does | Model calls |
|---|---|---|
| `plan` | Builds a throwaway home and repo, upserts the fixture concepts, logs them as session work, and calls the **real** `get_session_quiz_plan`. | none |
| `generate` | Gives a model the **shipped** `skills/tutor/SKILL.md` and `references/writing-mcq.md`, the fixture's code, and one plan item. Asks for one question. | one per question |
| `score` | Deterministic checks. No model, free, same answer every time. | none |
| `judge` | A model reads each question and answers five questions about it. | one per question |

`plan` and `score` import the built server from `mcp/dist`, so run
`npm run build` in `mcp/` first — on a fresh clone `dist/` does not exist.

```bash
node eval/harness.mjs run --limit 8 --focus project --difficulty hard
node eval/harness.mjs score eval/results/<run>     # re-score without regenerating
```

**`plan` drives the real planner rather than inventing plan items**, and that is
the load-bearing choice. `tier_to_ask`, `framing`, `level_framing` and
`answer_position` are all decided server-side; a harness that made them up would
grade the model against a plan the product never produces. It also means a
planner regression shows up here.

The config is written to a real `.eklavya.json` in the throwaway repo, so the
run goes through the same merge order a developer's machine does.

## What is checked where, and why the split matters

An LLM judge is soft. It disagrees with itself between runs, it costs money,
and it is biased toward output from its own family. So **everything decidable
by counting is counted**, and the judge is left only with what needs reading.

Deterministic (`mcp/src/eval/question-checks.ts`, unit-tested in
`mcp/test/eval.test.ts`):

- `four_options` — four, non-empty, distinct
- `answer_at_position` — the correct option is in the slot the plan assigned.
  The obedience check: `answerPosition` is a server-side hash precisely so the
  answer cannot cluster, and that only works if the model obeys it
- `stem_length` — 25 words or fewer
- `answer_not_in_stem` — longest word-run shared with the correct option, so the
  subject can appear in both (it always does) while the *sentence* cannot
- `option_parity` — longest/shortest option ratio
- `correct_not_conspicuous` — the correct option is not visibly longer than the
  next-longest
- `correct_in_range` — the model named an option that exists
- `positive_form`, `options_not_numbered`, `no_settings_line`

Several were calibrated by running them: `answer_not_in_stem` keeps identifiers
whole (splitting `max_questions_per_task` into four words made every question
about this repo's own code flag against itself), `options_not_numbered` needs
two markers (one `b)` is `retry(db, b)`), `positive_form` matches the inverted
question forms rather than any "not" (a contrastive "but not on the access
token" is a good stem), and `option_parity` is skipped when every option is
short (`O(1)` against `O(n log n)` is a ratio of 3 and looks identical).

Two are properties of the **run**, not of any question, which is why no judge
reading one question at a time could ever report them:

- which slot the answer landed in, across the run
- how often the correct option was the longest — against a 25% chance baseline

Judged — five, and each needs reading comprehension, which is the only reason a
model is involved:

- is the question answerable from what is shown
- is the option marked correct actually correct
- how many of the three distractors a competent person could believe (0–3)
- does the question match the tier it was pitched at
- does the stem ask one thing

## The other end: a real answer history

`generate`/`score`/`judge` measure questions before anyone answers them.
`history` measures what happened after — it reads an actual `knowledge.db`
read-only and reports three things:

```bash
npm run eval -- history                 # defaults to ~/.eklavya/knowledge.db
npm run eval -- history --db <path>
```

- **The repeat rate.** *Never the same question twice* is the promise the whole
  tool rests on, and the only claim measurable today with no new harness. It
  imports `questionFingerprint` from `store.ts`, so it uses the product's own
  definition of "the same question" rather than a second opinion — and it
  divides by the attempts that **could** have repeated, not by all of them,
  because most attempts are the first question on their concept and a first
  question cannot repeat.

  Repeats are split by which mechanism would have seen them, because only one of
  the two prevents anything. The planner fills `asked_before` from
  `recentQuestions(db, concept.id, ASKED_HISTORY)` with `ASKED_HISTORY = 3`, and
  that acts while the question is being written. `hasAskedQuestion` looks back 20
  but runs inside `record_attempt` after the fact and rejects nothing — it
  records the row and returns `repeat_question: true`. A repeat at distance 4–20
  is therefore not "one the product should have caught", and the first published
  run said it was.
- **Tier calibration.** Mean grade per tier, reported under **both** readings of
  the 18 rows that predate the `outcome` column — `migrations/004` says a NULL
  outcome must be treated as unknown, so counting those grade-0 rows as answers
  is a choice, and on the first run it was the difference between tier 2 sitting
  below the pass threshold and above it. One number there would have been a
  judgement call wearing a measurement's clothes.
- **What held across a gap.** The weakest honest version of retention: a concept
  that **passed**, came back a day or more later, and passed again. The prior
  pass is required — without it the metric counts two failures far apart as
  something that failed to hold, which is what the first run published.

Aggregates only, by construction — the statistics module is handed rows and
hands back numbers, and no stem or answer reaches the report. The output is
committed and the repo rule is that a learner's data never is.

A published result file gets **corrected in place, with the original claim left
visible**, when a later reading shows it was wrong. `2026-09-06-history.md`
carries three such corrections — two of them to its headline numbers. A results
directory whose files only ever grow more favourable is not a record of
anything.

The repeat rate's error is in the flattering direction, and the result file has
to say so: a fingerprint is a normalised stem, so two questions asking the
identical thing in different words are not counted as a repeat. It measures
*literal* repetition, and nothing here bounds the gap to the promise people
actually care about.

## What would disprove this

Stated first, because a number that cannot be wrong is not a measurement.

- **The judge and the generator are the same model family.** A model marking
  its own homework will rate its own questions plausible. Both model ids are
  recorded in every run. Running `judge` with `--model` set to something else
  and getting materially different numbers would mean the judged half is
  measuring the judge, not the questions.
- **The fixtures are this repo's own code**, hand-labelled by the person who
  wrote it. The concepts are therefore unusually clean, and question quality on
  them is an upper bound. Fixtures drawn from an unfamiliar codebase would score
  worse, and that gap is the honest error bar.
- **Three fixtures, eight concepts.** Nothing here is significant at that size.
  A result that survives one run and not the next is noise, and the run-level
  rates need tens of questions before they mean anything.
- **The deterministic checks are proxies.** A question can pass all ten and
  still be dull, or fail `correct_not_conspicuous` and be excellent. They catch
  *shapes* known to leak the answer; they do not measure whether anyone learned.
- **The thing nobody here measures is retention.** The end-to-end claim — that a
  developer knows more a week later — needs a study with people in it, and no
  amount of this harness substitutes for one. Any headline that sounds like
  "you learn N% more" is not supported by anything in this directory.

## The contamination trap, for whoever writes the next eval

ponytail ran an agentic benchmark, got a suspiciously small 4% gap, and found
the cause before publishing: their own `SessionStart` hook fired on the
**baseline** arm, so the control was secretly running the plugin. Their fix was
`--setting-sources project,local` to exclude the developer's global plugins,
plus exactly one `--plugin-dir` per arm.

**Eklavya walks into the same trap harder**, because the checkpoint *is* a hook.
Any future A/B of "with Eklavya" against "without" has to prove the without-arm
loaded no `SessionStart`, no `UserPromptSubmit` and no `PostToolUse` hook from
this plugin — including one installed globally on the machine running the
benchmark. This eval avoids it only by having no arms: it measures questions,
not sessions.

## The step before any question exists

`extract` asks whether `log_session_concepts` names the concepts a diff actually
exercises. It is upstream of everything else: if extraction picks the wrong
concepts, every question after it is well-formed and about the wrong thing, and
`score` calls that run clean — a good question about an irrelevant concept is
still a good question.

```bash
npm run eval -- extract
```

Same shape as `generate`: the model gets the shipped skill and a diff and
produces the call it would have made. No session, no hooks.

Scored with **the product's own matcher**. `findFuzzyMatch` and
`FUZZY_MATCH_THRESHOLD` from `slug.ts` are what the server uses to decide two
slugs mean the same concept, so a model that logs `wal-mode` against a label of
`wal-journal-mode` is credited here exactly as `log_session_concepts` would
credit it. One label is never credited twice, or recall would be inflatable by
logging one concept five ways.

Four shape checks need no model: the count is within the 3–8 the skill asks for,
the slugs survive normalisation, every concept carries a context line, and the
context names something that actually appears in the diff. That last one is the
`"used cookies"` case the skill calls useless — it reads fine, produces a
question, grounds it in nothing, and nothing downstream notices.

**The denominator is judged, not assumed.** An extracted slug matching no label
is either a false positive or a concept the labeller did not think of, and
scoring every unmatched slug as wrong would grade the model against one person's
reading of a diff. Only the unmatched ones go to a judge, and the report gives
precision both ways — strict, and counting judge-confirmed concepts as right.

## Not built yet

The board lists three harnesses. Two are built.

- **Loop behaviour** — headless `claude -p` against a pinned public repo,
  asserting one checkpoint per task, exactly one question, and the work resuming
  with no summary. The S321 regression belongs here, and it is the one that
  matters most: the suite proves the *planner* returns one item under
  `interleaved` cadence, and nothing proves the *model* asked one and then got
  back to work.

That one needs a real session — the plugin installed into a throwaway
`CLAUDE_CONFIG_DIR` so hooks fire, assertions over a parsed transcript rather
than a return value, and a rate across several runs rather than a pass/fail,
because the model may legitimately vary. It also needs the trap above taken
seriously.

An earlier version of this file claimed extraction needed a session harness too.
It did not: it is the same offline shape as `generate`, and the scoring problem
it seemed to have was already solved inside the product.
