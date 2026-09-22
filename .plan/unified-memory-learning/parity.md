# Functional parity ledger

Reference: Claude Mem fork 13.25.3,
`e04a091f822c90b69fa19bc52f7f3cf80674b1ae`. Eklavya baseline: 1.18.3.
The capability inventory below is the **requirements** list, unchanged since it
was written. [Status at `a94d6ad`](#status-at-a94d6ad) is where each row's
actual state is recorded, with the file or test that proves it.

"Required, optional activation" means the capability ships but needs configuration
or opt-in. It must not become a permanent scope exclusion. Phases are defined in
[delivery.md](delivery.md); validation families in [quality.md](quality.md).
The source inventory is broader than either earlier comparison's recommendation
table. New discoveries at the pinned revision must be added before claiming parity.

## Capability inventory

| ID | Required capability | Reference evidence | Eklavya outcome / verification | Phase |
|---|---|---|---|---|
| PAR-01 | Automatic tool/prompt/lifecycle capture | `plugin/hooks/hooks.json`, `src/cli/handlers/` | Typed evidence enters one privacy-filtered pipeline without explicit concept logging. Q02/Q03. | 2 |
| PAR-02 | Background observation generation and compression | `src/services/worker/*Provider.ts` | Bounded, batched structured generation with provider-independent failure classes. Q03/Q05. | 2 |
| PAR-03 | Session summaries and transcript recovery | `src/services/transcripts/`, `handlers/summarize.ts` | Resumable transcript replay, finalization, and linked summaries; no duplicate live/replayed work. Q03. | 2 |
| PAR-04 | Startup/resume/compaction context | `handlers/context.ts`, `services/context/` | Relevant bounded model context plus minimal human display; idempotent lifecycle handling. Q01/Q02. | 3 |
| PAR-05 | Prompt-relevant and per-file context | `handlers/session-init.ts`, `handlers/file-context.ts` | Configured relevance and freshness checks; preserve requested file contents. Q06/Q07. | 3 |
| PAR-06 | Progressive search/timeline/detail/raw evidence | `src/servers/mcp-server.ts` | All tool outcomes below, with project scope at search and hydration. Q06. | 3 |
| PAR-07 | Full-text, semantic, hybrid retrieval | `services/worker/SearchManager.ts`, `services/sync/ChromaSync.ts` | Keyword fallback plus required semantic capability, measured recall, explicit index readiness. Q06/Q08. | 3 |
| PAR-08 | Observation and summary data management | `worker/http/routes/DataRoutes.ts`, `MemoryRoutes.ts` | Browse, manually add, edit/correct, delete, bulk manage, cite provenance, audit changes. Q07/Q10. | 3 |
| PAR-09 | Raw tool evidence and observation links | `services/sqlite/tool-uses.ts` | Stable evidence links; privacy/retention also apply to raw details. Q03/Q07. | 2 |
| PAR-10 | Structured code exploration | `services/smart-file-read/` | Search, outline, expand symbols, language support/fallback verified against the pinned parser registry. Q06. | 5 |
| PAR-11 | Knowledge collections / focused agents | `worker/knowledge/`, `CorpusRoutes.ts` | Build/list/query/prime/rebuild collections with persisted filters and safe revisions. Q06/Q10. | 5 |
| PAR-12 | Export, import, backup, historical backfill | `scripts/export-memories.ts`, `scripts/import-memories.ts`, transcript processor | Versioned Eklavya format; Claude Mem import; resumable backfill; restore drill. Q10/Q11. | 4 |
| PAR-13 | Private content, tool/project/path exclusions | `utils/tag-stripping.ts`, `worker/http/shared.ts` | Filter before every data sink, with negative leak tests. Q07. | 2 |
| PAR-14 | Event/job/result deduplication | `SessionMessageBuffer.ts`, `tool-uses.ts`, `SessionStore.ts` | Stable IDs and transactional completion survive replay; preserve legitimate repetition. Q03. | 2 |
| PAR-15 | Project, checkout, host, parent/agent identity | `utils/project-name.ts`, `utils/worktree.ts`, `cli/types.ts` | One resolver; explicit cross-project access; retain existing learning worktree semantics. Q04. | 1–2 |
| PAR-16 | Continuous local service | `worker-service.ts`, `worker-spawner.ts`, `infrastructure/` | Single owned lifecycle, health/readiness, bounded startup/stop/upgrade; dashboard stays available. Q02. | 1–2 |
| PAR-17 | Diagnostics, status, logs, repair | `shared/observer-health.ts`, `LogsRoutes.ts`, CLI doctor | End-to-end health and specific remediation, redacted bounded logs, no false green state. Q05/Q09. | 2 |
| PAR-18 | Live viewer/dashboard | `src/ui/viewer/`, `ViewerRoutes.ts` | Combined memory/learning dashboard, replay-safe live updates, accessible navigation. Q09. | 4 |
| PAR-19 | Dashboard configuration editor | `ContextSettingsModal.tsx`, `SettingsRoutes.ts` | Typed scoped settings, preview effective values, safe mutation and credential handling. Q07/Q09. | 4 |
| PAR-20 | Presentation / TV surface | `src/ui/tv.html`, `ViewerRoutes.ts` | Optional Eklavya presentation view with privacy controls and bounded stream access. Q09. | 5 |
| PAR-21 | Statusline integration | `plugin/scripts/`, installer/statusline behavior | Compose with an existing statusline; install/restore without clobbering user configuration. Q11. | 4 |
| PAR-22 | Custom profiles and multilingual modes | `plugin/modes/`, `services/domain/ModeManager.ts` | Eklavya memory profiles, inheritance/validation/localization, every shipped profile accounted for. Separate from learning mode. Q12. | 5 |
| PAR-23 | Multiple inference providers and routing | Claude/Gemini/OpenRouter/OpenAI-compatible provider modules; host observer support | Equivalent provider/auth routes, model selection and tier routing via a common contract; no mandatory paid account. Q05/Q12. | 2, 5 |
| PAR-24 | Host integration breadth | `npx-cli/commands/ide-detection.ts`, `services/integrations/` | All 12 targets below plus retained Eklavya surfaces; capability-specific contracts, no invented hook support. Q12. | 5 |
| PAR-25 | Managed instruction/context files | `utils/claude-md-utils.ts`, `agents-md-utils.ts`, host installers | Opt-in Eklavya-owned blocks, atomic writes, user-content preservation, reversible removal. Q07/Q11. | 5 |
| PAR-26 | Multi-device / cloud synchronization | `services/sync/`, `workers/sync-hub/` | Optional Eklavya-owned sync with identities, revisions, tombstones, conflict repair, and offline recovery. Q13. | 6 |
| PAR-27 | Remote/server runtime and team access | `src/server/`, `storage/postgres/`, runtime CLI | Optional deployment from this repo; authenticated scoped APIs, jobs, usage administration, tenant isolation. Q13. | 6 |
| PAR-28 | External session notifications / wrap-ups | `TelegramNotifier.ts`, `TelegramWrapupNotifier.ts` | Optional configured destinations, preview/redaction, delivery retries and dedupe. Never send by mere installation. Q07/Q13. | 6 |
| PAR-29 | Usage and cost observability | `services/telemetry/`, `shared/observed-billing.ts` | Local receipts/provider usage plus optional consent-based analytics; distinguish unknown costs and estimates. Q01/Q07. | 3, 6 |
| PAR-30 | Scoped host memory/cache awareness flows | GrokBot awareness/index modules, CcsAlign modules | Eklavya equivalents for scoped caches, hierarchy/exclusions, and host-aware delivery; opt-in writes. Q04/Q12. | 5 |
| PAR-31 | Shipped assistant workflows | All 20 `plugin/skills/*/SKILL.md` entries | Outcome-equivalent Eklavya workflows mapped below; respect action permissions and existing release policy. Q12. | 5–6 |
| PAR-32 | Install/update/uninstall and dependency integrity | `src/npx-cli/`, build scripts, plugin manifests | One canonical install identity, reproducible artifacts, version handshake, complete uninstall, data preserved. Q11. | 1, 7 |
| PAR-33 | Learning integration beyond reference parity | Existing Eklavya MCP, hooks, skills, packs, SRS, gates | Preserve existing learning and add evidence-grounded concepts; all existing acceptance paths pass. Q14. | 1, 4 |
| PAR-34 | Standalone cutover | New Eklavya requirement | Fresh capture, recall, summary, teaching, and dashboard work with Claude Mem absent. Q15. | 7 |

## MCP outcome mapping

These are proposed Eklavya names, not an implementation change. Some reference
tools are runtime-specific or hidden by its visibility policy; inventory includes
all 20 definitions, not just the advertised subset. Equivalent overlapping
operations may share one Eklavya tool. Preserve argument/filter/batch behavior
through tested contracts rather than copying unnecessary duplicate tools.

| Reference definition | Proposed Eklavya surface | Required outcome |
|---|---|---|
| `important_workflow` | Memory usage instructions / `memory_help` when needed | Explain index → timeline → selected details without exposing a redundant tool by default. |
| `search` | `search_memory` | Compact scoped results, filters, ranking, pagination. |
| `timeline` | `get_memory_timeline` | Context around an entry or query, before/after bounds. |
| `get_observations` | `get_memories` | Batch hydrate selected IDs with authorization/scope checks. |
| `get_tool_uses` | `get_memory_evidence` | Selected raw sanitized tool inputs/results with provenance. |
| `session_start_context` | `get_session_context` | The same bounded context builder used by hooks. |
| `observation_add` | `add_memory` | Persist a validated manual memory with source/type. |
| `observation_record_event` | `record_memory_event` | Submit a normalized event through the common ingest use case. |
| `observation_search` | `search_memory` | Equivalent remote/server observation search with consistent filters. |
| `observation_context` | `get_memory_context` | Scoped contextual retrieval under an explicit budget. |
| `observation_generation_status` | `get_memory_status` | Accepted/pending/processing/paused/failed/completed generation status. |
| `smart_search` | `search_code` | Structural code search with bounded results. |
| `smart_unfold` | `get_code_symbol` | Full requested symbol, source location, and truncation disclosure. |
| `smart_outline` | `get_code_outline` | Structural map and accurate line numbers. |
| `build_corpus` | `create_memory_collection` | Persist filter/query/source identity and collection revision. |
| `list_corpora` | `list_memory_collections` | Discover collections with scope and freshness. |
| `prime_corpus` | `load_memory_collection` | Prepare collection context in the supported agent session. |
| `query_corpus` | `query_memory_collection` | Evidence-grounded collection questions and citations. |
| `rebuild_corpus` | `refresh_memory_collection` | Reapply stored filters without silently destroying prior scope/content. |
| `reprime_corpus` | `reload_memory_collection` | Refresh the agent's collection context to a selected revision. |

Keep the existing nine Eklavya tools: `get_learner_profile`,
`log_session_concepts`, `get_session_quiz_plan`, `record_attempt`,
`get_gate_status`, `upsert_concepts`, `get_concept_graph`, `get_config`, and
`set_config`. Tool discovery must be bounded: expose relevant groups by host/runtime
capabilities without concealing advertised functionality or breaking existing clients.

## Shipped workflow mapping

Source: the 20 skill directories in the pinned `plugin/skills/`. Reading them for
inventory does not invoke their instructions or authorize their external actions.
Keep useful functionality under Eklavya naming; optional workflow groups can be
discoverable without loading all instructions into every coding session.

| Reference skill | Proposed Eklavya workflow | Acceptance |
|---|---|---|
| `mem-search` | `memory` | Answer a past-work question through scoped progressive retrieval. |
| `smart-explore` | `explore` | Locate symbols/structure before fetching full code. |
| `learn-codebase` | `survey` | User-requested codebase familiarization with coverage/provenance and a bounded budget. |
| `knowledge-agent` | `collection` | Build, load, query, refresh a focused knowledge collection. |
| `timeline-report` | `history` | Source-linked project development narrative. |
| `weekly-digests` | `digest` | Date-bounded consecutive reports without skipped weeks or invented events. |
| `mode-creator` | `memory-profile` | Create/validate/activate custom profiles, localizations, and optional notification configuration. |
| `cloud-sync` | `sync` | Configure, inspect, pause, and repair optional synchronization. |
| `how-it-works` | `help-memory` | Explain actual installed behavior, data flow, storage, and controls. |
| `make-plan` | `plan` | Evidence-based phased implementation plan. |
| `do` | `implement` | Execute an authorized plan with verification and supported delegation. |
| `babysit` | `watch-pr` | User-requested PR/review monitoring with actionable updates. |
| `standup` | `standup` | Read-only consolidation across worktrees/branches/PRs. |
| `oh-my-issues` | `triage` | Cluster issue causes and propose changes; external edits require explicit authorization. |
| `pathfinder` | `architecture` | Feature flows, duplicate concerns, and proposed architecture. |
| `design-is` | `design-review` | Structured design critique with actionable follow-through. |
| `what-the` | `explain` | Plain-language technical explanation grounded in evidence. |
| `wowerpoint` | `present` | Requested document-to-slide/PDF narrative output with layout verification. |
| `version-bump` | `release-check` | Consistent version/build/release preparation through Eklavya's existing release policy. |
| `ccs-align` | `workspace-memory` | Scoped intermediate cache, exclusion marks, hierarchical rules, and health-aware refresh. |

Do not replace existing `/eklavya:learn`, `quiz`, `progress`, `gate`, `level`,
`mode`, `pack`, `setup`, tutor behavior, or the user-level chat skill. Avoid name
collisions and duplicate registration across plugin/user-skill surfaces.

## Host and provider inventory

`src/npx-cli/commands/ide-detection.ts` names these 12 installation targets:
Claude Code, OpenCode, OpenClaw, Windsurf, Codex CLI, Cursor, Grok Bot, Copilot CLI,
Antigravity, Goose, Roo Code, and Warp. Each needs a capability entry, supported
version range, install/uninstall fixture, lifecycle/capture route, context delivery
route, and real-host smoke evidence. MCP-only and transcript-watch integrations
must be described as such; they must not claim hooks or interactive tutoring their
host cannot provide. Retain Eklavya's Cowork handling, CLI, Cursor rules export,
and editor-independent Git gate.

Provider families in the reference include Claude/Agent SDK, Gemini, OpenRouter,
OpenAI-compatible endpoints, and host-assisted observers. Inventory actual auth,
model/tier routing, custom endpoints, rate limits, and deployment-specific routes
before each adapter ships; don't turn a provider's marketing model catalogue into
a claim of tested support. Remote credentials are optional. Every shipped adapter
runs the same generation/failure/usage contract suite. Memory profile inventory
covers all pinned `plugin/modes/*.json`, including localized coding and noncoding
profiles; preserve semantic outcomes rather than importing unvalidated prompts.

## Status at `a94d6ad`

Read on 2026-09-22 against `docs/unified-memory-learning` at commit `a94d6ad`,
by opening the source rather than the plan. Every "done" below names a test in
`mcp/test/` that fails if the capability regresses; a row with no such test is
not marked done however finished the code looks.

**The four markers, used precisely:**

- **done** — implemented, and covered by a named test.
- **partial** — implemented with a stated ceiling. The ceiling is named on the
  row, and where an ADR decided it, the ADR is cited.
- **declined** — deliberately not built, with the ADR that records the decision.
- **not done** — not built, and **no ADR records that choice**. These are open
  scope, not closed scope, and they are the rows a reader should not mistake
  for either of the two above.

Two caveats on the whole table. The branch was moving while it was written:
every row was read at `a94d6ad`, and PAR-26 was re-read at `25d08bf` after sync
landed mid-pass. And four tests fail on a clean checkout for a reason that has
nothing to do with this branch; see [progress.md](progress.md)'s
release-readiness section.

| ID | State | Evidence, or why not |
|---|---|---|
| PAR-01 | done | `capture-tool` (no matcher) plus prompt and lifecycle capture at the other three seams; `mcp/src/memory/capture.ts`. `memory-capture.test.ts` covers gating, minimal mode and Eklavya's own traffic; `memory-integration.test.ts` drives the real built hooks end to end. |
| PAR-02 | done | `memory/worker.ts` leases jobs from `memory_jobs`, `memory/summarize.ts` is the local default and `memory/provider.ts` the configured one; failure classes are provider-independent (`auth`/`quota` pause, malformed output gives up). `memory-capture.test.ts` "the job worker", `memory-store.test.ts` "jobs". |
| PAR-03 | done | `memory/replay.ts` reads the transcript directory, applies the privacy filter, is idempotent, and converges with hook capture by content. `memory-replay.test.ts`, nine cases. |
| PAR-04 | done | `session-start.ts` replays the spool, flushes the seam, records the lifecycle event and injects `recallBlock` before any `mode` gate; the human display is the three-line UX-01 banner. `memory-recall.test.ts` "the startup display", `hooks.test.ts` "SessionStart output". Compaction and resume arrive on the same event, read from `input.source`. |
| PAR-05 | **partial** | Per-file context is done: `memory_file_history` (`memory-tools.test.ts`). **Prompt-relevant context is not.** `recallBlock` is called from exactly one place — session start — so a mid-session prompt that changes the subject gets no fresh recall. `prompt-submit-nudge` captures the prompt but never retrieves against it. Nothing decided this; it is the cheapest remaining win. |
| PAR-06 | **partial** | `memory_search` → `memory_get` → `memory_timeline` is the progressive path, all project-scoped and tested (`memory-tools.test.ts`). The ceiling is **raw evidence over MCP**: `memory_get` returns `event_ids` but no evidence bodies, so the reference's `get_tool_uses` has no tool equivalent. Raw evidence is reachable only through `eklavya memory show` and the dashboard's `/api/memory/entry` (`dashboard.test.ts` "drills from an entry down to the raw evidence behind it"). |
| PAR-07 | **partial** | Keyword (FTS5/BM25), semantic and hybrid all ship and are selectable per query (`memory/search.ts`, `memory-store.test.ts` "entries and retrieval"); recall is measured by `eval/retrieval-harness.mjs` with `eval/results/2026-09-22-retrieval.json`, and the scorer is unit-tested (`retrieval-score.test.ts`). **Two ceilings, both ADR-03**: the embedder is `local-hash-v1`, which generalises over morphology and typos but not synonymy; and the semantic scan is bounded to the 5,000 most recent vectors per query, so on a large corpus keyword and semantic are answering different questions. |
| PAR-08 | **partial** | Browse (dashboard `#/memory`, `eklavya memory timeline`), manual add (`memory_write`), correct-by-supersede and soft/hard delete (`memory_correct`, `memory_delete`) all ship and are tested (`memory-tools.test.ts`). Provenance and the audit trail hold: a superseded row leaves retrieval and stays in the timeline. **No bulk management** — every write tool takes one id. |
| PAR-09 | done | `evidence_events` rows are linked to entries through `memory_entry_events`; retention never ages out evidence an entry still points at, and the privacy filter runs before the insert rather than before the read. `memory-capture.test.ts` "retention", `memory-store.test.ts` "privacy filter". |
| PAR-10 | **partial** | `memory/code.ts` implements outline, cross-tree symbol search and line expansion, tested in `memory-code.test.ts` including the honest-empty case for an unknown language. Two ceilings. It is a **declaration scanner, not a parser** (ADR-07): no cross-file resolution, no re-exports, no string/declaration distinction. And **the two tools are not registered** — see the note under the MCP mapping below. |
| PAR-11 | **partial** | `memory/collections.ts` saves a filter, materialises members, rebuilds, and refuses a rebuild that would empty a collection that had members (ADR-08); `memory-code.test.ts` "saved collections". Same registration gap: `memory_collections` is defined and not exposed. No prime/query-the-collection behaviour — a collection is a saved filter, not a corpus an agent is primed with. |
| PAR-12 | **partial** | Import from the pinned fork is thorough: `memory/import.ts`, schema version 52, provenance, `--dry-run`, `--resume`, project mapping, WAL-inclusive snapshot, refusal on an unknown newer schema — 22 cases in `memory-import.test.ts`. Export is `eklavya memory export`, a versioned JSON of entries, tags, evidence links and receipts. **There is no import of that export**, so "backup" is one-directional and the restore drill the row asks for cannot be run. |
| PAR-13 | done | `memory/privacy.ts` filters on the way in, at every sink: capture, replay, manual write and notification delivery all call it. Negative leak tests exist in `memory-capture.test.ts` ("stores a redacted body", "never lets an excluded path back in through the event body") and `memory-hardening.test.ts`. |
| PAR-14 | done | `eventUid` hashes host, session, agent, kind, tool, timestamp and body, so replay cannot duplicate a live capture and two legitimate identical edits stay two events. `memory-store.test.ts` "is idempotent on event_uid", `memory-replay.test.ts` "is idempotent". |
| PAR-15 | done | One resolver: `memory/identity.ts`, reconciled with the learning half's `projectKey` in `hooks/memory-lib.ts` so a memory row and a mastery row cannot disagree about the codebase. Worktree semantics unchanged (`worktree.test.ts`); cross-project access is explicit (`all_projects`, `cross_project`). `memory-hardening.test.ts` "Q04 — identity and isolation" covers two repositories with the same folder name, the no-repository bucket, cross-project leakage and subagent attribution. |
| PAR-16 | **declined** | ADR-05. No resident daemon: jobs run in a short-lived worker the hooks and CLI start on demand, guarded by a SQLite claim lease. The reference's worst incidents — orphaned workers, port theft, self-healing that undoes an uninstall — are all daemon properties. The dashboard is an on-demand server, as before. |
| PAR-17 | **partial** | `eklavya memory status` reports entries, pending evidence, queue depth, provider and savings; the dashboard's `#/health` route reports failed jobs **by class and never by message** (`dashboard.test.ts`); a paused queue raises the one interrupting alert (`memory-lib.ts`, `memory-notify.test.ts`). **`eklavya doctor` has no memory checks at all**, and there is no logs surface. A developer whose capture is broken has to know to run a different command. |
| PAR-18 | done | Four memory routes (`#/memory`, `#/entry/:id`, `#/reuse`, `#/health`) beside the learning ones, two paged resource endpoints (`/api/memory`, `/api/memory/entry`), everything escaped. `dashboard.test.ts`, eleven memory cases including "still serves every learning route alongside the memory ones". |
| PAR-19 | **not done** | The dashboard is read-only: `mcp/src/dashboard.ts` handles no `POST` and inspects no `req.method`. Configuration is edited through `eklavya config set`, `set_config` or the JSON files. No ADR records this as a decision. |
| PAR-20 | **not done** | No presentation or TV surface exists. No ADR records the choice. |
| PAR-21 | **partial** | `eklavya statusline` ships and is tested (`cli.test.ts`, `stdin.test.ts`), and `web/.../cli.mdx` shows the `settings.json` block. **The installer does not wire it up**: `mcp/src/install.ts` never touches `statusLine`, so there is no compose-with-an-existing-one behaviour and nothing to clobber or restore. That is safe, and it is not what the row asks for. |
| PAR-22 | **not done** | No memory profiles, no inheritance, no localization. `memory.capture` (`full`/`minimal`/`off`) is the only shape control. No ADR records the choice. |
| PAR-23 | **partial** | The `Summarizer` port has two implementations and nothing enables a provider on upgrade (ADR-04); failure classes are common to both and the local default keeps every test hermetic. **One provider family**: `ProviderConfig.kind` is the literal `'anthropic'`. No Gemini, OpenRouter, OpenAI-compatible endpoint or host-assisted observer. Credentials are named by env var, never stored. |
| PAR-24 | **partial** | ADR-06. `memory/hosts.ts` records capabilities per host with an honest `status` axis, and `provenHosts()` returns only what a fixture has been run through — today, **Claude Code alone**. Cursor and Cowork are `unverified` descriptors; the other nine reference targets have no entry at all. `memory-replay.test.ts` "claims only the hosts a fixture has actually been run through" is what keeps that honest. |
| PAR-25 | **not done** | Nothing writes a managed block into `CLAUDE.md` or `AGENTS.md`; `eklavya export-rules` writes a Cursor rules file the user places themselves, which is a different thing. No ADR records the choice. |
| PAR-26 | **partial** | Landed at `25d08bf`. `memory/sync.ts` plus migration 011, `sync.{enabled, target, device_id}` in the config, `eklavya memory sync push\|pull\|status`, and 21 cases in `memory-sync.test.ts` — device identity, resumable push, tombstone propagation, conflict quarantine and repair in both directions, half-written and hash-mismatched records ignored, and an `ENTRY_COLUMNS` allowlist that keeps attempts, mastery, gates, receipts and raw evidence off the wire. Off in the shipped defaults, and `enabled` alone does nothing without a target. The ceiling is ADR-09's: it is a **directory target**, so there is one `SyncTarget` implementation and no identity, authentication or tenancy. Two real machines converging over a real cloud folder has not been done. |
| PAR-27 | **declined** | ADR-09. The hosted, multi-tenant, authenticated team server is not built, and the ADR says why: a hosted service is an operation, not a module. Team-shared project memory, scoped API tokens and server-side job administration are **not available**. A shared directory gives sharing without tenancy. |
| PAR-28 | done | `memory/notify.ts`: off unless configured, redact before send, deliver once keyed on the event's own identity, per-sink event filtering, and a failing sink reported rather than thrown. `memory-notify.test.ts`, eight cases including "sends nothing at all when nothing is configured". |
| PAR-29 | **partial** | Local receipts are done and honest: base and delivered tokens, a detail fetch revised onto the same receipt, and an unconfirmed or negative result never dressed as a saving (`memory-store.test.ts` "savings receipts", `dashboard.test.ts` "never reports an unconfirmed receipt as a saving"). **Provider usage and cost are not recorded** — no token counts or spend come back off a provider call. Consent-based analytics are absent by design; nothing leaves the machine. |
| PAR-30 | **not done** | No scoped host cache, no hierarchy or exclusion marks, no host-aware delivery beyond the capability descriptors of PAR-24. No ADR records the choice. |
| PAR-31 | **partial** | One of the twenty mapped workflows ships: `skills/memory/` (`/eklavya:memory`), which is the `mem-search` → `memory` row. The other nineteen do not exist. Several of them (`plan`, `implement`, `watch-pr`, `standup`, `triage`, `present`) are general agent workflows with no memory or learning content, and shipping them would make Eklavya a workflow suite rather than a learning tool — but **no ADR records that reasoning**, so this is an open scope question, not a closed one. |
| PAR-32 | done | Pre-existing and unchanged by this branch: `eklavya install` / `uninstall [--purge]`, one canonical install identity, `mcp/test/install.test.ts` and `packaging.test.ts`. The memory half adds migrations 009 and 010, forward-only, with the schema constants bumped in `migrate.test.ts`. |
| PAR-33 | done | Every pre-existing learning test still passes; `memory/learning.ts` proposes candidates and never records an attempt, moves mastery, clears review debt, promotes a level or opens a gate. `memory-learning.test.ts`, twelve cases, including "still records no attempt and no mastery for what it filled in". |
| PAR-34 | **partial** | The mechanism is there and tested — import, capture, recall, summary, teaching and dashboard all work with no Claude Mem present, and `memory-integration.test.ts` runs the loop through the real built hooks. The runbook is `web/src/content/docs/docs/migrating.mdx`. **The cutover itself has not been performed** against a real Claude Mem database on a real machine, and it cannot be: CI has no such file. This is the row that needs a human. |

### Where the MCP mapping stands

Eleven memory tool definitions exist against the reference's twenty. Eight of
the eleven are registered.

| Reference definition | Eklavya tool | State |
|---|---|---|
| `search`, `observation_search` | `memory_search` | done |
| `timeline` | `memory_timeline` | done |
| `get_observations` | `memory_get` | done |
| `observation_generation_status` | `memory_status` | done |
| `observation_add` | `memory_write` | done |
| — (no reference equivalent) | `memory_correct`, `memory_delete`, `memory_file_history` | done |
| `smart_outline` | `code_outline` | defined, **not registered** |
| `smart_search`, `smart_unfold` | `code_find_symbol` | defined, **not registered** |
| `build_corpus`, `list_corpora`, `rebuild_corpus` | `memory_collections` | defined, **not registered** |
| `get_tool_uses` | — | not done; raw evidence is CLI- and dashboard-only (PAR-06) |
| `session_start_context` | — | not done as a tool; the same builder runs in `session-start.ts` |
| `observation_record_event` | — | not done; ingest is the hooks' job, not a tool's |
| `observation_context` | — | not done |
| `important_workflow` | — | not done; `skills/memory/SKILL.md` carries the routing instead |
| `prime_corpus`, `query_corpus`, `reprime_corpus` | — | not done (PAR-11) |

**The registration gap is a bug, not a decision.** `TOOLS` in
`mcp/src/tools/index.ts` imports `codeOutline`, `codeFindSymbol` and
`memoryCollections` and never adds them to the array, so the server advertises
seventeen tools. `web/src/content/docs/docs/memory.mdx` and
`skills/memory/SKILL.md` both document all three as available.
`server.integration.test.ts` compares the advertised names against `TOOLS`
itself, so it agrees with whatever the array holds and cannot catch this. Adding
three identifiers to the array is the whole fix, and it belongs in this branch.

## Closure rules

- Attach implementation PR, test/evaluation evidence, supported host/runtime
  scope, and any limitation to each PAR row as it ships.
- A reference feature that is broken still defines an intended user outcome;
  record the failure and implement the corrected contract.
- Do not replicate forced telemetry, fail-closed memory errors, unbounded retries,
  giant startup messages, hardcoded savings, or unauthorized self-reenable behavior.
  These are undesirable mechanisms/defects, not required user capabilities.
- Vendor names, commercial account ownership, and license notices are distinct:
  product naming is Eklavya's; required attribution for reused code is retained.
- A future upstream feature is a new scope decision. An overlooked capability in
  the pinned inventory is a parity gap and cannot be waived by the implementer.
