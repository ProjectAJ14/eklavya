# Memory token report, 2026-10-18

What memory put into the model's context, counted from the receipts and the read
log in one learner database. Produced by `eval/memory-tokens.mjs`: no model
calls, no tokens spent, deterministic for a given database.

Method: `sqlite3 ~/.eklavya/knowledge.db ".backup <tmp>"`, then
`node eval/memory-tokens.mjs --db <tmp>` on the copy (239 MB; the real file was
only read). Token counts are the product's `chars4-v1` estimate (four characters
per token), the same estimate the receipts store. Observer helper sessions
(the 1.24.0 incident) are excluded, as `receiptTotals` excludes them: they hold
about 2.1M of the 5.25M delivered tokens in this database.

## The two things to read first

1. **The comparison line is against re-sending raw history, not against no
   memory.** "Base" is the estimated size of the raw evidence (tool output,
   diffs, prompts) behind the recalled entries. "73% smaller" means the recall
   block is smaller than that raw evidence. With memory off, none of those
   tokens are sent at all, so every injected token is added cost. Memory pays
   back only when a session needs an earlier decision, fix or unfinished work.
2. **Models rarely read what recall points at.** Over the window where reads are
   logged, 98% of recall blocks were never followed by a `memory_*` read in
   their session. A read is also not proof of use, and no read is not proof of
   non-use (the model can act on the injected text alone). This report cannot
   say which.

## Window where reads are logged (from 2026-10-05T08:35:56Z)

Reads were not logged before migration 018, so only this window can say whether
a block was followed. It is also the window with `emitted` receipts only.

```
Memory token report · receipts 2026-10-05T08:56:42.051Z to 2026-10-18T12:40:05.337Z · tokens are chars4-v1 estimates

sessions with memory activity: 509 (helper sessions excluded)

Injected by the hooks (what memory added to context, before any read):
  session_start    1,141,209
  prompt             356,689
  file_context         2,659
  total            1,500,557
  built but never written (not counted above): 1 blocks, 2,266 tokens

Spent on reads (memory_search / memory_get / memory_timeline / memory_file_history results):
  memory_get                 4 calls      6,111 tokens
  memory_search              5 calls      3,831 tokens
  total                      9 calls      9,942 tokens

Memory tokens placed in context, injected + read: 1,510,499

Recall blocks and what followed:
  recall blocks written:                     1,498
  followed by a read that named the block:   1 (0%)
  followed by any read later in the session: 26 (2%)
  never followed by a read:                  1,472 (98%)
  A read shows memory was fetched, not that the answer used it.

Comparison line (same arithmetic as the dashboard and `eklavya memory status`):
  base 5,581,569 tokens of raw evidence vs delivered 1,503,172: 73% smaller
  That is versus re-sending the raw history. It is NOT a saving versus no memory:
  without memory none of the delivered tokens would be sent, so memory adds them,
  and pays back only when a session needs an earlier decision, fix or unfinished work.
```

## Everything in the database (from 2026-09-22)

Includes about 4,200 legacy `confirmed` receipts from before the read log
existed, so the "never followed" rows here are overstated and should not be
quoted. The injected totals and the comparison line are valid.

```
Memory token report · receipts 2026-09-22T22:03:38.578Z to 2026-10-18T12:40:05.337Z · tokens are chars4-v1 estimates

sessions with memory activity: 2,091 (helper sessions excluded)

Injected by the hooks (what memory added to context, before any read):
  session_start    2,567,953
  prompt             569,948
  file_context         2,659
  total            3,140,560
  built but never written (not counted above): 1 blocks, 2,266 tokens

Spent on reads (memory_search / memory_get / memory_timeline / memory_file_history results):
  memory_get                 4 calls      6,111 tokens
  memory_search              5 calls      3,831 tokens
  total                      9 calls      9,942 tokens

Memory tokens placed in context, injected + read: 3,150,502

Recall blocks and what followed:
  recall blocks written:                     3,512
  followed by a read that named the block:   2 (0%)
  followed by any read later in the session: 29 (1%)
  never followed by a read:                  3,483 (99%)
  A read shows memory was fetched, not that the answer used it.

Comparison line (same arithmetic as the dashboard and `eklavya memory status`):
  base 8,096,413 tokens of raw evidence vs delivered 3,143,621: 61% smaller
  That is versus re-sending the raw history. It is NOT a saving versus no memory:
  without memory none of the delivered tokens would be sent, so memory adds them,
  and pays back only when a session needs an earlier decision, fix or unfinished work.
```

## Limits

- Estimates, not a tokenizer, not API billing, not prompt-cache accounting. A
  block injected at session start is carried (and usually cached) for the rest
  of the session; this counts it once, as the receipt does.
- Injected tokens exclude later `memory_get` charges (those are counted under
  reads). `chargeDetail` in `mcp/src/memory/store.ts` recomputes a receipt's
  `delivered_tokens` from its items, which drops the wrapper tokens for charged
  receipts; only 2 receipts here were charged, so the effect is small.
- "Followed by a read" is a session-level link: a read at or after the recall
  in the same session. Only `memory_get` can name a receipt, so the "named the
  block" row is a floor.
- Nine reads in total (4 `memory_get`, 5 `memory_search`) across 13 days is a
  small sample. It shows how rarely reads happen here; it cannot show how often
  they help.
- Base counts whole-file snapshots stored with edits, so the percentage is an
  upper bound, as the manual already says. `file_context` receipts carry base 0
  and claim no saving of their own.
- One developer, one machine. It says nothing about another install and
  nothing about claude-mem (not measured here).
- Not measured: whether the injected text changed any answer. The eval that
  tests that is `eval/memory-use-harness.mjs`, which calls the model.
