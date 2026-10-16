# Prompt feedback: the review states all four areas, 2026-10-16

Harness: `eval/gepa/feedback/run.py` on `claude/feedback-page-redesign-489c8b` (code from
`0a03ac0`). Reviewer `claude-haiku-4-5`, judge `sonnet`. Test split: 5 invented sessions × 3
repeats = 15 reviews per run, 2 workers. Baseline is the rubric 2 wording and schema
(`eval/gepa/feedback/rubric-2.json`, scored through today's parser with its gaps). Candidate is
the shipped rubric 3 `REVIEW_SYSTEM`, which adds `review.areas`.

Run A: both runs in parallel. Run B: one after the other.

| | Rubric 2, A | Rubric 3, A | Rubric 2, B | Rubric 3, B |
|---|---|---|---|---|
| Mean score | 0.602 | 0.529 | 0.441 | 0.426 |
| Mean score of finished reviews | 0.695 (13) | 0.721 (11) | 0.601 (11) | 0.710 (9) |
| Reviewer timeouts (100 s) | 2 | 4 | 4 | 6 |
| Pass every gate | 8/15 | 7/15 | 5/15 | 6/15 |
| Finished reviews failing `valid` | 0 | 0 | 0 | 0 |
| Failed `grounded` | 4 | 4 | 6 | 3 |
| Areas agreement | n/a | 0.841 | n/a | 0.833 |
| Planted gap areas named | 0.897 | 0.939 | 0.818 | 0.926 |
| Tokens in (cached) / out, list price | 84,866 (12,870) / 78,989, $0.57 | 98,052 (10,890) / 91,666, $0.66 | 98,183 (10,890) / 85,488, $0.63 | 83,786 (8,910) / 74,959, $0.54 |

## Against the handoff's acceptance

- **Score drop at most 0.03:** missed in run A (0.073), met in run B (0.015). Pooled, 0.044.
- **`valid` at 100%:** met. Every review that finished passed the shipped parser in all four runs.
- **Areas agreement at least 0.75:** met, 0.84 and 0.83.

## What this does and does not show

- Every lost point is a reviewer timeout, which scores 0. Counting only reviews that finished,
  rubric 3 scores higher in both runs (0.721 against 0.695, 0.710 against 0.601).
- Rubric 3 timed out more in both runs (10 of 30 against 6 of 30). Asking for `areas` is a
  plausible cause, because it adds output. The same baseline also timed out twice as often in
  run B as in run A, so load moves this number as much as the wording does.
- In the product, a timeout leaves the session unreviewed and a later start tries again. It
  delays a review and does not lose one.
- 15 reviews per run is small. The same rubric 2 wording scored 0.602 and 0.441.
- The wording was not tuned. The handoff says to stop and report when a threshold is missed.
