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

## Re-run after the `upsert_concepts` fix

Same command, same 15 trials, unchanged guidance, after the handler change (`2026-10-11-extraction-after-upsert-fix.json`).
75 calls, 1,674,947 input tokens (878,163 cached), 94,937 output, about $3.85.

| | Before | After |
|---|---|---|
| Follow-ups that asked for a domain, stored as `general` | 104 of 104 | **0 of 103** |
| Trials passing every gate | 3 of 15 | 9 of 15 |
| Gate failures | `context_file` 11, `context_decision` 5 | `context_decision` 5, `context_file` 1 |
| Mean score | 0.506 | 0.747 |
| Recall (sonnet / haiku) / precision | 0.91 (0.93 / 0.89) / 0.99 | 0.91 (0.94 / 0.87) / 0.96 |

The fix does what it says: every follow-up's domain is now stored. **The jump in gates passed is not the fix.** The
fix cannot change whether a context names a file, and the guidance was identical, so 3 of 15 and 9 of 15 are two draws of
the same prompt. At 5 fixtures × 3 repeats the run-to-run spread is about as big as any change a candidate could make, so
a candidate has to win by a margin well past this one to mean anything.

## GEPA search

`optimize --metric-calls 60 --max-model-calls 450 --max-minutes 90`, 8 train and 3 val fixtures, `sonnet` as the reflection
model. 10 proposals, 180 generation and judge calls, 4,364,822 input tokens (2,263,214 cached), 243,503 output, about $10.13.
No call errors.

**No candidate won; the selected one is the shipped block, unchanged.** 9 of 10 proposals scored 0 on their sample and 1
scored 1.79 against 2.41 for the shipped block. 27 of the 63 scored trials were rejected for passing the 2000-token ceiling
without a model call: the skill has about 30 tokens of headroom, and the reflection model's proposals add more than that.
So the search spent its calls on the proposals the ceiling rejects, and the test split was not touched. There is no
candidate to compare with `report`.

## Next

1. Decide the context-file rule (strict, or a function or setting name counts). It decides most of the score.
2. A second search that tells the reflection model the shipped block's exact word count and the 30-word limit, so proposals
   are shortened or traded for words elsewhere in the file. Cost similar to this search.
3. Before trusting any candidate: more repeats or fixtures than 5 × 3.
