# Implementation progress

Live tracker for the unified memory + learning program. Updated as each
increment lands. Phase names map to [delivery.md](delivery.md).

## Increments

| # | Increment | Phase | Status |
|---|---|---|---|
| 1 | Architecture decisions (ADR) | 0 | done |
| 2 | Memory schema + numbered migration | 1/2 | done |
| 3 | Memory store, identity/time policy, privacy filter | 1/2 | done |
| 4 | Capture pipeline: hooks, spool, replay | 2 | done |
| 5 | Observation jobs + provider adapter + local summarizer | 2 | done |
| 6 | Retrieval: keyword + semantic + hybrid, scoping | 3 | done |
| 7 | Context receipts, savings arithmetic, startup display | 3 | done |
| 8 | MCP memory tools + CLI subcommands | 3/5 | done |
| 9 | Learning links: evidence to concept candidates | 4 | done |
| 10 | Dashboard memory surfaces | 4 | done |
| 11 | Import from the pinned Claude Mem fork | 4 | done |
| 12 | Code search/outline + collections | 5 | done |
| 13 | Host adapters + workflows breadth | 5 | replay + capability descriptors done |
| 14 | Optional remote (server, sync, notifications) | 6 | notifications done; server and sync outstanding |
| 15 | Cutover, soak, release docs | 7 | not started |

## Log

- 2026-09-22: tracker created; Phase 0 decisions recorded in [adr.md](adr.md).
- 2026-09-22: migration 009 adds the memory half of the schema — evidence,
  batches, jobs, entries, FTS5 + vectors, receipts, candidates, collections.
  `mcp/src/memory/` gains identity, privacy, tokens, embeddings, store and
  search; the clock policy moves to `mcp/src/time.ts` so both halves share it.
- 2026-09-22: capture is wired into the hooks. A seventh hook, `capture-tool`,
  records every tool use; the nudge captures the prompt; the Stop hook closes
  the batch at the seam; SessionStart replays the spool, drains the queue and
  injects recalled evidence. All four do their memory work before their `mode`
  check, because `memory.enabled` is a separate decision.
- 2026-09-22: the SessionStart greeting is the UX-01 three-line display —
  heading, reuse saving, this project's counts with the level runway folded in.
  The dials moved to the status bar and the weak list to the dashboard; the
  hero terminal, `installing.mdx` and `first-session.mdx` are re-quoted.
- 2026-09-22: eight memory MCP tools (`memory_search`, `_get`, `_timeline`,
  `_file_history`, `_status`, `_write`, `_correct`, `_delete`) landed inside
  the previous commit by accident — a parallel `git add -A` swept them in.
- 2026-09-22: evidence produces concept candidates, and the Stop hook fills in
  for a session that logged nothing. An observation still never records an
  attempt, moves mastery, or opens a gate.
- 2026-09-22: structured code exploration and saved collections, with ADR-07
  and ADR-08 recording the declaration-scanner ceiling and the refused
  empty rebuild.
- 2026-09-22: transcript replay captures what hooks never saw — sessions before
  the install, a misconfigured hook, a hookless host — through the same
  privacy filter, converging with hook capture by content rather than by
  identity. Host capability descriptors record what each host can actually
  deliver; only Claude Code is claimed as proven.
- 2026-09-22: the dashboard gained four memory routes and two paged resource
  endpoints; the importer reads the real pinned schema (version 52); the CLI
  gained `eklavya memory`; the site, manual and README say all of it. A ninth
  slash command, `/eklavya:memory`, is on the landing page and in the manual.
