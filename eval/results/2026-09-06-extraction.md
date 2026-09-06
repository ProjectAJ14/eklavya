# Concept extraction — first run

**2026-09-06** · `node eval/harness.mjs extract` · 3 fixtures, 8 hand-labelled
concepts · generator and both judges Claude Code's default model · raw numbers
in `2026-09-06-extraction.json`

Extraction is upstream of everything else the eval measures. If it picks the
wrong concepts, every question afterwards is well-formed and about the wrong
thing — and `score` calls that run clean, because a good question about an
irrelevant concept is still a good question.

## What would make this wrong

- **The labels are one person's phrasing of a diff they wrote.** That turned out
  to be the whole story of this run; see below.
- **Three fixtures, eight labels, 20 logged concepts.** Nothing is significant.
- **Generator and both judges are the same model family**, so the judged numbers
  may be measuring the judge. Not yet run with a second model.
- **The coverage judge is lenient by construction** — it is asked whether a
  logged name means the same as a labelled one, and "means the same" is exactly
  the judgement no threshold could make. It is the right question and a soft one.

## The result

| | |
|---|---|
| Labelled concepts matched **by slug** | **0 of 8** (0%) |
| Labelled concepts covered once a judge allows a different name | **5 of 8** (63%) |
| Logged concepts matching a label **by slug** | **0 of 20** (0%) |
| Logged concepts a judge called genuinely exercised | **16 of 20** (80%) |
| Shape checks (count 3–8, valid slugs, context present, context names the code) | **all passed** |

**Extraction is not the problem. The measurement was.**

Zero and zero, against 63% and 80%, is not a tool failing to find concepts — it
is a tool naming them differently from the labeller. The model logged
`sqlite-wal-mode` where the label said `wal-journal-mode`, `answer-position-bias`
where the label said `position-bias-in-assessment`, and
`transaction-rollback-and-retry-safety` where the label said
`idempotency-and-safe-retries`. Those are the same ideas.

So the strict rows above measure agreement on phrasing, and they are published
mainly to record that they are the wrong metric. **Semantic recall is the number
to carry forward**, and 63% with 80% precision on a first run is a reasonable
place to start from.

## What this found in the product

Scoring used the product's own matcher, and that is what makes the zeroes
interesting rather than merely a bug in the eval. `findFuzzyMatch` merges two
slugs at `FUZZY_MATCH_THRESHOLD = 0.8` on token-set overlap. Measured on the
pairs above:

| Pair | Score | Result |
|---|---|---|
| `wal-journal-mode` ~ `sqlite-wal-mode` | 0.50 | kept separate |
| `busy-timeout-versus-retry` ~ `sqlite-busy-timeout` | 0.40 | kept separate |
| `position-bias-in-assessment` ~ `answer-position-bias` | 0.40 | kept separate |
| `idempotency-and-safe-retries` ~ `transaction-rollback-and-retry-safety` | 0.13 | kept separate |

`log_session_concepts` mints a new bare concept for anything it cannot match. So
a session that names a concept the way this model did creates a **second node
for an idea already in the graph** — which is the "slug sprawl turning the graph
into mush" that `slug.ts`'s own header says the normalisation exists to prevent.

The real graph on this machine shows it: **249 concepts against a seed catalogue
of 87**, and **30 pairs scoring between 0.5 and 0.8** — plausibly one idea each,
kept apart by the threshold. Examples:

```
0.75  forward-only-migrations       ~  forward-only-sql-migrations
0.67  express-middleware            ~  express-middleware-order
0.60  claude-code-hook-lifecycle    ~  claude-code-hooks-lifecycle
```

**The threshold is not simply too low, and this is the part worth being careful
about.** Some of those 30 pairs must stay separate — `refresh-token` ~
`refresh-token-rotation` is in the list, and it is the exact pair `slug.ts`'s
comment cites as one that must never merge. Token overlap cannot tell "the same
idea in different words" from "related but distinct", so no single number on
this metric fixes it.

The last row is the one that settles the direction: `hook-lifecycle` and
`hooks-lifecycle` differ by a plural and are unarguably one concept. A stemmer
in the tokeniser would merge that and `forward-only-migrations` without touching
`refresh-token-rotation`. That is a targeted change to the product, it is
outside this eval's scope, and it needs its own card and its own tests — the
existing suite asserts no two shipped seed concepts match, and that assertion has
to keep holding.

## What was not measured

Whether the concepts a session logs are the ones worth *teaching* — as opposed to
merely present in the diff. The judge here was asked whether the code exercises a
concept, not whether a developer would benefit from being asked about it.
