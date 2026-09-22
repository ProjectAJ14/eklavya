# PRD: Eklavya as the single memory and learning plugin

Status: proposed. Owner: Eklavya maintainer. Date: 2026-09-22.

## 1. Outcome and scope

A developer installs Eklavya once. It remembers project work across sessions,
retrieves relevant evidence economically, and helps the developer understand the
concepts behind the agent's work. The developer can remove Claude Mem and maintain
only Eklavya without losing the reference product's supported capabilities.

Full functional parity with the pinned reference is required. That includes
advanced search, structured code exploration, corpora, providers, host adapters,
export/import, synchronization, server/team operation, notification integrations,
custom modes, and shipped workflows. The [parity ledger](parity.md) makes those
commitments explicit. Delivery may be phased; an early local-memory preview is
not the finished replacement.

Parity means equivalent supported user outcomes and contracts, not identical
internal code, model-generated wording, bugs, vendor branding, or service
ownership. Eklavya does not acquire or operate another company's SaaS by copying
its client. Equivalent remote/self-hosted capabilities must live in this repo;
any third-party service connector remains optional and documented.

### Non-negotiable product decisions

- One Eklavya installation; no required Claude Mem plugin, worker, database, or
  package at steady state. An import adapter may read its data during migration.
- Own naming, configuration, storage, documentation, and release process.
- Memory and learning share evidence, but memory is not proof of understanding.
- Compact startup display: heading, context-reuse saving, project learning stats.
- Redesign the dashboard around both memory and learning, preserving existing
  routes and learning views through compatible redirects where necessary.
- Maintain existing quiz cadence, grading, review scheduling, and gate behavior.
- Turn upstream incident lessons into executable contracts and failure tests.
- No claim of zero possible bugs or guaranteed savings. Release claims require
  measured evidence. A working reference reduces discovery, not the need to test.

### What this PR authorizes

This documentation PR defines requirements and a delivery plan. It does not ship
runtime changes, remove Claude Mem, migrate real user data, or enable external
services. Implementation follows in separately reviewable changes.

## 2. Users and journeys

| User / journey | Required result |
|---|---|
| Existing Eklavya learner | Upgrade preserves configuration, attempts, mastery, concept packs, progression, gates, and existing MCP clients. |
| Developer replacing Claude Mem | Preview/import history, verify parity, disable Claude Mem, and continue capturing and recalling work with Eklavya alone. |
| Developer returning after a week | Agent receives relevant decisions, fixes, and unfinished work with provenance; human sees only the compact startup summary. |
| Developer encountering a familiar concept | Tutor uses an actual project example and prior assessment history; exposure alone never raises mastery. |
| Developer with several sessions/worktrees | Correct project/session identity; bounded concurrent processing; no unrelated evidence in recall or questions. |
| Developer who wants memory without quizzes | Disable learning independently; memory keeps working. Reverse configuration also works. |
| Team / multi-device user | Explicitly configured server/sync with scoped access, repairable conflicts, and personal learning privacy. |
| Maintainer diagnosing missing memory | Dashboard/doctor distinguish capture, processing, indexing, retrieval, and injection failures without inspecting raw private logs. |

## 3. Startup experience and honest savings

**UX-01.** Healthy startup must show at most five nonblank display lines, normally
three, with no scrolling table. Illustrative content, with fabricated example
numbers clearly confined to this specification:

```text
Eklavya
Your savings: 85% less context from reuse (estimated)
This project: Learning 5 · Mastered 12 · Due 2
```

No observation timeline, concept names, long standing instructions, configuration
dump, dashboard URL, provider promotion, setup advertising, or warning-style
success banner belongs in this display. Expanded information belongs in the
dashboard and explicit CLI commands. `quiet` suppresses the human display without
disabling memory injection or learning. Do not have the model repeat the banner.

**UX-02.** The human summary and model context are distinct outputs. The latter
contains bounded recalled evidence and necessary learning instructions through
the host's documented context channel. Healthy output must not use exit 2 or an
error banner. Encode one valid response per hook, through one output adapter.
Host-specific rendering must be proven with actual host fixtures and transcript
checks; do not assume `systemMessage`, stdout, or async output has identical
visibility across hosts. Respect 1.18.3's Stop feedback behavior.

**UX-03.** Refresh model context on startup/resume/compaction as supported, but
deduplicate the human banner during the same lifecycle transition. No provider
call or index rebuild may be awaited to produce startup statistics. Show cached
committed values, with degraded/unknown states rather than blocking the session.

### Savings measurement contract

**MET-01.** The displayed percentage describes context-volume reduction for the
selected reused evidence, not API cache hits, total session tokens, billing
savings, or proven task efficiency.

- For each injection receipt, record the unique source evidence IDs, source
  revision, project/session, selection scope, tokenizer or estimator version,
  source-equivalent token count `B`, and actually delivered reuse payload tokens
  `D` including its wrapper and instructions.
- Compute `100 × (B - D) / B` only when `B > 0`, delivery is confirmed, and both
  counts use the same method. Round once for display. Do not compare a tiny index
  with the entire lifetime corpus, count discarded output as delivered, or add
  the same receipt again on retries, resume, or repeated rendering.
- `B` is the readable source material corresponding to selected reused items,
  deduplicated by source identity. It is a counterfactual comparison, not an
  assertion the agent would otherwise have read it. Label estimates visibly.
- The dashboard shows `B`, `D`, net difference, method, provenance, and period.
  Detail fetches update the same reuse episode's total rather than preserving
  the optimistic index-only percentage. Session summaries may show revised totals.
- No reusable evidence: `Your savings: — no context reused yet`.
  Missing source counts or uncertain delivery: `Your savings: — unavailable`.
  Negative saving: show `Reuse overhead: <n> tokens (estimated)`; never clamp a
  cost to a positive saving. An adapter lacking delivery acknowledgment reports
  prepared/estimated context in diagnostics, not confirmed reuse savings.
- Observer, embedding, and retrieval-generation usage is reported separately.
  Do not subtract unlike token types or claim net monetary savings without an
  explicitly defined priced baseline and complete usage data.
- Retrieval recall/precision and source correctness are measured alongside
  payload size. Omitting useful evidence is not an optimization success.

**MET-02.** Learning counts are derived from one shared backend policy at one
clock instant. `Learning`: distinct enabled concepts linked to this project's
work that are not currently known under the decayed-score policy. `Mastered`:
distinct project-linked concepts currently known. `Due`: project-linked concepts
whose review date has arrived; it may overlap the other counts. The dashboard
distinguishes unassessed exposure from attempted learning. Seed catalogue size,
unvalidated extraction candidates, and observations are not learning counts.
Mastery remains learner-global as today; project scope selects the relevant set.

## 4. Functional requirements

### Capture, evidence, and observation generation

**CAP-01.** Normalize host events once: lifecycle, prompts, successful and failed
tool uses where available, reads/edits, relevant assistant completion, delegation,
and transcript replay. Record host capabilities rather than fabricate missing
events. Use explicit project, checkout, session, parent/agent, tool invocation,
occurrence time, receipt time, and source identity. Same-named repositories and
separate host sessions must never share an identity accidentally.

**CAP-02.** One pipeline performs exclusion checks, sanitization, durable append,
and job scheduling for both live events and replay. Hook capture and transcript
watchers must converge without recording duplicates. Apply project/tool/path
exclusions before persistence, logging, provider requests, embeddings, exports,
or notifications. Exclude Eklavya's own infrastructure traffic; deliberately
classify quiz records so they cannot generate recursive memory/quiz loops.

**CAP-03.** Persist sanitized accepted events before acknowledging them as saved.
If the service is unavailable, use a bounded atomic local spool with the same
privacy rules. Replay on recovery. A full disk, exhausted quota, or unreadable
source must produce an explicit degraded state and counts; no promise of saving
events that were not committed. Coding continues through capture failures.

**MEM-01.** Generate structured observations with titles, type, narrative, facts,
concept tags, files, evidence links, and session summaries. Batch by bounded
event count/bytes/time or a session seam; do not require one provider request per
tool call. Store a versioned input batch and prompt/config identity. Long sessions
must rotate observer context without dropping accepted work.

**MEM-02.** Validate provider output against schemas. Distinguish a deliberate
empty result from malformed output, auth failure, quota exhaustion, timeout,
transport failure, and context overflow. Only validated results or an explicit
audited no-op may complete a batch. Persist results and completion atomically.
Model requests can occur more than once after ambiguous failures; storage effects
must be idempotent. Never claim exactly-once external inference or billing.

**MEM-03.** Provide observation create/read/update/delete, typed summaries,
annotations, invalidation/supersession, bulk actions, and raw evidence drill-down
subject to retention/privacy. Generated observations are derived material with
provenance, not trusted instructions. Corrections supersede stale claims while
retaining an audit trail; recalls prefer applicable current evidence.

### Retrieval and reuse

**RET-01.** Support keyword, semantic, and hybrid retrieval; timeline navigation;
batch detail hydration; file-specific history; manual memories; scoped context
generation; and generation status. Project-local scope is the default on all
paths, including batch IDs. Cross-project recall must be explicit. Host-sharing
policy is explicit, not an accidental omitted filter.

**RET-02.** Apply project, permission, type, date, and deletion filters consistently
through candidate selection, ranking, count, pagination, and hydration. Provide
stable ordering/cursors. Multi-word queries are not automatically exact phrases.
Test CJK, mixed-language queries, punctuation, Unicode, and empty queries.

**RET-03.** Deliver compact identifiers/titles before full details, with source
citations and a configurable bounded context budget. Character/byte transport
limits and model token budgets are separate constraints. Memory must not replace
requested file contents, shorten a user's Read operation, elevate stored text to
system instructions, or continuously rewrite user-owned instruction files.
Managed context-file integration is opt-in, scoped, and reversible.

**RET-04.** Structured code search/outline/symbol expansion and persistent focused
knowledge collections are required parity. Collection rebuild preserves filters
and history; a failed or unexpectedly destructive rebuild cannot overwrite the
last good collection silently. Indexes are reconstructible from primary records.

### Learning continuity and integration

**LRN-01.** Keep all current Eklavya capabilities: nine MCP tools, slash/user
skills, concept packs and graph relations, SM-2 scheduling, question history,
MCQ grading cap, outcome semantics, cooldowns, session-off, four learning dials,
per-project difficulty progression, worktree handling, statusline, and both commit
gate paths. Existing public names remain compatible during the transition.

**LRN-02.** Evidence produces concept candidates with confidence and source links.
Validate/deduplicate candidates into the graph using the existing new-concept
budget and prerequisite rules. Preserve explicit agent logging as a fast path;
automatic capture fills omissions. An observation alone never records a passing
attempt, increments mastery, clears review debt, promotes a level, or opens a gate.

**LRN-03.** Unify eligibility, clock parsing, decay, cooldowns, and budget policies
used by the planner, hooks, banner, and dashboard. Preserve deliberate differences
between work and review: review answers consume quiz budget but do not satisfy a
gate for unrelated work. Preserve the 1.18.3 JSON Stop response and loop guards.

**LRN-04.** Preserve the contributor acceptance journey: a question can arrive
before the coding turn ends, then work continues. Do not move all teaching to a
session-end worker. Slow observers must not block coding or gates while waiting
for inference. Candidate evidence arriving late becomes future review material;
it must not retroactively reopen a passed gate or re-arm a completed task.

### Operation, interoperability, and configuration

**OPS-01.** One lifecycle manager owns startup, readiness, stop, and controlled
upgrade of the local background service. Hooks, CLI, MCP, and dashboard use it;
they must not implement separate spawners. One verified service per configured
data directory, with an endpoint descriptor and instance identity. A PID or an
open port alone is not authority. Never kill unrelated processes to reclaim a port.

**OPS-02.** Local setup enables service-on-demand with clear controls. Starting
the browser and starting the service are independent. OS-login startup is optional
and reversible. Disabling/uninstalling must not be undone by self-healing. An
uninstall preserves data by default and removes only owned hooks/config entries.

**CFG-01.** Keep one typed configuration schema with defaults, validation,
descriptions, migration, and exportable reference metadata. Proposed namespaces:
`memory`, `learning`, `retrieval`, `runtime`, `dashboard`, `providers`, `privacy`,
`sync`, `notifications`, `diagnostics`. Existing flat learning keys remain accepted
through a documented compatibility adapter; learning `mode: off` cannot silently
turn off newly enabled memory. Defaults must be visible in one schema, not copied
into every transport. Report invalid/obsolete configuration instead of silently
discarding it. Resolve repo/user/session policy consistently.

**CFG-02.** Memory enablement, learning mode, network/provider access, sync, external
notifications, and optional usage analytics are separate decisions. A cloud
observer requires a documented provider configuration and data-flow disclosure.
Without it, capture/keyword retrieval/learning can remain local and pending
generation is honestly marked. An upgrade may not silently turn the current
"nothing leaves the machine" promise into background API traffic. Local provider
and host-assisted options remain part of parity where the reference supports them.

**EXT-01.** Support all pinned host/provider families, custom multilingual memory
profiles, remote APIs and team authorization, multi-device synchronization,
external wrap-ups, presentation/TV view, and shipped assistant workflows listed
in [parity.md](parity.md). Optional components are isolated modules of this repo.
Local use requires neither a remote account nor the remote/server stack.

## 5. Dashboard product change

This is a required product redesign, not merely a live-refresh patch. Retain the
Eklavya visual language, shared theme tokens, keyboard operation, project scope,
and existing learning drill-downs. A framework change needs demonstrated benefit;
do not make React a parity requirement.

| Surface | Required behavior |
|---|---|
| Overview | Compact memory/reuse and learning summaries; distinguish captured, processed, indexed, reused, exposed, and assessed. |
| Memory | Search/filter/timeline, observation and evidence detail, corrections, supersession, deletion, manual notes, import/export. |
| Learning | Existing concepts, review, projects, domains, accuracy, streaks, prerequisites, question/answer/feedback histories, and level runway. |
| Sessions | One linked timeline of coding evidence, memory summaries, concept candidates, actual questions, and outcomes. |
| Reuse | Receipt-level `B`/`D` arithmetic, estimate labels, delivered/unknown status, subsequent detail cost, and retrieval-quality evidence. |
| Activity / health | Capture heartbeat, queue age/depth, retry/paused reasons, provider/index/sync state, redacted bounded logs, and explicit repair actions. |
| Settings | Effective configuration with scope/provenance; validated updates; provider setup without exposing credentials; privacy, retention, and independent memory/learning controls. |
| Collections / reports | Saved knowledge collections, reports/digests, custom memory profiles, optional presentation view and configured integrations. |

**DASH-01.** Publish committed change notifications using an event cursor/outbox;
SSE reconnect detects gaps and refetches authoritative state. Filesystem watching
alone is not a reliable notification contract for WAL checkpoints, file replacement,
or several writers. A bounded polling fallback is acceptable and must be tested.

**DASH-02.** Keep backend-derived domain truths and pure testable view transforms.
Use paginated resource APIs for large memory history and a compact overview
snapshot; do not send the entire corpus on every change or create SQL per card.
Preserve `/api/state` compatibility while extracting typed contracts. Updating the
existing one-payload dashboard contract requires updating its skill/manual in the
same implementation PR, not silently disregarding it.

**DASH-03.** Preserve filter/route/focus/scroll during updates; support ink/paper,
empty/loading/offline/partial states, keyboard-only use, and narrow screens. Escape
all stored text. Validate origins and authenticated local mutations; loopback alone
does not authorize a hostile webpage to change settings or delete memory.

## 6. Repository and engineering architecture

Start with clear modules in the existing TypeScript package; a monorepo, new
runtime, and broad framework rewrite are not prerequisites. Target responsibility
map (proposed paths, not directories created by this PR):

| Path under `mcp/src/` | Owns |
|---|---|
| `domain/memory/`, `domain/learning/` | Pure policies, identities, invariants, state transitions, score/eligibility calculations. |
| `application/` | Capture, summarize, recall, plan-quiz, record-answer, import, and sync use cases; transactions through ports. |
| `contracts/` | Versioned input/output schemas, typed errors, events, configuration, provider and host capability contracts. |
| `adapters/storage/` | SQLite repositories, numbered migrations, search/index adapters, transactional outbox. |
| `adapters/hosts/`, `adapters/providers/` | Host normalization/output and inference/auth adapters; no duplicated domain policy. |
| `adapters/integrations/` | Optional sync, server persistence, notifications, managed files, external workflow connectors. |
| `runtime/` | One lifecycle manager, scheduler, process ownership, bounded diagnostics, composition root. |
| `transport/hooks/`, `transport/mcp/`, `transport/http/`, `transport/cli/` | Validation, use-case invocation, and response formatting only. |
| `dashboard/` | Router, views, accessible components, pure transforms, resource client, live-update handling. |

Dependency direction: transports/runtime compose application use cases; application
depends on domain and typed ports; adapters implement those ports. Domain imports
no SQL, host SDK, process API, filesystem, clock, or HTTP client. Runtime wires
implementations. The dashboard consumes public contracts, never database internals.
Enforce boundaries and absence of cycles in CI.

Extract existing `store.ts`, planner, installer, CLI commands, and dashboard in
bounded behavior-preserving changes with temporary re-exports. Prefer functions
for pure policy; stateful classes only for owned lifetimes. No new giant service
class, catch-all `utils`, generic plugin framework, duplicated policy engine, or
one-config-key-per-incident design. Formatting, type checks, module rules, hook IO,
owned spawning, and schema/documentation consistency are automated gates.

New internal identifiers use Eklavya vocabulary: memory entry, evidence event,
collection, context receipt, learning source, background service. Use kebab-case
module names, camelCase TypeScript values, PascalCase types, and snake_case SQL/MCP
fields consistent with existing interfaces. Preserve existing public learning names.
`CLAUDE_MEM_*`, upstream table names, and old tool aliases appear only in a named
import/compatibility adapter and attributed source documentation.

Choose Node-compatible storage/index/provider implementations based on parity
and measured quality. Bun, Python, Chroma, Redis, and Postgres are not automatically
required local dependencies. Semantic retrieval remains required even if its
implementation changes; optional server deployment may use a different adapter.

## 7. Data, recovery, privacy, and migration

**DATA-01.** Keep memory evidence/entries/summaries/jobs, retrieval receipts,
collections, and sync state logically separate from concepts/attempts/mastery/
gates. Connect them with explicit learning-source links. Stable internal IDs are
independent of provider conversation IDs. Preserve original timestamps, source
IDs, import provenance, revisions, and project/checkout relationships.

**DATA-02.** Retain numbered forward-only SQL migrations with one guarded runner,
schema checks, transactional steps, backup/restore guidance, and upgrade fixtures.
No DDL in repository constructors or migrations from every hook. Existing
learning data cannot be rebuilt from observations and must never be discarded.
Indexes can be rebuilt; source records and attempts require backups.

**DATA-03.** Memory processing owns durable jobs and immutable input batches.
Persist claim leases, retry classification, deadlines, and terminal status. Recover
expired leases after a crash; reconstruct a provider request from stored inputs
rather than depending on a lost in-memory conversation. Use stable event/job
identities, not a short title-hash window that collapses legitimate repeated work.
Bound storage, logs, concurrency, retries, and retained provider history.

**SEC-01.** Recalled material remains untrusted data with source attribution and
delimiters; sanitization is not a proof against prompt injection. Enforce policy
outside the model. Redact configured secret/path patterns and private sections
before any sink. Malformed private sections err toward withholding sensitive
content. Log identifiers/counts by default. Secrets use supported credential
storage, never exported settings, process listings, logs, or dashboard payloads.

**SEC-02.** Define retention per raw evidence, generated memory, receipts, logs,
and assessments. Deletion removes or tombstones linked search/vector/corpus/sync
material; stale caches must not resurrect it. Provider requests and already sent
notifications cannot be retroactively recalled; communicate those boundaries.
Team-shared project memory does not implicitly share personal learner history.

**MIG-01.** Provide a read-only source inventory/dry-run and a versioned importer
for the pinned Claude Mem database/export plus supported older fixtures. Take a
consistent SQLite snapshot including WAL state; never copy only a live main DB
file. Import observations, prompts, summaries, tool evidence, projects, source
identities, supported settings/profiles/collections, and applicable sync metadata
with an explicit field disposition report. Do not copy active worker jobs,
credential material, or foreign device identity into active runtime state.

**MIG-02.** Resume an interrupted import without duplication. Keep durable ID maps
and checkpoints, validate row counts/checksums/relationships, rebuild indexes,
sample scoped retrieval, and report unsupported fields rather than dropping them.
Unknown newer schema: stop safely with actionable diagnostics. Never mutate the
source or overwrite existing Eklavya learning history. Imported project memories
are unassessed; any proposed learning candidates require normal validation.

**MIG-03.** Cutover sequence: snapshot and preview; import and verify; compare
representative recall and new capture; explicitly disable Claude Mem capture;
run Eklavya-only checks with its source directory made unavailable; then offer
uninstall. Uninstall never deletes the source history automatically. Track the
cutover watermark to avoid live/import overlap. Rollback restores a verified
snapshot and prior binary/config while preserving newly captured Eklavya events
in a documented export; never run an old binary blindly against a newer schema.

## 8. Release definition and unresolved implementation choices

Full replacement requires all mandatory [parity rows](parity.md), all critical
[quality scenarios](quality.md), preserved Eklavya acceptance transcripts,
successful migration/recovery exercises, and a working Eklavya-only installation.
Dashboard and docs changes ship with behavior. Do not market the entire product
as "local only" if configured observers or integrations send data remotely.

Implementation choices to settle through bounded architecture decisions in Phase
0/1: semantic index/embedding backend; supported provider authentication routes;
host-specific informational banner channels; server deployment stack; target
fixture sizes/hardware and finalized performance budgets. These choices may change
mechanisms, not silently remove required capabilities. Record the chosen option,
evidence, tradeoff, and rollback in `.plan/unified-memory-learning/` before its
implementation phase.

The plan does not estimate this program as a few-day copy operation. Phase gates
and test evidence, not line counts or feature checkmarks alone, establish readiness.
