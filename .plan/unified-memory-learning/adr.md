# Architecture decisions

Phase 0 decisions, recorded before the phase that implements them, as
[prd.md](prd.md) §8 requires. Each records the choice, the evidence, what was
rejected, and how to back out.

## ADR-01 — One package, module boundaries inside `mcp/`

**Choice.** Memory lives in `mcp/src/memory/` inside the existing package, not a
new workspace. Boundaries are enforced by directory convention and tests, not by
a monorepo build graph.

**Evidence.** The whole runtime is 4.6k lines across 23 modules. A monorepo adds
a build graph, two `package.json` lifecycles, and cross-package versioning to a
codebase that publishes one binary and one MCP server.

**Rejected.** npm workspaces; a separate `@eklavya/memory` package. Both cost
release machinery now and buy isolation the directory already gives.

**Rollback.** Extracting `mcp/src/memory/` into a package later is a move plus a
`package.json`; no consumer imports it by path.

## ADR-02 — One SQLite file, one migration runner

**Choice.** Memory tables join the existing `knowledge.db` under the same
numbered forward-only migrations and the same `openDb` pragmas (WAL, foreign
keys, `busy_timeout`). Memory tables are namespaced `memory_*` / `evidence_*`
and hold no foreign key into learning tables except the explicit
`learning_source` link table.

**Evidence.** Two files means two runners, two backup stories, and no
transaction spanning "this evidence produced this concept candidate". WAL
already supports several sessions plus the git hook.

**Rejected.** A second `memory.db`; a non-SQLite store (Chroma, Redis, Postgres)
as a local dependency — [prd.md](prd.md) §6 forbids requiring them.

**Rollback.** The `memory_*` tables are droppable in one migration; learning data
never references them.

## ADR-03 — Semantic retrieval: local deterministic embeddings by default

**Choice.** Hybrid retrieval = SQLite FTS5 (BM25) fused with cosine similarity
over locally computed embeddings. The default embedder is a dependency-free
hashed character n-gram + token TF-IDF vector, versioned as `local-hash-v1`,
stored as a `BLOB` of float32. A configured provider embedder (`providers.embeddings`)
replaces it and is recorded per row, so vectors of different models never mix.

**Evidence.** The reference's semantic search is a retrieval-quality contract,
not a model contract ([prd.md](prd.md) §6). A local embedder keeps the "nothing
leaves the machine" default true (CFG-02) and adds no install weight; the
alternative candidates (`@xenova/transformers`, ~100MB of ONNX weights on first
run; a provider call per write) both break the default install budget or the
egress promise.

**Honesty constraint.** `local-hash-v1` is lexical-semantic: it generalises over
morphology and typos, not over synonymy. Retrieval quality is measured by the
Phase 3 eval, and the manual says which embedder produced the numbers. No claim
of parity with a neural embedder is made until the eval shows it.

**Rejected.** Neural embeddings as a required dependency; provider-only
embeddings; keyword-only retrieval (fails PRD RET-01).

**A second ceiling, found by measurement.** The semantic scan is bounded at the
5,000 most recent vectors per query (`semanticSearch`'s `scanLimit`). Past that
size, semantic retrieval sees only the newest 5,000 entries of a project while
keyword search still sees all of them — so on a large corpus the two modes are
answering slightly different questions, and hybrid inherits both. The bound is
what keeps the scan linear and predictable: at 20,000 entries a hybrid query is
17ms with it, and would climb without it. It is documented in the manual rather
than hidden, and the number to change if it ever bites is that one constant.

**Measured.** `eval/memory-perf.mjs`, baselines in `eval/results/`. At **100,000
entries and 1,000,000 evidence events** on an M-series laptop: capture 0.03ms,
the startup display 0.05ms and seam recall 0.15ms — all constant in corpus size
across 50x, which matters because all three sit on the path of a human action.
Semantic search is flat at 5.3ms, which is the 5,000-vector bound in this ADR
doing exactly what it was chosen for; keyword is 51ms and hybrid 58ms, on an
agent's path, and slightly worse than linear against a fixture whose small
vocabulary makes nearly every entry match nearly every query.

**Rollback.** `embedder_id` is stored per vector; switching re-embeds in a
background job and the old vectors are ignored, then deleted.

## ADR-04 — Observation generation: pluggable provider, local summarizer default

**Choice.** Observation generation goes through one `Summarizer` port. The
default implementation is local and deterministic — it derives titles, facts,
files, and tags from the evidence itself with no network call. A configured
provider (`providers.observer`) produces richer narratives. Nothing enables a
provider on upgrade.

**Evidence.** CFG-02 forbids an upgrade silently turning on background API
traffic. A local default also keeps capture useful with no credentials, and
makes every test hermetic.

**Rejected.** Requiring an API key for memory to work; spawning the host CLI as
an inference provider by default (unbounded cost, unproven availability).

**Rollback.** The port has two implementations from day one; removing either is
a config default change.

## ADR-05 — No long-lived background service in the first local milestone

**Choice.** Jobs are processed by a short-lived worker the hooks and CLI start
on demand, guarded by a SQLite claim lease, rather than by a resident daemon.
`OPS-01`'s single-lifecycle rule is satisfied by there being exactly one entry
point into the work — `processPending` in `mcp/src/memory/worker.ts`, reached
from precisely two places, `mcp/src/hooks/memory-lib.ts:84` and
`mcp/src/cli.ts:819` — and by the claim lease in `mcp/src/memory/store.ts`
being what makes two of them at once safe. This ADR originally named a
`runtime/lifecycle.ts` that was never written: with no process to own, a
lifecycle manager had nothing to manage, and one exported function reached from
two call sites is the smaller thing that holds the same rule. The daemon form
arrives only if measurement shows the on-demand worker is too slow.

**Evidence.** The reference's worst incident classes — orphaned workers, port
theft, self-healing that undoes an uninstall — are all properties of a resident
daemon. Hooks already run at every seam where work arrives, so there is a
natural scheduler for free.

**Rejected.** A resident HTTP worker with a PID file, now.

**Rollback.** Same lifecycle interface; a daemon becomes one more implementation
behind it.

## ADR-06 — Node and host matrix

**Choice.** Node >= 22, matching the current `engines`. Host adapters are
capability descriptors, not assumptions: Claude Code is the proven host, and
every other host target must ship with a transcript fixture before it is
advertised.

**Evidence.** `better-sqlite3` prebuilds and the existing test suite already
pin 22. Advertising 12 hosts without fixtures is exactly the staleness
[CLAUDE.md](../../CLAUDE.md) warns about.

**Rejected.** Claiming the reference's full host list at ship time.

**Rollback.** Adding a host is a fixture plus an adapter.

## ADR-07 — Code exploration: a declaration scanner, not a parser

**Choice.** `memory/code.ts` finds declarations with per-language line patterns
and reports them with line numbers. `code_outline`, `code_find_symbol` and the
line expansion are built on it. Every tool description states the ceiling.

**Evidence.** The job an outline does is *choosing which file to open* — and a
line-oriented scanner does that as well as a parser for the languages a
declaration is conventionally written on one line. The alternative,
`web-tree-sitter` plus a wasm grammar per language, is roughly 10MB of install
weight for every user, most of whom never call these tools, against an
install budget the PRD asks to keep small.

**Ceiling, stated rather than hidden.** No cross-file resolution, no
re-exports, no distinction between a declaration and one written inside a
string. A language with no pattern reports *no* symbols rather than wrong
ones, and the tool descriptions tell the model that an empty result does not
prove a symbol is absent — otherwise it reads silence as evidence.

**Rejected.** tree-sitter now; an LSP client; shelling out to `ctags`, which is
a dependency on a binary that is absent on most machines.

**Rollback.** One module behind three functions. A parser becomes a second
implementation of `outline()`.

## ADR-08 — A collection rebuild that would empty it is refused

**Choice.** `rebuildCollection` keeps the last good membership and marks the
collection `failed` when the filter now returns nothing and it previously had
members. `force` overrides.

**Evidence.** The reference's reported failure was a rebuild silently replacing
a good collection with an empty one. A rebuild finding nothing where there used
to be something is far more often a broken index or an edited filter than a
genuine emptying, and the two are indistinguishable at the moment of the write
— so the safe default is the one that loses nothing.

**Rejected.** Always overwriting; never overwriting (a collection that really
did empty could never be corrected).

**Rollback.** One conditional.

## ADR-09 — Sync is a shared directory. The hosted team server is not built.

**Choice.** Multi-device synchronisation ships as a **transport-agnostic
directory target**: each device writes revision records and tombstones into a
folder both devices can see, and pulls what the others wrote. Dropbox, iCloud
Drive, Syncthing, a mounted share, or a git repository all work, because none of
them is a dependency — the target is a path.

The hosted, multi-tenant, authenticated team server in the PRD's Phase 6 is
**not built**, and this ADR is where that is recorded rather than left to be
discovered as a missing feature.

**Evidence for the directory.** It is the shape that is testable here and now:
the whole protocol is files on disk, so conflict quarantine, tombstone
propagation and offline recovery all have deterministic tests against two
temporary directories. It also covers what "sync my two machines" actually
means for the developer this tool is for, which is the requirement behind the
parity row.

**Evidence against building the server now.** A hosted service is not a module,
it is an operation: accounts, tenancy, key rotation, backups, an availability
promise, a security boundary that is somebody's job on a Sunday, and a
deployment target none of which exists. Written speculatively it would be
several thousand lines that nobody can run, nobody can test against a real
tenant, and nobody has agreed to operate — the PRD itself says Eklavya "does
not acquire or operate another company's SaaS by copying its client", and
writing one from scratch with no operator is the same mistake in the other
direction.

**What this costs, stated plainly.** Team-shared project memory, scoped API
tokens and server-side job administration are **not** available. The parity
ledger records them as a declined scope item, not as done. A team that wants
shared memory today can point every member's sync target at one shared
directory, which gives sharing without giving tenancy — and tenancy is the part
that needs an operator.

**Reversal.** The sync use cases are written against a `SyncTarget` port with
one implementation. A hosted backend is a second implementation plus the
operational commitment; nothing in the domain or the schema assumes a directory.

## ADR-10 — What is deliberately not built, and why

The parity ledger closed with five rows implemented by nothing and no decision
recorded against them, plus one implemented at one twentieth. A gap with no
reasoning is indistinguishable from an oversight, and the next person to read
the ledger cannot tell which they are looking at. This ADR makes them
decisions. Each is reversible, and each says what would reverse it.

### PAR-19 — no settings editor on the dashboard

**Decline.** The dashboard stays read-only: it handles no `POST` and inspects
no request method.

Writing configuration from a loopback page is not a form, it is a mutation
surface reachable by any web page the developer has open — `DASH-03` already
requires origin validation and authenticated local mutations for exactly that
reason, and DNS rebinding turns "bound to 127.0.0.1" into a weaker promise
than it sounds. Making that safe is real work, and it buys a fourth way to
change a setting that is already changeable from the CLI, from chat, and by
editing two JSON files.

**Reverses when** someone actually wants it, at which point the cost is the
security work and not the UI.

### PAR-20 — no presentation or TV surface

**Decline.** A wall display of one developer's learning history is a niche
feature with a privacy surface: the whole point of a TV view is that other
people can see it, and everything Eklavya holds is about how much somebody
does not yet know. That is not a thing to project onto an office wall by
default, and getting the controls right is more design than the feature is
worth today.

**Reverses when** a team asks for it and can say what should and should not be
on the screen.

### PAR-22 — no memory profiles or multilingual modes

**Decline for now.** `memory.capture` (`full` / `minimal` / `off`) plus the
privacy exclusions are the shape controls. A profile system — inheritance,
validation, localisation, a catalogue of shipped profiles — is configuration
built for a problem nobody using this has reported, and a profile with an
inheritance cycle is a support burden the whole feature has to earn first.

**Reverses when** two real users want materially different observation
vocabularies. The `Summarizer` port is where a profile would be applied, and
it already exists.

### PAR-25 — Eklavya does not write into `CLAUDE.md` or `AGENTS.md`

**Decline, and this one is close to a principle.** The PRD already says memory
must not "continuously rewrite user-owned instruction files" (RET-03).

Eklavya delivers context through the host's documented hook channel, which
needs no ownership of a file the developer wrote, and every managed-block
scheme eventually meets the same three failures: a merge conflict in somebody's
committed instructions, a block that survives uninstall, and an edit inside
the markers that is silently overwritten. `eklavya export-rules` remains the
answer for a host that reads only a rules file — it writes once, where the
developer asks, and never touches it again.

**Reverses only** for a host with no context channel at all, and then as an
explicit opt-in with a reversible removal path.

### PAR-30 — no scoped host caches

**Decline for now.** The capability descriptors in `memory/hosts.ts` record
what each host can deliver; a per-host cache hierarchy with its own exclusion
marks is a second retrieval system for hosts none of which has a fixture yet
(ADR-06). Build the host support first, then find out whether it needs a
cache.

**Reverses when** a second host is proven and measurably slow.

### PAR-31 — one shipped workflow, not twenty

**Decline nineteen.** `/eklavya:memory` ships, because it is the memory half
of a learning tool. Most of the rest — plan, implement, watch a PR, run a
standup, triage issues, present — are general agent workflows with no memory
or learning content in them. Shipping them would make Eklavya a workflow suite
that happens to quiz you, and every one of them is prompt surface loaded into
sessions that did not ask for it.

Parity is equivalent *supported user outcomes*, and the outcome those
workflows serve is not the outcome this tool exists for.

**Reverses per workflow**, if one turns out to need memory or learning to work
— that is the test, not the count.

## ADR-11 — What an audit of this plan against the tree found, and what stays undone

**Choice.** Late in the branch, the plan was audited requirement by requirement
against the code, the tests and the docs — 84 of them: the parity rows, the
quality scenarios, and the PRD's lettered requirements. Fourteen could not be
verified as delivered, and **three of those were rows this ledger marked
`done`**: PAR-03's session summaries, PAR-18's live updates, PAR-28's delivery
retries. Those three are now corrected on their rows, and the two that were
bugs are fixed.

The rest are recorded here as decisions rather than left to be rediscovered.
A plan that quietly drops a requirement teaches nobody anything; a plan that
says which requirement it dropped and what would bring it back is still doing
its job.

**Not built, with the condition that reverses each:**

- **SEC-02's per-class retention.** Only raw evidence expires
  (`memory.retention_days`). There is deliberately no retention for generated
  entries or receipts: the generated memory *is* the product, and a policy that
  deletes it by age would delete the thing the developer came for. Raw evidence
  is different — it is bulky, it is the most sensitive thing stored, and the
  entry built from it survives its deletion. *Reverses* if a regulated user
  needs a hard ceiling on total retention, at which point the classes need
  separate dials rather than one.
- **The PRD §6 layer map and the automated lint/boundary gates.** `mcp/src/` is
  flat plus `memory/`, `hooks/`, `tools/`, `migrations/`; there is no
  `domain/`/`application/`/`adapters/` split, no formatter, no cycle check. At
  this size `tsc` and 870-odd tests catch what those would, and a boundary
  checker for a tree this small is ceremony. *Reverses* the first time a real
  import cycle survives review, or the package outgrows one person's head.
- **MIG-03's cutover watermark.** Solved by sequencing instead: the runbook now
  stops the old capture *before* the import, so there is one recorder from that
  moment and a re-import cannot duplicate the window. No column needed.
  *Reverses* if anyone needs to run both systems concurrently on purpose.
- **Q09's browser-level accessibility evidence.** The XSS fixture is automated;
  keyboard, screen-reader labelling, console cleanliness and 320px were checked
  by hand and reported per change, because a browser harness is a dependency
  and a CI surface for one loopback page. *Reverses* when the dashboard gets a
  second interactive surface, where by-hand checking stops scaling.
- **The reference-comparison harness** in quality.md — running identical
  fixtures through Claude Mem and Eklavya and diffing. It requires keeping the
  reference installed and runnable long after the cutover asks users to remove
  it. The cutover rehearsal against a real 30MB database is the evidence that
  actually mattered, and it was run. *Reverses* if a parity dispute comes up
  that row counts and spot searches cannot settle.
- **The performance fixture's concurrency axis only.** The entry axis is now
  closed: the fixture was run at 100,000 entries and 1,000,000 evidence events
  (`eval/results/2026-09-22-memory-perf-100k*.json`), and it earned its keep by
  finding a defect rather than a number — `evidence_events` had no index on
  `batch_id`, so summarising one fixed-size batch scanned every event ever
  captured, 613ms at a million of them, quadratic over a database's life.
  Migration 014 fixes it; 613ms became 1ms. The four numbers on a human's path
  are flat across 50x the corpus.

  What stays undone is **10 concurrent sessions**, which needs a harness that
  does not exist. *Reverses* before anyone claims a guarantee at team scale —
  and the entry-axis result is the argument for doing it: the 2k and 20k runs
  pinned the evidence-event axis, reported a comfortable 1.1ms, and hid a
  quadratic. A baseline that holds an axis still is not a baseline, it is a
  shape someone chose.

**Evidence.** The audit itself: 84 requirements, each checked against a
`file:line` rather than against this document's own claims. The three false
`done` rows are the argument for doing it — a ledger checked only against
itself will agree with itself.
