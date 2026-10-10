# Does the live option-length check reduce the longest-key leak? (issue #164)

Status: **not answerable yet.** The learner database holds no question answered after #157 shipped.

- Revision: `8b1b8e5` (main). Date: 2026-10-10.
- Command: `cd mcp && npm ci && npm run build`, then a read-only query over `~/.eklavya/knowledge.db` using
  `longestOptionStats` from `mcp/dist/eval/history-stats.js` (same function `npm run eval -- history` uses),
  split at the #157 merge, 2026-10-09 16:20 +0530 = `2026-10-09 10:50:00` UTC (the `ts` column is UTC).
- Model calls: none. Tokens: 0 (not applicable).

## Corpus

One learner (the maintainer). 240 attempts, 225 multiple-choice, 2026-08-26 19:25 to 2026-10-09 04:50 UTC.
Only 44 of the 225 carry stored options (`options`/`option_notes` arrived in migration 019); the rest cannot be measured.

| Side | MCQ attempts | With stored options | Correct option strictly longest (note) | Strictly longest (label) |
|---|---|---|---|---|
| Before #157 | 225 | 44 | 38/44 (86%) | 20/44 (45%) |
| After #157 | 0 | 0 | n/a | n/a |

Chance is 25%. Ties are not counted as leaks. The "note" column is the option's stored note, as `longestOptionStats` defines it;
it is not label plus description combined, which is the measure the issue and #163 use, so it is not comparable with their 35%-46%.

## Answers

- (a) Leak after #157: **no data.** The newest attempt in the database predates the merge by about six hours.
- (b) How often the check fires: **not recorded anywhere.** `sentBack` in `mcp/src/panel.ts` is an in-memory set, the card path's marker
  is a tmpdir file, and a rejected call stores nothing (`panel_questions` has no row for it). A counter is needed to know.
- (c) Rewrite changed or unchanged: **not recorded**, same reason.
- The pre-#157 baseline is high: the correct option's note was strictly longest in 86% of 44 questions, which is the leak #157 targets.

## Counter added

Migration 028 (`option_checks`) now records each send-back (`sent_back`) and whether the second version still tripped the check
(`rewritten` or `unchanged`), on both the panel and the card hook, with no option text. `npm run eval -- history` prints the counts
(`option-length check: N sent back, N rewritten clean, N unchanged and shown anyway`). `sentBack - rewritten - unchanged` is
questions whose rewrite never arrived. A question that passed first time is not recorded. Re-run `history` after a week or two of use;
the split script used above is not committed, because `history` plus the counter replaces it.

## Limitations

- 44 questions from one learner is small and biased.
- Even with post-#157 data, a before/after split cannot separate #157 from #158, #159 and #163, which also changed the tutor.
- Question-eval results before 2026-10-09 used a harness whose `plan` stage ignored focus and difficulty; do not compare them.

## What would change the conclusion

Questions answered after 2026-10-09 10:50 UTC showing the correct option strictly longest near 25% (check works) or still above ~35% (it does not),
and a counter showing how many questions were sent back and how many came back unchanged.
