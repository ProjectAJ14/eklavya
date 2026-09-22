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
