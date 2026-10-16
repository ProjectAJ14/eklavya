# Concept extraction: eval and GEPA search

> **Manual only.** Nothing runs this automatically. A trial is a `claude -p` call with the tutor
> skill in context (~44k input tokens), a second one when the tool created concepts, and three
> judge calls through the product's `runClaude` (a few thousand tokens each). Measured on
> 2026-10-11: one trial (`evaluate --split test --limit 1 --repeats 1`) was 5 calls, 107,124 input
> tokens (51,892 cached) and 6,937 output, about $0.27 at list price, 79 s. The test split at 3
> repeats is 15 trials, so budget roughly 15× that for a baseline. Start with `--limit 2 --repeats 1`.

Extends the September run (`eval/results/2026-09-06-extraction.md`, `npm run eval -- extract`), whose
main finding was that slug matching measured naming, not extraction. This eval scores what a session
does with `log_session_concepts`, the way the question pilot (#156) and the feedback eval (#167) score
theirs: gates, then weighted quality, a second judge, token tracking and a GEPA search.

## What a trial is

1. The model, given the shipped `skills/tutor/SKILL.md`, the two tool descriptions, the learner
   profile and a diff, writes the `log_session_concepts` call.
2. The product's own handler answers, against a real database in a temp `EKLAVYA_HOME` seeded with
   the shipped catalogue plus the fixture's `mastered` concepts. `matched`, `created` and `next_action`
   are the shipped matcher's. The args are checked by the tool's own zod schema first.
3. If the tool held a lookalike in `needs_decision`, the model sees that response and answers it (a candidate's
   slug, or `new: true`); the whole session is replayed on one database so the result is the session's.
   If created concepts are still `unlinked` (no `prerequisites` given), the model writes the
   `upsert_concepts` follow-up the skill says it owes, which the real handler runs too.
4. Judges see the diff, the labels and the final list.

What GEPA edits: only the `log_session_concepts` block of `SKILL.md` (from "Call `log_session_concepts`
as you implement" to the next heading). A candidate that would push the whole file past the
`packaging.test.ts` ceiling (2000 whitespace tokens, frontmatter included) scores 0 without a model
call. The skill has about 30 tokens of headroom, so a longer block must pay for itself by cutting
elsewhere in the file. GEPA never edits the repository; it writes `best_candidate.md` for a person to
review and paste.

## Fixtures and splits

16 fixtures: the original four (`eval/fixtures/*.json`) and twelve in `eval/fixtures/extraction/`, same
shape (`id`, `title`, `source`, `diff`, `concepts` with slug, domain, tier, description, context), plus
a `kind` and, where the profile matters, `mastered`. `eval/fixtures/extraction/splits.json` holds the
hand-made split: 8 train, 3 val, 5 test. The test split is never shown to the search.

| Kind | Fixtures |
|---|---|
| node / server | `wal-and-busy-retry`, `deterministic-answer-slot`, `nudge-rate-limit`, `plan-jargon-in-context` |
| front-end | `react-debounced-search`, `css-grid-reduced-motion` |
| CI and shell | `ci-cache-and-pipefail`, `bash-deploy-trap` |
| migration | `sql-add-column-backfill`, `sqlite-table-rebuild` |
| refactor | `refactor-extract-function` |
| other languages | `python-context-manager`, `go-errgroup-context`, `rust-borrowing-slices` |
| obvious concept already mastered | `mastered-http-caching`, `mastered-jwt-verify` |

The refactor fixture's labels are the refactor's own modest concepts (the guidance asks for 3 to 8, so
"log nothing" is not an answer a trial can give). The mastered fixtures never label the mastered concept,
and the profile the model sees names it.

## The score

Gates (fail one, score at most 0.5, scaled by how many passed):

| Gate | How |
|---|---|
| `count` | 3 to 8 concepts |
| `valid_slugs` | The tool's schema accepts the call and every slug normalises |
| `context_file` | Every `context` names a file (a path, a name with an extension, or the fixture's own file) |
| `context_decision` | Judge: every `context` is level 2, naming the code and the decision made there |
| `touched` | Judge: every logged concept is one the diff involves |
| `not_mastered` | None of the logged concepts resolves to one the profile says is mastered |

Quality, for the same trial: **recall** of the labelled concepts (judge, 0.4); **precision**, logged
concepts a judge calls genuinely exercised (0.3); **context**, the share of contexts that share an
identifier with the diff (deterministic, 0.15); **follow-up**, for each `created` slug, the
`upsert_concepts` call gave a real domain, a tier and a `prerequisite_of` edge (0.15; 1.0 when nothing
was created, 0 when the follow-up was skipped).

Judges: `--judge-model` (default `sonnet`) does the exercised/touched/context pass and is the first
coverage judge; `--second-judge` (default `claude-haiku-4-5`) is a second coverage judge, because the
September run's generator and judges were one family. Recall is their mean; both numbers and how often
they agree are reported. Both are still Claude models: this reduces, not removes, the shared-family
concern. The strict slug recall and precision (the product's `findFuzzyMatch`) are published beside
them, as a record of what they do not measure.

## Run it

```bash
cd mcp && npm ci && npm run build && cd ..           # the bridge imports mcp/dist

# the shipped guidance on the untouched test split
python3 eval/gepa/extraction/run.py evaluate --split test --repeats 3 --out eval/gepa/runs/ex-shipped.json

# GEPA search (needs Python 3.10+ and the pilot's venv: see ../README.md)
eval/gepa/.venv/bin/python eval/gepa/extraction/run.py optimize --out eval/gepa/runs/ex-search \
  --metric-calls 60 --max-model-calls 400 --max-minutes 90

# the candidate on the same split, then compare
python3 eval/gepa/extraction/run.py evaluate --prompt eval/gepa/runs/ex-search/best_candidate.md \
  --split test --repeats 3 --out eval/gepa/runs/ex-cand.json
python3 eval/gepa/extraction/run.py report eval/gepa/runs/ex-shipped.json eval/gepa/runs/ex-cand.json
```

`--max-model-calls` and `--max-minutes` cap generation, judging and reflection together, and every run
writes a progress file `eval/dashboard.mjs` shows. Ship a candidate only if it wins on the test split;
a guidance change also needs the tutor before/after evidence in `CONTRIBUTING.md` and a look at the
manual's `how-it-works` page.

## Findings so far

Until this PR, `upsert_concepts` did not apply a domain or tier to a concept that already existed, and every
`created` concept already exists when the skill says to follow up. In the baseline all 104 follow-ups that
asked for a real domain left `general` and tier 2 in the database (`eval/results/2026-10-11-extraction.md`).
The handler now fills in a bare `llm` concept, so a re-run reports `stored_as_general` near 0. The score still
grades the call, as the issue specifies.
