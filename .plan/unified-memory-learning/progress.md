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
| 12 | Code search/outline + collections | 5 | done — the three tools were built and left out of the registry; fixed, with a test that reads the source rather than the array |
| 13 | Host adapters + workflows breadth | 5 | replay + capability descriptors done; Claude Code is the only proven host, and one of twenty workflows ships |
| 14 | Optional remote (server, sync, notifications) | 6 | notifications and directory sync done; the hosted server declined (ADR-09) |
| 15 | Cutover, soak, release docs | 7 | runbook, export/restore and the PR body written; the cutover against real data and the soak still need a human |

## Measured, not asserted

Numbers this branch can back up, with the command that produces them. Re-run
them rather than trusting this table.

| What | Measured | How |
|---|---|---|
| Reuse saving on a realistic corpus | **89%** — 6,366 source tokens against 674 delivered, six entries | eight sessions of a prompt and ten edits each, summarised, then one seam recall |
| Reuse saving on a trivial corpus | **overhead**, and reported as overhead | one tiny session: an observation is longer than the tool call it summarises. The arithmetic says so rather than clamping it to zero |
| Capture, per tool call | 0.03ms median, flat from 2k to 20k entries | `node eval/memory-perf.mjs --entries 20000` |
| Startup display | 0.03ms median, flat | same |
| Recall at a seam | 0.14ms median, flat | same |
| Hybrid search, 20k entries | 17ms median | same; on an agent's path, not a human's |
| Retrieval quality | hybrid ahead of keyword on top-1 and recall; both miss the synonym query, as ADR-03 predicts | `node eval/retrieval-harness.mjs` |

The first two rows together are the honest shape of the savings claim: it is
large once there is history and negative when there is not, and the product
says which without being asked.

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

## Release readiness

Written at `a94d6ad` against the source, not against this tracker.
[parity.md](parity.md)'s status table is the row-by-row version; this is the
part a maintainer has to decide on.

### What a developer can do now that they could not before

Eklavya remembers the project, not just the learner. Every tool call, every
prompt and every session boundary is captured as typed evidence through one
privacy filter, batched, and distilled into entries by a local summariser that
needs no credentials and makes no network call. At the next session start the
relevant ones come back as model context, with a receipt that says how many
tokens the index cost against what reading the same history would have cost —
so the saving figure on the dashboard is checkable rather than asserted.

Concretely, and all of it new on this branch:

- **Ask what happened.** `/eklavya:memory`, eight `memory_*` MCP tools, and
  `eklavya memory search|timeline|show` outside a session. Search is keyword,
  semantic or hybrid; everything is scoped to the project unless asked
  otherwise.
- **Correct the record.** `memory_write`, `memory_correct` and `memory_delete`
  — a superseded entry leaves retrieval and stays in the timeline, so the audit
  trail survives the correction.
- **See it.** Four new dashboard routes: the timeline, one entry down to the
  raw evidence behind it, the reuse receipts, and capture health.
- **Bring history with them.** `eklavya memory import` reads a Claude Mem
  database at the pinned schema, with `--dry-run`, `--resume` and project
  mapping, never mutates the source, and files imported concepts as unassessed
  candidates rather than as mastery somebody did not earn.
- **Recover what hooks never saw.** Transcript replay captures sessions from
  before the install, or from a misconfigured hook, converging with live
  capture by content instead of double-recording it.
- **Carry it between machines.** `eklavya memory sync push|pull|status` against
  a shared directory — Dropbox, iCloud Drive, Syncthing, a mounted share, a git
  repository. Entries, tags and tombstones cross; attempts, mastery, gates,
  receipts and raw evidence never do. Off in the shipped defaults.
- **Keep learning working with quizzing off.** `memory.enabled` is a separate
  decision from `mode` (PRD CFG-01), and all four memory-carrying hooks do their
  memory work before their `mode` check. `mode: off` means no quizzes, not no
  project history.
- **Learn from what the agent forgot to log.** Evidence produces concept
  candidates, and the Stop hook fills in for a session that logged nothing. An
  observation still never records an attempt, moves mastery, or opens a gate.

Defaults are unchanged for anyone who does not want any of it: no provider, no
notification sink, no egress.

### What is explicitly not built

Three things are declined with an ADR behind them, and a maintainer should be
able to say so out loud:

- **The hosted team server** (PAR-27, ADR-09). Not built, and not deferred to a
  later sprint — a hosted service is an operation, not a module. Team-shared
  project memory, scoped API tokens and server-side job administration are not
  available. What did ship is the directory target: a team that wants shared
  memory points every member's `sync.target` at one shared folder, which gives
  sharing without tenancy, and tenancy is the part that needs an operator.
- **A resident background daemon** (PAR-16, ADR-05). Jobs run in a short-lived
  leased worker the hooks and CLI start on demand.
- **Neural embeddings and a real parser** (PAR-07/ADR-03, PAR-10/ADR-07). The
  embedder is `local-hash-v1` and the code tools are a declaration scanner. Both
  ceilings are stated in the manual rather than hidden, and ADR-03 records a
  second one found by measurement: the semantic scan is bounded to the 5,000
  most recent vectors per query.

Five more are **not built and have no ADR**, which is a different thing and
should not be read as closed scope: the dashboard configuration editor
(PAR-19), the presentation surface (PAR-20), memory profiles (PAR-22), managed
`CLAUDE.md`/`AGENTS.md` blocks (PAR-25), and scoped host caches (PAR-30).
Nineteen of the twenty mapped assistant workflows (PAR-31) are in the same
position. If the intent is to decline them, they need an ADR before release,
not a silence.

**One thing is a bug rather than a gap, and it should not ship as-is.**
`TOOLS` in `mcp/src/tools/index.ts` imports `codeOutline`, `codeFindSymbol` and
`memoryCollections` and never adds them to the array, so the server registers
seventeen tools while the manual and `skills/memory/SKILL.md` document twenty.
`server.integration.test.ts` compares the advertised list against `TOOLS`
itself, so it cannot catch this. Three identifiers fix it.

### What still needs a human

None of these can be done in CI, and none of them should be waved through.

1. **The cutover trial against real Claude Mem data.** `memory-import.test.ts`
   exercises the importer against a synthesised database at the pinned schema.
   Nobody has run it against a database with a year of somebody's actual
   history in it — the one that has the odd row, the orphaned reference, the
   project name that does not map to any checkout on this machine. The runbook
   is `web/src/content/docs/docs/migrating.mdx`. Run it with `--dry-run` first
   and read the report; that is what it is for.
2. **The multi-session soak.** The hook tests spawn hooks one at a time and
   `memory-integration.test.ts` runs one loop through the real built hooks.
   Neither answers what a week looks like: whether the queue keeps up under a
   provider, whether capture latency stays flat as the corpus grows past the
   sizes `eval/memory-perf.mjs` measured, whether two checkouts open at once
   ever cross their evidence. `eval/results/2026-09-22-memory-perf-20k.json` is
   a synthetic baseline, not a lived one.
3. **Anything that needs a second host.** PAR-24 claims Claude Code and nothing
   else. Cursor and Cowork are capability descriptors written from
   documentation with no fixture behind them, and the other nine reference
   targets have no entry at all. Promoting any of them needs a transcript
   fixture from a real session on that host.
4. **Sync between two real machines.** `memory-sync.test.ts` converges two
   temporary directories, quarantines conflicts and ignores half-written
   records — but a local filesystem is not Dropbox. What a cloud client does
   with a temp-then-rename under contention, and how long a record takes to
   appear on the other device, are both properties of the folder somebody
   chooses, not of this code. Point two machines at one shared folder and watch
   it for a week before the manual promises it works.
5. **A provider run.** Every test is hermetic against the local summariser by
   design (ADR-04). The `anthropic` provider path — including its `auth` and
   `quota` pause classes — has not been exercised against the real API.

### The four failing tests are not regressions

`cd mcp && npm test` at `a94d6ad` reports **4 failed, 812 passed (816)** across
37 files — the pass count moves as tests land, the failure count does not. All
four are caused by an **untracked `.eklavya.json` at the repository root**
containing `{"mode": "off"}`.

| File | Failing test |
|---|---|
| `test/stdin.test.ts` | still does its work, rather than degrading to an empty input |
| `test/stdin.test.ts` | survives a byte-order mark, which some Windows shells prepend |
| `test/stdin.test.ts` | exits, rather than printing and lingering forever |
| `test/server.integration.test.ts` | logs work, quizzes it, grades it, and stops asking once it is known |

The three `stdin` cases assert that a hook prints its `[Eklavya]` banner and
that `eklavya statusline` prints and exits; `mode: off` is the documented off
switch for exactly those, so the hooks correctly print nothing and the
assertions correctly fail. The integration case fails for the same reason one
layer up. Verified by moving the file aside and re-running the two files: **14
passed, 0 failed**, then moving it back.

It is a repo-local config a developer left behind, not a tracked file and not
part of this branch. Delete it or move it aside before reading a test run.
- 2026-09-22: the three gaps the parity audit found are closed — raw evidence
  on `memory_get`, memory in `eklavya doctor`, and `eklavya memory restore` so
  the export is a backup rather than a file nothing opens. The six rows with
  no decision behind them are now ADR-10.
- 2026-09-22: the suite is green — 836 tests, 37 files, nothing skipped. The
  four that used to fail were reading the contributor's own `.eklavya.json`
  because they ran in the checkout; they run in a scratch directory now.
- 2026-09-22: PR body in [pr-body.md](pr-body.md), with an unedited runtime
  transcript through the built hooks. The acceptance test in `CONTRIBUTING.md`
  still needs a real interactive session before merge — the model asking the
  question mid-task is the part no fixture can stand in for.
