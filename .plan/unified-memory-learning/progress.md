# Implementation progress

Live tracker for the unified memory + learning program. Updated as each
increment lands. Phase names map to [delivery.md](delivery.md).

## Increments

| # | Increment | Phase | Status |
|---|---|---|---|
| 1 | Architecture decisions (ADR) | 0 | done |
| 2 | Memory schema + numbered migration | 1/2 | done |
| 3 | Memory store, identity/time policy, privacy filter | 1/2 | done |
| 4 | Capture pipeline: hooks, spool, replay | 2 | not started |
| 5 | Observation jobs + provider adapter + local summarizer | 2 | not started |
| 6 | Retrieval: keyword + semantic + hybrid, scoping | 3 | not started |
| 7 | Context receipts, savings arithmetic, startup display | 3 | not started |
| 8 | MCP memory tools + CLI subcommands | 3/5 | not started |
| 9 | Learning links: evidence to concept candidates | 4 | not started |
| 10 | Dashboard memory surfaces | 4 | not started |
| 11 | Import from the pinned Claude Mem fork | 4 | not started |
| 12 | Code search/outline + collections | 5 | not started |
| 13 | Host adapters + workflows breadth | 5 | not started |
| 14 | Optional remote (server, sync, notifications) | 6 | not started |
| 15 | Cutover, soak, release docs | 7 | not started |

## Log

- 2026-09-22: tracker created; Phase 0 decisions recorded in [adr.md](adr.md).
- 2026-09-22: migration 009 adds the memory half of the schema — evidence,
  batches, jobs, entries, FTS5 + vectors, receipts, candidates, collections.
  `mcp/src/memory/` gains identity, privacy, tokens, embeddings, store and
  search; the clock policy moves to `mcp/src/time.ts` so both halves share it.
