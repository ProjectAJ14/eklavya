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
| 13 | Host adapters + workflows breadth | 5 | replay + capability descriptors done; Claude Code is the only proven host, and one of twenty workflows ships — the other nineteen declined (ADR-10) |
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
| Recall at a seam | 0.15ms median, flat | same |
| Recall per prompt, 20k entries | 5.7ms median | same. The one cost paid every time the developer presses Enter, and the reason `recallForPrompt` hands its ranking to `recall` instead of letting it search again — that was 25ms before |
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
- 2026-09-22: recall stopped being a session-start-only thing — a prompt that
  changes the subject gets its own recall, behind a relevance gate and
  deduplicated per session.
- 2026-09-22: the three tools that were written and never wired into `TOOLS`
  are registered, with a `packaging.test.ts` guard that reads the source files
  rather than the array.
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
- 2026-09-22: the installer puts the dials in the status bar, into an empty
  slot only, and removes on uninstall only a line that is exactly its own.

## Release readiness

Written at `067a570` against the source, not against this tracker.
[parity.md](parity.md)'s status table is the row-by-row version; this is the
part a maintainer has to decide on.

### What a developer can do now that they could not before

Eklavya remembers the project, not just the learner. Every tool call, every
prompt and every session boundary is captured as typed evidence through one
privacy filter, batched, and distilled into entries by a local summariser that
needs no credentials and makes no network call. At the next session start the
relevant ones come back as model context — and again mid-session, when a prompt
changes the subject to something the project already knows about — with a
receipt that says how many tokens the index cost against what reading the same
history would have cost, so the saving figure on the dashboard is checkable
rather than asserted.

Concretely, and all of it new on this branch:

- **Ask what happened.** `/eklavya:memory`, eleven memory MCP tools (nine
  `memory_*` plus `code_outline` and `code_find_symbol`), and
  `eklavya memory search|timeline|show` outside a session. Search is keyword,
  semantic or hybrid; everything is scoped to the project unless asked
  otherwise. `memory_get` will hydrate the raw evidence behind one entry on
  request — off by default, capped, and charged to the receipt.
- **Correct the record.** `memory_write`, `memory_correct` and `memory_delete`
  — a superseded entry leaves retrieval and stays in the timeline, so the audit
  trail survives the correction.
- **See it.** Four new dashboard routes: the timeline, one entry down to the
  raw evidence behind it, the reuse receipts, and capture health.
- **Bring history with them.** `eklavya memory import` reads a Claude Mem
  database at the pinned schema, with `--dry-run`, `--resume` and project
  mapping, never mutates the source, and files imported concepts as unassessed
  candidates rather than as mastery somebody did not earn.
- **Back it up and put it back.** `eklavya memory export` writes a versioned
  JSON, and `eklavya memory restore` reads it in again — additive, idempotent, a
  second restore adding nothing, and no attempt, mastery or gate row written.
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

Every declined row now has an ADR behind it — seven of the thirty-four, and no
row left in "not built, nobody decided". A maintainer should be able to say all
of it out loud. The architectural three first:

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

Five more were not built with no decision recorded against them, plus one built
at a twentieth. **They are now ADR-10**, which is the difference between closed
scope and an oversight: the dashboard configuration editor (PAR-19) is a
mutation surface on a loopback page bought for a fourth way to change a setting;
the presentation surface (PAR-20) would project what somebody does not know onto
an office wall; memory profiles (PAR-22) are configuration for a problem no user
has reported; managed `CLAUDE.md`/`AGENTS.md` blocks (PAR-25) are forbidden by
the PRD's own RET-03 and unnecessary while the host has a hook channel; scoped
host caches (PAR-30) are a second retrieval system for hosts that have no
fixture yet. Nineteen of the twenty mapped assistant workflows (PAR-31) are
declined because they are general agent workflows with no memory or learning
content in them — each reverses per workflow, on that test rather than on the
count.

**The registration bug is fixed** (`7652333`). `TOOLS` in
`mcp/src/tools/index.ts` had imported `codeOutline`, `codeFindSymbol` and
`memoryCollections` without adding them to the array, so the server registered
seventeen tools while the manual and `skills/memory/SKILL.md` documented twenty.
`server.integration.test.ts` compares the advertised list against `TOOLS` itself
and could not catch it; `packaging.test.ts` now reads every file under
`mcp/src/tools/` and asserts the registry holds every exported `ToolDef`.

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

### The suite is green

`cd mcp && npm test` at `067a570` reports **840 passed (37 files), 0 failed**,
nothing skipped.

The four that used to fail — three in `test/stdin.test.ts`, one in
`test/server.integration.test.ts` — were never regressions: they ran in the
checkout and so read the contributor's own untracked `.eklavya.json` containing
`{"mode": "off"}`, which is the documented off switch for exactly the banners
they assert. They run in a scratch directory now (`0745d54`), so a repo-local
config a developer left behind no longer changes what a test run says.
- 2026-09-22: a security review of the new surfaces found four issues, all
  fixed with regression tests. The serious one was mine and was reproduced
  before it was fixed: a cloned repository's `.eklavya.json` could install a
  `notifications` command sink, which the Stop hook spawns by itself — code
  execution on `git clone` plus one session. Four settings with effects outside
  the session are global-only now, and `doctor` says when a repo tried.

## Open thread, picked up next

The cutover rehearsal (PAR-34) was run against a **copy** of the real
`~/.claude-mem/claude-mem.db` into a **temp** Eklavya database — the developer's
own data was never written to. It passed:

| Step | Result |
|---|---|
| Dry run, read-only | schema 52, 4,036 observations, 12 projects, 2026-08-13 … 2026-09-22 |
| Import, `--map-here eklavya` | 6,068 rows in 2.4s, validation ok, 4,377 re-indexed |
| Second import | 0 imported, all "already present" — idempotent on real data |
| Learning tables after | 0 attempts, 0 mastery, 0 gates; 6,796 candidates, all unassessed |
| Search | finds real history from a month earlier |
| Source renamed away | a fresh session still recalls — no dependency on Claude Mem's file |
| Export → restore | 23MB out, 4,377 entries + 1,692 evidence back, learning untouched |

**One real gap it found, now closed.** The import created **zero**
`memory_entry_events` links, so an imported observation had no drill-down to the
imported evidence: `memory_get` with `include_evidence` and the dashboard's
raw-evidence view were both empty for imported rows. The restore was not at
fault — it faithfully restored the zero.

Both candidate joins were measured on the real source before either was built:

| Join | Coverage |
|---|---|
| `tool_uses.observation_id` (direct key) | 842 of 1,146 tool uses — but only **220 of 4,036** distinct observations |
| `(memory_session_id, prompt_number)`, prompts → observations | **4,036 of 4,036**, one prompt each, no fan-out |
| The same pair applied to tool uses | recovers **0** of the 304 keyless rows — every one is missing `prompt_number` too — and would fan 842 precise links out to 2,598 fuzzy ones |

So: direct key for tool uses, the pair for prompts, and no fallback for tool
uses at all. `user_prompts` carries no `memory_session_id`, so a prompt's
session resolves through `sdk_sessions` — the same hop the importer already
makes for a prompt's project. Both sides go through `import_id_map`, so a
resumed import links correctly and an unmapped row is skipped rather than
written dangling; `INSERT OR IGNORE` keeps a second import at zero new links.

Verified on the real copy again: **4,878 links**, every one of the 4,036
observation entries now carrying evidence, 1,121 of 1,691 events linked — the
570 left over are the 304 orphan tool uses and 266 prompts whose turn produced
no observation. Four new tests; suite at 862 across 38 files (`bbbcefc`).

`/tmp/ek-cutover/` held the rehearsal and can be deleted; nothing in it is
needed again.

## What is left

Two things, and neither can be done from an agent session:

1. **The acceptance test `CONTRIBUTING.md` defines** — a live interactive
   session where the model asks its question mid-task. A transcript of it goes
   in the PR body.
2. **The real cutover** — the same import, against the developer's actual
   `~/.claude-mem/claude-mem.db`, writing to their actual `~/.eklavya/`. The
   rehearsal is the evidence that it will work; it is not a substitute for
   running it.

The PR body is written and waiting at `.plan/unified-memory-learning/pr-body.md`;
the PR itself is not opened.
