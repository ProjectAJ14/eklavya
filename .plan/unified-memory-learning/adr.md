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

**Measured.** `eval/memory-perf.mjs`, baselines in `eval/results/`. At 20,000
entries on an M-series laptop: capture 0.03ms, the startup display 0.03ms and
recall 0.14ms — all three constant in corpus size, which matters because all
three sit on the path of a human action. Hybrid search is 17ms, on an agent's
path where it is invisible.

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
`OPS-01`'s single-lifecycle rule is satisfied by one `runtime/lifecycle.ts` that
every caller uses; the daemon form arrives only if measurement shows the
on-demand worker is too slow.

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
