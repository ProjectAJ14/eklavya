# Delivery plan

The destination is full pinned-reference functionality inside Eklavya. Phases
sequence work; they do not authorize silently dropping advanced functionality.
Only this planning documentation is included in the current PR.

## Phase 0 — Freeze contracts and characterize behavior

Deliver the [PRD](prd.md), [parity ledger](parity.md), [evidence review](evidence.md),
and [quality specification](quality.md). Before runtime implementation:

- Reconcile every public tool, route/operation family, CLI command, host capability,
  profile, parser language, provider route, and workflow against the pinned source.
  Expand the capability ledger when a user-visible operation is uncovered; the
  high-level groups are not a substitute for API inventory.
- Build sanitized reference fixtures for capture, summaries, retrieval, imports,
  and Eklavya's existing learning flows. Never commit real learner/memory databases.
- Record current test/evaluation and performance baselines. Fix known divergences
  through separate behavior-change PRs, including stored-versus-decayed mastery
  eligibility, rather than concealing them inside a structural refactor.
- Decide the semantic backend, supported Node/host version matrix, provider/auth
  capability contracts, and supported informational display channels using small
  measured experiments. Record rejected choices and reasons in a short ADR.
- Define the import formats/schema versions actually supported, including the
  pinned fork; older versions require named fixture coverage, not a blanket claim.

Exit evidence: agreed finite inventory, architecture decisions, fixture catalogue,
reference measurements, and confirmed startup display contract. No runtime change
is justified merely by a comparison document's recommendation.

## Phase 1 — Establish clean boundaries without changing the learning product

1. Add formatting, focused lint, module-boundary/type/IO discipline checks.
2. Extract stores, configuration schema, shared identity/time policy, planner
   query loaders and pure selection, installer concerns, thin CLI dispatch, and
   dashboard transforms into the responsibility map in the PRD.
3. Keep temporary compatibility exports and public tool names. Preserve existing
   transaction boundaries and behavior while moving code.
4. Introduce typed evidence/job/receipt/provider/host contracts and a single
   lifecycle interface. Do not add unused scaffolding for every future adapter.

Exit evidence: unchanged acceptance transcripts/evals, existing tests plus boundary
tests pass, no cycles or new `any` escape hatches, no data/config migration merely
to reorganize source. Required policy corrections have their own regression proof.

## Phase 2 — Own capture, persistence, and background processing

1. Implement one service lifecycle with health/readiness and verified ownership.
   Preserve independent learning operation when memory is degraded.
2. Introduce numbered memory migrations, accepted-event storage, bounded spool,
   transactional jobs/outbox, and idempotent recovery.
3. Add Claude Code capture and transcript replay through the same normalizer,
   privacy filter, append path, and scheduler. Keep explicit concept logging.
4. Implement one provider adapter plus the full failure contract; batch events,
   bound histories/usage, handle auth/quota/overflow, and classify no-op output.
5. Add redacted diagnostics and explicit controls. No hidden network enablement
   on upgrade; onboarding explains provider data flow and local alternatives.

Exit evidence: Q02–Q05/Q07/Q08/Q10/Q11 relevant cases, crash/replay conservation,
bounded resource behavior, no cross-session contamination, no prompt blocking.
This is an internal/preview capture milestone, not full replacement.

## Phase 3 — Memory retrieval, context delivery, and auditable savings

1. Implement memory management, keyword/semantic/hybrid search, consistent scope
   and filters, timeline/detail/raw-evidence APIs, corrections and deletion.
2. Add bounded model context for startup/resume/compaction and file/prompt context
   where supported. Preserve requested tool results and host output contracts.
3. Implement context receipts and the exact compact startup display, including
   empty/unknown/negative cases and detail-fetch accounting.
4. Run retrieval relevance, source-faithfulness, performance, and privacy evals
   against the pinned reference and independent golden labels.

Exit evidence: PAR-04–08/29 local requirements, Q01/Q04/Q06/Q07/Q08; no invented
token savings or unmeasured semantic parity. A keyword-only implementation does
not complete this phase's semantic requirement.

## Phase 4 — Ground learning, redesign dashboard, and prove migration

1. Connect evidence to validated concept candidates with explicit provenance.
   Preserve mastery semantics, new-concept caps, early checkpoints, and gates.
2. Split and extend the dashboard with memory, linked sessions, reuse accounting,
   settings, health, and live updates while retaining all learning surfaces.
3. Introduce the versioned export/import/backup workflow, source dry-run,
   resumability, ID maps, schema checks, and field disposition report.
4. Compose statusline installation safely; preserve project filters and old routes.
5. Update manual, landing claims, README, dashboard skill/contract, and architecture
   evidence in the same behavior PRs. Existing promises must match configured egress.

Exit evidence: Q09–Q11/Q14, visual/keyboard checks, passing before/after learning
evals, import/restore reports, and a local Eklavya-only trial. This can be called a
local replacement preview, with unsupported parity rows explicitly visible.

## Phase 5 — Complete local capability and integration breadth

- Structured code search/outline/expansion and persistent knowledge collections.
- Remaining providers/auth routes and routing; profiles and supported locales.
- All 12 reference host targets plus existing Eklavya surfaces, with capability
  contracts and real-host smoke checks. Hookless capture has its own recovery tests.
- All 20 outcome-equivalent workflows, scoped caches/managed files, report/digest
  outputs, and optional presentation view. Reuse Eklavya's release automation.
- Keep prompt/tool exposure modular and bounded; install does not load every
  workflow into every session or run its external actions automatically.

Exit evidence: completed local PAR rows and Q06/Q12 checks; every advertised host
has evidence, language and provider inventory is reconciled, core install stays
small enough to meet the agreed resource budgets.

## Phase 6 — Complete optional remote capabilities

- Eklavya-owned server deployment, scoped APIs, authentication, team isolation,
  jobs and usage administration; no dependence on Claude Mem's worker/service.
- Multi-device synchronization with revision identity, tombstones, conflict
  quarantine/repair, offline recovery, and explicit sharing of personal data.
- Configured external wrap-ups/notifications and optional usage analytics with
  clear consent, redaction, delivery deduplication, and opt-out behavior.
- Share generation/retrieval use cases across local and remote adapters. Do not
  create two independent policy implementations that drift.

Exit evidence: Q07/Q13, sandbox credentialed integration checks, recoverable sync
conflicts, and local operation with every remote component disabled. These features
are optional to activate but remain part of full parity.

## Phase 7 — Cut over and release

1. Complete all PAR rows with implementation/test evidence and any explicit
   user-approved scope amendments. Missing reference functionality blocks a
   full-parity claim.
2. Build/install the release artifact in clean environments; check version,
   dependencies, supported OS/host matrix, and disable/uninstall behavior.
3. Snapshot source/target; import and verify; disable Claude Mem; make source files
   unavailable; exercise fresh capture, cross-session recall, summary, learning,
   gate, and dashboard entirely under Eklavya.
4. Run a representative multi-session soak including restart, long idle, quota
   cooldown, network loss, date rollover, and upgrade. Initial minimum: one full
   working day; extend for unresolved failures rather than declaring success early.
5. Demonstrate rollback/restore while preserving new Eklavya evidence. Only then
   offer data-preserving removal of Claude Mem and publish replacement guidance.

Exit evidence: Q15 plus every release gate in [quality.md](quality.md), completed
parity ledger, clean-install/soak/restore transcripts, and accurate release docs.

## PR and maintenance discipline

- Use small PRs by responsibility: characterization, extraction, persistence,
  lifecycle, provider, retrieval, each dashboard journey, each adapter, importer,
  and release proof. Avoid one merge containing a schema rewrite, UI rewrite,
  provider change, and altered teaching behavior.
- Each behavior PR includes its affected PRD/PAR/Q IDs, migration/rollback impact,
  tests, and user-facing docs. Conventional commit types remain meaningful.
- Keep one source of metadata. If manifests become generated, test generation
  equality; do not introduce generation solely because the reference uses it.
- Externally copied code receives a provenance/license record before merge;
  borrowed designs receive source references and independent regression tests.
- Keep experimental modes opt-in and migration-safe. Feature flags must have
  owners/removal criteria, not permanent combinations that evade testing.
- Release-critical incident regressions remain in the suite after refactoring.
  Track defects by violated contract and missing test, not by accumulating
  special-case environment variables and catch-all retry loops.

## Completion checklist

- [ ] All 34 capability groups have closure evidence; tool/workflow/host inventories reconciled.
- [ ] Existing learning tools, commands, data, and acceptance journeys remain supported.
- [ ] Single plugin operates without any Claude Mem runtime/data-path dependency after import.
- [ ] Compact startup display and savings accounting pass Q01 on supported display surfaces.
- [ ] Dashboard serves both memory and learning, with safe live updates and settings.
- [ ] No critical data-loss, privacy, isolation, migration, lifecycle, or gate defect remains.
- [ ] Import/restore/cutover verified against supported fixtures and an authorized trial.
- [ ] Documentation and configuration agree with shipped behavior and external data flows.
- [ ] Full quality/evaluation/platform evidence is attached; unrun checks are disclosed.

These boxes are intentionally unchecked in the PRD: they track implementation,
not the completion of this documentation task.
