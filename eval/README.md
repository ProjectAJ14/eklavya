# The question-quality eval

Eklavya's claim is that the developer learns. The 447 tests in `mcp/test/`
check the machinery — SM-2 arithmetic, plan sizing, gate maths, migrations —
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
- `positive_form`, `options_not_numbered`, `no_settings_line`

Two are properties of the **run**, not of any question, which is why no judge
reading one question at a time could ever report them:

- which slot the answer landed in, across the run
- how often the correct option was the longest — against a 25% chance baseline

Judged (needs reading comprehension, so a model does it):

- is the question answerable from what is shown
- is the option marked correct actually correct
- how many of the three distractors a competent person could believe (0–3)
- does the question match the tier it was pitched at
- does the stem ask one thing

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
- **The deterministic checks are proxies.** A question can pass all nine and
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

## Not built yet

The board lists three harnesses. This is one.

- **Loop behaviour** — headless `claude -p` against a pinned public repo,
  asserting one checkpoint per task, exactly one question, and the work resuming
  with no summary. The S321 regression belongs here.
- **Extraction** — does `log_session_concepts` pick the concepts a diff genuinely
  exercises? Precision and recall against the same hand labels.

Both need a session harness, and both need the trap above taken seriously.
