# Functional parity ledger

Reference: Claude Mem fork 13.25.3,
`e04a091f822c90b69fa19bc52f7f3cf80674b1ae`. Eklavya baseline: 1.18.3.
All rows below are requirements, not assertions of completed implementation.

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
