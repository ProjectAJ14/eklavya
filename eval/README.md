# Evaluation guide

Use these harnesses to measure question quality, concept extraction, real answer
history, memory retrieval and performance. Automated runtime tests in `mcp/test/`
cover implementation correctness; these evaluations answer different questions.

## Choose a harness

Build first with `cd mcp && npm run build`, then run from the repository root.

| Goal | Command | Model calls |
|---|---|---|
| Question planning and quality | `npm run eval -- run --limit 8 --focus project --difficulty hard` | Generation and judging |
| Re-score existing questions | `npm run eval -- score eval/results/<run>` | None |
| Concept extraction | `npm run eval -- extract` | Extraction and judging |
| Repeats and retention in real history | `npm run eval -- history` | None; reads learner database |
| Retrieval quality | `node eval/retrieval-harness.mjs` | None |
| Memory performance | `node eval/memory-perf.mjs` | None |

Replace `<run>` with a saved run directory. Model-based stages use the configured
Claude command and can incur usage. These harnesses do not run in CI. Before
publishing a result, include the revision, settings, corpus, limitations and what
would disprove the conclusion; report unfavorable results too.

The detailed retrieval and performance analyses below are dated historical
measurements. They do not claim that the current version has the same defects or
timings. Preserve the original evidence and make corrections explicit.

## Method

Four stages. Each writes its output, so any one can be re-run or read on its
own.

| Stage | What it does | Model calls |
|---|---|---|
| `plan` | Builds a throwaway home and repo, upserts the fixture concepts, logs them as session work, and calls the **real** `get_session_quiz_plan`. | none |
| `generate` | Gives a model the **shipped** `skills/tutor/SKILL.md` and `references/writing-mcq.md`, the fixture's code, and one plan item. Asks for one question. | one per question |
| `score` | Deterministic checks. No model, free, same answer every time. | none |
| `judge` | A model reads each question and answers six questions about it. | one per question |

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

Judged — six, and each needs reading comprehension, which is the only reason a
model is involved:

- is the question answerable from what is shown
- is the option marked correct actually correct
- how many of the three distractors a competent person could believe (0–3)
- how many of the three distractors an expert could argue also answer the stem
  (0–3; should be 0). This pulls against the line above: pushing for believable
  wrong options is what produces ones that are not wrong at all
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

## The retrieval eval

`eval/retrieval-harness.mjs` measures the other half of the product: whether
the evidence handed to the model was the right evidence. It costs nothing —
no model call anywhere, a fixed synthetic corpus in
`fixtures/retrieval-corpus.json`, and a pure scorer in
`mcp/src/eval/retrieval-score.ts` — so unlike the question eval it can be run
on every change to `mcp/src/memory/search.ts` or to the embedder.

```bash
cd mcp && npm run build && cd ..
node eval/retrieval-harness.mjs                # all three modes
node eval/retrieval-harness.mjs --k 3          # at a tighter budget
node eval/retrieval-harness.mjs --split dev    # while changing the retriever
node eval/retrieval-harness.mjs --json         # for a results file
```

### The corpus

78 invented entries across five projects, and 110 labelled queries in fourteen
categories. `quality.md` asks for at least 100 queries spanning decisions,
fixes, files, dates, CJK and mixed-language search, worktrees, adversarial
stale facts and explicit cross-project recall, and those are the categories —
plus the `exact`, `morphology`, `typo`, `paraphrase`, `scope` and `synonym`
shapes the first twelve queries measured, kept with their ids so the
2026-09-22 baseline stays comparable.

Every entry is fiction. Nothing in the fixture is read from, copied out of or
paraphrased from a real memory database, an import, or this repo's history.

**The entries exist to be wrong, not only to be right.** An eval where each
query has exactly one plausible answer measures nothing, so the corpus is
built out of near-misses: two checkout latency bugs six months apart, three
projects that each solved idempotency differently, an English note and its
Japanese twin on the same hook, two worktrees whose entries both mention a
retry, and four pairs where one entry contradicts the other. Queries that have
a tempting wrong answer name it in `forbidden`, and the harness counts how
often it came back — the *leak rate*, which is the number a precision average
is least able to show.

**The split is a discipline, not an enforcement.** 30 of the 110 queries are
`heldout`. They were assigned before the first run against this corpus and
were not revised after its numbers were read. `--split dev` is what to use
while changing the retriever; a gain on `dev` that does not reproduce on
`heldout` is noise. Nothing stops a reader from looking at the held-out set,
and this file is the only thing that records that they should not tune against
it.

### What the numbers mean

**Top-1 is the headline, and precision@k is not.** Most queries in the corpus
have one right answer, so precision@5 measures how many results a mode
returned rather than whether they were good: a mode that always fills the
slate scores 0.2 however perfect its ranking. Top-1 asks what the developer
asks — was the first thing it showed me the right thing. Recall is reported
beside it and never blended in, because omitting useful evidence is the
failure a savings percentage cannot see (PRD MET-01): a recall of zero looks
like an excellent saving.

**Recall@20 on this corpus is close to meaningless**, and it is the number the
plan's 0.90 goal is written against. A project scope here holds between six and
thirty entries, so a slate of twenty is most of the scope: hybrid measures
0.968 at k=20, and would measure well over 0.9 with almost any ranking at all.
The plan's reference fixture is 100,000 entries, and until the corpus is that
size the recall@20 target is not testable here. Recall@5 (0.898) is the version
of that number this corpus can support.

### What fails the build

Two things, because on a corpus built to be hard most misses are a measurement
rather than a defect, and a gate that fires on every hard query is a gate
nobody reads.

- `mustFind` — the query names something the product documents as guaranteed:
  an exact term, the ADR-03 morphology claim, a project filter that is a SQL
  clause. Missing one exits non-zero.
- `noLeak` — the query's `forbidden` entries are excluded by SQL rather than by
  ranking: another project's rows, a superseded correction, a row outside a
  date window. One of those in the results means a filter was not applied, and
  exits non-zero.

Everything else is reported and nothing else is enforced: per category, per
split, and as a leak rate.

**`expectedMiss` still holds `ADR-03` honest.** That decision says the local
embedder generalises over morphology and typos but not over meaning. A query
beyond that ceiling is labelled `expectedMiss`, and if hybrid starts answering
one the harness says `NEWS` and exits zero — being better than documented is
not a build failure, but the ADR and the manual would need to say so.

"Answering" means top-1, and that got stricter in this version after a run
showed why. Semantic search keeps anything above a cosine of 0.05, so in a
project holding eight entries the slate fills almost regardless of the query,
and "it came back fourth of five" is a fact about the project's size rather
than about the embedder bridging meaning. The weaker reading is still reported,
as `expected_miss_in_slate`, because a criterion that quietly gets stricter is
one nobody can audit. Note the direction: this change makes surprises rarer and
the documented ceiling look *more* solid, which is the direction to be
suspicious of — it is recorded here for exactly that reason.

### Writing a synonym query is harder than it looks

Three attempts went into the first one, and growing the corpus produced three
more of the same mistake in one sitting. A query meant to be reachable only by
meaning kept sharing vocabulary with its target:

- `q-synonym` (v1) leaked `cookie`/`replay`, then `use`/`used`;
- `q-syn-fraud-budget` said "slow service" against a note titled "…from a slow
  fraud check", and keyword search put it first;
- `q-cjk-cross-en-zh-pool` and `q-cjk-cross-en-zh-mon` were labelled
  `expectedMiss` as cross-lingual queries, and both were found — because the
  Chinese notes carry `src/db/pool.ts` and `deploy/monitoring/`, and a file path
  is written in Latin script whatever language the prose is in.

The last one is worth more than the label it broke: **an identifier bridges
languages when nothing else does.** Both queries kept their place in the corpus
with the `expectedMiss` label removed and the reason written into their `why`.

<details>
<summary>Historical retrieval results and limitations — 22 September 2026</summary>

### Measured, 2026-09-22

`results/2026-09-22-retrieval-v2.json`, k=5, against
`results/2026-09-22-retrieval.json` (18 entries, 12 queries) as the v1 baseline.

| | v1 top-1 | v2 top-1 | v1 recall@5 | v2 recall@5 | v1 prec@5 | v2 prec@5 |
|---|---|---|---|---|---|---|
| keyword | 0.833 | 0.691 | 0.833 | 0.774 | 0.683 | 0.479 |
| semantic | 0.917 | 0.755 | 0.917 | 0.862 | 0.183 | 0.238 |
| hybrid | 0.917 | 0.755 | 0.917 | 0.898 | 0.183 | 0.247 |

Every headline got worse, which was the point of the exercise. Hybrid still
beats keyword (+0.064 top-1, +0.124 recall) on a corpus with nine times the
queries and four times the entries, so the comparison the default mode rests on
survives the harder corpus. What does not survive is stated two paragraphs
down.

Precision@5 of 0.247 against the plan's proposed 0.80 is the same renegotiation
this file already made at 0.183: on a corpus where most queries have one right
answer, 0.20 is the arithmetic ceiling for a mode that fills the slate, and the
target was written for a corpus of answerable queries with several sources
each. It is not a target this eval can be passed against, and it should be
restated as recall@5 with a leak rate before anyone signs up to it.

Per category, hybrid, with the keyword column beside it because the gap between
them is the whole argument for the hybrid:

| category | n | keyword top-1 | hybrid top-1 | hybrid recall@5 | leaks |
|---|---|---|---|---|---|
| exact | 7 | 1.000 | 1.000 | 1.000 | — |
| decision | 9 | 1.000 | 1.000 | 1.000 | — |
| fix | 9 | 1.000 | 1.000 | 1.000 | — |
| file | 8 | 1.000 | 1.000 | 1.000 | — |
| date | 8 | 1.000 | 1.000 | 1.000 | 2/6 |
| morphology | 7 | 0.857 | 0.857 | 1.000 | — |
| scope | 6 | 0.833 | 0.833 | 0.917 | 0/3 |
| worktree | 6 | 0.833 | 0.833 | 1.000 | 2/5 |
| typo | 7 | 0.571 | 0.714 | 1.000 | — |
| cross-project | 8 | 0.625 | 0.625 | 0.792 | — |
| paraphrase | 8 | 0.500 | 0.625 | 0.750 | — |
| cjk | 15 | 0.200 | 0.533 | 0.733 | — |
| stale | 8 | 0.375 | 0.375 | 1.000 | 4/8 |
| synonym | 4 | 0.000 | 0.000 | 0.250 | — |

dev 0.800 top-1 / 0.879 recall, heldout 0.633 / 0.950. The held-out set is
materially harder on top-1 and it was not written to be — the same hands wrote
both, one after the other. Read the 0.633 as the honest number and the 0.800 as
the one that has been looked at.

**And the held-out split disagrees about the hybrid.** On those 30 queries
semantic alone scores 0.733 top-1 against hybrid's 0.633, while hybrid keeps
the recall lead (0.950 against 0.883). Over the whole corpus the two tie on
top-1 and hybrid leads on recall, which is also what v1 found — so the
defensible claim is *hybrid over keyword*, and *hybrid for recall*. "Hybrid is
the best mode" is not a claim these numbers support, and the manual should not
make it. Reciprocal rank fusion moves a result that one mode ranked first and
the other ranked fourth down the slate, and on a query only the embedder can
answer that is a cost rather than a hedge.

### The three categories the retriever is bad at

**Stale facts: 0.375 top-1, and the stale row came back in four of eight.**
This is the worst result in the run and the most useful. Two of the four pairs
were corrected properly — the old entry is superseded, and `search` excludes it
in SQL, so nothing leaks. The other two are the realistic case: a note from
February says sessions live in Redis, a note from August says they were moved
to Postgres, and nobody marked the first one wrong. Ranking is all that stands
between the developer and the stale answer, and ranking has no opinion about
time. `q-stale-staging-copy` is the sharpest version: asked in the stale note's
own words, the wrong answer is the best lexical match in the corpus, and it
wins. Nothing in `search.ts` reads `occurred_at` unless a filter names it. A
recency prior would be a change to `mcp/src/memory/search.ts` and is out of
scope for this eval, which exists to say the number, not to fix it.

**CJK: 0.533 top-1, and keyword alone manages 0.200.** FTS5's `unicode61`
tokenizer has no word boundary in Japanese or Chinese, so a whole title is one
token and no substring of it can match. Korean does use spaces, and one of its
two queries is the only CJK query keyword search answers without a Latin token
in it — the other asks for `키보드 입력란` against a note that writes both words
with a particle attached, which is the same boundary problem one level down.
The character n-grams in `local-hash-v1` recover about a third of the
gap — the entire argument for running semantic search beside keyword shows up
in this category and nowhere else — but two queries return nothing relevant at
all (`q-cjk-rotation-ja`, `q-cjk-db-zh`), both of them substrings from the
middle of a long token. Cross-lingual queries fail outright unless a Latin
identifier bridges them. A CJK-aware tokenizer is the fix, and it is a schema
change: the FTS table names its tokenizer in `009_memory.sql`.

**Meaning: 0.000 top-1 on four synonym queries.** ADR-03 said so, and the
corpus now says it four times instead of once. Paraphrase at 0.625 is the same
ceiling seen at a shallower angle: a query sharing two content words with its
target usually lands, one content word usually does not.

Two smaller ones worth naming: **cross-project at 0.625** is the ranking
problem the widened scope creates — the right entry is in the slate (recall
0.792) and something from another project is above it. And the **date**
category splits cleanly: with a `since`/`until` filter every query is answered
and nothing leaks, while the two queries that write the month into the sentence
both return the wrong month's twin alongside the right answer. Nothing in the
retriever reads `march` as a time, and the category's clean 1.000 top-1 hides
that — which is exactly why the leak count is printed next to it.

### What would disprove the retrieval numbers

- **The labels are one person's reading**, and some near-misses are defensible
  answers. `q-stale-deploys` asks how deploys run and is labelled with the
  CI-only change; the blue-green decision outranks it and is not credited.
  Widening those labels would raise the score without changing the product,
  which is the reason not to do it after seeing the run.
- **The corpus is synthetic and small.** 78 entries in five projects is not
  100,000 in one, and several scores are affected by how few candidates a
  project scope holds. The `heldout` gap is the only estimate here of how much
  of the dev number is familiarity.
- **A category with seven queries moves 0.143 per query.** Nothing in the
  per-category table is significant on its own; the three named above are
  reported because they fail by margins wider than that, and the rest are
  reported because hiding them would be the failure mode this table exists to
  prevent.


</details>

## The performance baseline

`eval/memory-perf.mjs` measures the machinery rather than the product: how long
the memory paths take on a corpus of a given size. Four of its numbers sit on
the path of a human action — the capture append after every tool call, the
startup display, the seam recall and the per-prompt recall — and those are the
only ones a developer can feel. The rest are on an agent's path, measured so a
regression has somewhere to show up. No model call, nothing in CI: timings on a
shared runner are noise.

```bash
cd mcp && npm run build && cd ..
node eval/memory-perf.mjs                                     # 2,000 entries
node eval/memory-perf.mjs --entries 20000                     # the first size that found a cliff
node eval/memory-perf.mjs --entries 100000 --events 1000000   # quality.md's fixture, entry axis
```

`--events` was added for the 100k run and defaults to 0, which is what the 2k
and 20k baselines ran with. It pre-loads `evidence_events` before anything is
timed, in one transaction through the product's own `appendEvent`, so the rows
and indexes are the ones a hook writes and only the per-row fsync is dropped.
Nothing measured runs inside that transaction.

<details>
<summary>Historical performance results and subsequent index fix — 22 September 2026</summary>

### Measured, 2026-09-22 — 100,000 entries and 1,000,000 events

`results/2026-09-22-memory-perf-100k.json`, against `-20k.json` and `-2k.json`
on the same laptop (M-series, Node v26.7.0). Medians in ms.

| | 2k entries | 20k entries | 100k entries |
|---|---|---|---|
| capture.prepare | 0.004 | 0.004 | 0.003 |
| capture append | 0.028 | 0.030 | 0.029 |
| search keyword | 0.861 | 7.974 | **51.069** |
| search semantic | 2.472 | 5.803 | 5.296 |
| search hybrid | 3.278 | 16.823 | **57.980** |
| recall at a session seam | 0.161 | 0.160 | 0.155 |
| recall per prompt | 2.496 | 5.981 | 5.753 |
| startup display | 0.055 | 0.054 | 0.054 |
| worker, one 40-event batch (one sample) | 1.2 | 1.1 | **612.6** |
| corpus fill | 285ms | 3,157ms | 17,657ms |
| database | 6MB | 50MB | 743MB |

Every row but the worker is a median over 40–2,000 iterations with p95 and max
in the JSON. The worker runs once per invocation, so its figure is a single
sample and moves: a second 100k run measured 836ms. Read it as "hundreds of
milliseconds", not as 612.6.

The whole run takes 36 seconds, 28 of them building the corpus. Whatever kept
the fixture from being run at its stated size, it was not the cost of running
it.

**The four human-path numbers are flat across fifty times the corpus**, which is
the claim ADR-03 makes and the only one this fixture had to settle. Capture is
0.03ms whether the database holds 2,000 entries or 100,000 alongside a million
events; the startup banner is 0.05ms; both recalls are unchanged from 20k. Every
budget in quality.md is met with three orders of magnitude to spare.

**Semantic search is flat and keyword search is not.** The 5,000-vector scan
bound holds exactly as ADR-03 says it does — 5.8ms at 20k, 5.3ms at 100k, and
the extra 80,000 entries cost nothing because they are never read. Keyword
search grows with the corpus and slightly faster than it — 6.4x for 5x the
entries — and hybrid inherits the whole of it, so the mode a developer gets by
default went from 17ms to 58ms. Still well inside the 300ms budget, but the same
slope puts half a million entries in the hundreds of milliseconds, and the bound
that keeps semantic search flat has no counterpart on the keyword side.

Read the keyword number with the fixture in mind. The corpus is generated from a
twenty-word vocabulary, so nearly every entry matches nearly every query and
bm25 ranks the entire corpus on every search. That is a worst case, not a
typical one — real vocabulary is far larger and the match set far smaller. It is
the same worst case at all three sizes, so the curve between them is honest;
the absolute number is pessimistic.

### The one thing that degraded badly: the worker

Summarising one 40-event batch costs 1.2ms at 2k events, 26ms at 200k
(`results/2026-09-22-memory-perf-20k-events.json`, a control run at 20k entries
with the evidence scaled and everything else held) and 613ms at 1,000,000. Five
hundred times slower for five hundred times the evidence, to write one entry
from forty rows: the batch's own input never grew. The cause is two full scans
per batch: `batchEvents` reads `SELECT * FROM evidence_events WHERE batch_id = ?`
and the worker closes with `UPDATE evidence_events SET status = 'summarized'
WHERE batch_id = ?`, and `009_memory.sql` indexes `evidence_events` on
`(project, occurred_at)`, `(session_id, occurred_at)` and `(status, project)` —
not on `batch_id`. `EXPLAIN QUERY PLAN` says `SCAN evidence_events` for both.

The cost is per batch and linear in the whole evidence table, so the total work
of summarising a database grows with the square of what has been captured. It
also never shrinks on its own: `memory.retention_days` defaults to null, so
nothing prunes evidence unless the developer asks for it.

This is on the worker's path, not a human's — it runs at the session seam, after
the Stop hook, and 613ms there is not felt the way 613ms before a prompt would
be. It is reported as the run's most valuable result because it is the only
measured thing whose cost grows while its own input stays the same, and because
the fix is one index on `batch_id` in a new forward-only migration.
Naming the fix is not making it: this eval says the number.

The control run is also the proof that it is the evidence table and not the
entries: at 20k entries, scaling events from 2k to 200k left every search and
recall number inside noise and moved the worker alone, from 1.1ms to 26ms.

### Whether 20k was representative

For the four human-path numbers and for semantic search, yes — the flat lines at
20k stayed flat at 100k, and nothing the plan leaned on those for has changed.

For the worker, no, and the reason is worth stating plainly: **the 2k and 20k
runs never scaled the evidence table.** Both wrote about 2,000 events whatever
the entry count, so the 20k run measured a worker against 1/100th of the
fixture's evidence and reported 1.1ms. The quadratic was invisible at both
sizes, not because it was small but because the axis that drives it was pinned.
A fixture that grows one dimension and holds the other flat will keep reporting
that the held dimension is free.

That is also why `--events` fills before the capture timings rather than after:
had it filled after, `capture append` would have been measured against an empty
evidence table at every size, and the one write on every tool call would have
been the next number to look better than it is. It does not — 0.029ms against a
million rows — but the run had to be able to say so.

### What this run does not close

The entry-count axis only. quality.md's fixture is 100,000 entries, 1,000,000
evidence events **and 10 simultaneous coding sessions**, and the concurrency
half was not attempted: it needs a harness that does not exist — several
processes on one WAL database, contending writes, `busy_timeout` under real
pressure — and ADR-11 keeps it declined. Nothing here says anything about what
happens when ten sessions write at once, and no performance claim at team scale
should be read out of this table.

### The scan the fixture found, and the index that fixed it

Running the fixture `quality.md` actually asks for — 100,000 entries and
1,000,000 evidence events — turned up a real defect rather than a number.
`evidence_events` carried no index on `batch_id`, and both queries the worker
uses to read and retire a batch key on exactly that, so `EXPLAIN QUERY PLAN`
reported `SCAN evidence_events`. Summarising one forty-event batch cost a pass
over every event ever captured: **1.2ms at 2,000 events, 26ms at 200,000,
613ms at 1,000,000**, for input that never grew. Total summarising work over a
database's life was quadratic in its own history, and `memory.retention_days`
defaults to null, so nothing flattened the curve.

Migration `014_batch_events_index.sql` adds the index. Measured after, same
harness, same machine:

| events | worker, one 40-event batch |
|---|---|
| 200,000 | 26ms → **0.9ms** |
| 1,000,000 | 613ms → **1ms** |

`migrate.test.ts` asserts the query plan rather than the index name, because the
failure to prevent is the scan, not the spelling.

Worth naming why this hid for so long: the 2k and 20k runs wrote a fixed ~2,000
events whatever the entry count — a hundredth of the fixture's 10:1 ratio — so
they measured the worker against an evidence table two orders of magnitude too
small and reported 1.1ms. The quadratic was invisible because the axis driving
it was pinned, not because it was absent. A baseline that holds one axis still
is not a baseline; it is a shape you chose.


</details>

## Not built yet

The board lists four harnesses. Three are built.

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
