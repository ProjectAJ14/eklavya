# Concept extraction: baseline of the shipped guidance

**2026-10-11** · `python3 eval/gepa/extraction/run.py evaluate --split test --repeats 3` · 5 test
fixtures × 3 repeats = 15 trials · generator Claude Code's default model · coverage judges `sonnet`
and `claude-haiku-4-5` · raw trials in `2026-10-11-extraction-baseline.json`. Method and score:
`eval/gepa/extraction/README.md`. This is the baseline only: no GEPA search and no candidate has been run.

## Cost

75 calls (15 generation + 15 follow-up generation + 45 judge), 1,669,993 input tokens (899,695 cached),
102,217 output, about $3.79 at list price. No call errors, nothing stopped early.

## What would make this wrong

- **5 fixtures, 15 trials.** Three repeats of one fixture are not three independent fixtures.
- **Both coverage judges are Claude models**, and so is the generator. They agreed on 87% of covered labels.
- **The context gate is strict by the issue's definition** (below), and it decided most of the score.

## Result

| | |
|---|---|
| Trials passing every gate | **3 of 15** |
| Mean score | **0.506** (0.99 when every gate passes, 0.32–0.42 when one fails) |
| Gate failures | `context_file` 11, `context_decision` 5; no other gate failed |
| Recall, judged | **0.91** (sonnet 0.93, haiku 0.89) |
| Precision, judged | **0.99** |
| Context sharing an identifier with the diff | 0.99 |
| Follow-up (domain, tier and a `prerequisite_of` edge per created concept) | 0.87 |
| Strict slug recall / precision (the product's matcher) | 0.33 / 0.17, published as a record of what they do not measure |
| Mastered concept logged | 0 of 15 |

**Extraction quality is high and the score is low because of the contexts.** What the model logged
was almost always genuine and mostly covered the labels. 11 of 15 trials had at least one `context` with
no file name or path, for example "sleepBriefly(i) in retryOnBusy waits between attempts…". It names the
function and the decision, not the file. The skill's own good example names one ("…in auth.ts:42"), so the
gate is fair to the guidance as written, but the gate and the skill's wording together are the only
thing separating most of these trials from a pass. Whether a function name should count as naming the
file is a call for the maintainer; the numbers above are with the strict reading.

The score is also bimodal: `ci-cache-and-pipefail` and one `mastered-http-caching` trial passed everything
(0.99, 1.00), and the other 12 sat near 0.41. A mean over 5 fixtures hides that.

## What this found in the product

`upsert_concepts` leaves an existing concept's domain and tier alone, and every `created` concept
already exists when the skill says to follow up. **In 104 of 104 follow-ups that asked for a real domain,
the database still held `general`.** Only the edges are applied. The eval scores the call, as the issue
specifies. This is a product question, not a prompt one, and no guidance candidate can fix it.

## Next

1. Decide the context-file rule (strict, or a function or setting name counts).
2. Run `optimize` on train and val, then the candidate on this test split with the same 3 repeats.
   A search with `--metric-calls 60` is several times this run's $3.79.
