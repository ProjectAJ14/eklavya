# Engineering quality and validation contract

This is a planned test specification. No new runtime tests or code ship with the
PRD PR. Existing tests remain authoritative for current behavior; new behavior
requires new evidence. "All corner cases" is implemented as an explicit expanding
risk matrix, not an unverifiable promise that every possible failure is covered.

## Engineering rules enforced in implementation CI

1. Strict TypeScript, schema-inferred transport inputs, typed DTOs/results, and
   exhaustive error/state handling. Boundary data is `unknown` until validated;
   `any` needs a documented external-API exception. SQL row assertions do not
   substitute for schema/migration checks.
2. One formatter and focused lint rules. Enforce dependency direction and cycles
   through module-aware checks. Domain code cannot import IO/frameworks; transports
   cannot define scoring, ranking, identity, or migration policy.
3. One hook response writer, one child-spawn boundary, one lifecycle owner, one
   config schema, one project resolver, one timestamp policy, and one migration
   path. Tests deliberately introduce a violation and prove each guard detects it.
4. Prefer cohesive functions/modules. New production modules over roughly 400
   nonblank lines or functions over roughly 80 lines trigger a design review, not
   mechanical splitting or an automatic exemption for a service class. Generated
   schemas/assets have separate rules. Preserve transaction ownership while splitting.
5. Dependency injection for clock, IDs, provider, repository, and host capability
   boundaries. Keep pure eligibility/ranking/formatting separate from query loaders.
   No global mutable current-session/provider state shared between independent jobs.
6. Structured bounded errors and logs. Fail-open capture protects the user's
   session; swallowed exceptions without a diagnostic category are unacceptable.
   Distinguish transport, dependency, privacy, quota, corrupt state, and deliberate
   skip outcomes. Never put logging on MCP/hook protocol stdout.
7. Validate settings once; derive CLI/MCP/dashboard metadata from the same schema.
   Credentials are references, not ordinary values. Network access is possible
   only through configured adapters with privacy and cancellation contracts.
8. Deterministic builds, lockfiles, dependency closure smoke tests, manifest/runtime
   version equality, license/notice review for reused code, and a dependency budget.
   Renaming copied code does not remove attribution obligations; record provenance.
9. Documentation changes accompany behavior: manual, README/landing claims,
   configuration reference, host support matrix, and generated architecture evidence.
   Preserve the existing contributor acceptance transcript and learning eval process.
10. Every regression report becomes the smallest meaningful reproducer at its
    responsible boundary. Avoid tests that merely duplicate implementation logic.
    Happy-path snapshots alone cannot establish recovery or domain correctness.

## Scenario families

Each Q family maps to the PRD/PAR rows and to concrete test cases in implementation
PRs. IDs remain stable when files move. For every scenario record fixture,
operation, observable result, and cleanup assertion. "No crash" is not sufficient.

| ID | Scope | Required cases and assertions |
|---|---|---|
| Q01 | Startup and measurements | Healthy, first use, no reusable data, zero denominator, missing source count, unavailable delivery receipt, negative saving, Unicode/tokenizer mismatch, duplicate resume, and detail fetch after index. Banner is within five nonblank lines; numbers trace to receipts; quiet does not disable machine context. Privacy/config/status URLs never spill into healthy startup. |
| Q02 | Hooks and service lifecycle | Real subprocess stdin with empty/malformed/oversized/BOM input, no EOF, slow chunks, stream error, unsupported host fields, correct JSON envelope, log/stdout separation, concurrent cold starts, stale PID, PID reuse, unrelated occupied port, wrong version, stale descriptor, read-only home, missing Node/native dependency, parent exit, Windows inherited handles, graceful/forced shutdown. Prompt/tool actions continue on memory failures; synchronous gates retain their semantics. |
| Q03 | Capture, jobs, replay | Duplicate delivery, out-of-order lifecycle events, identical legitimate tool calls, absent tool IDs, rotated/truncated transcript, partial JSONL, crash before append/after append/after model result/before commit/after commit before ack, restart with lost observer context, expired lease, duplicate provider result, spool full, disk full, SQLite busy, corrupt event, session-end before generation finishes. Accepted events remain accounted for; committed results do not duplicate. |
| Q04 | Identity and isolation | Same basename in two repositories, same branch in two worktrees, symlinks, path casing/Unicode/UNC paths, renamed/moved checkout, Git-less directories, repo config overrides, concurrent users/hosts/agents, parent/tutor subagents, replay of historical sessions during active work, project omitted, lookup by foreign ID. No cross-project/tenant leakage; intended global learner mastery remains intact. |
| Q05 | Provider and scheduling | Valid/empty/malformed/truncated/oversized output, unexpected schema fields, legacy casing variations if supported, synthetic auth/quota text, expired quota snapshot, 429/5xx/disconnect, hung request, cancellation, context overflow, revoked/expired credentials, model unavailable, provider change mid-job. No failure acknowledged as successful memory; bounded retry/backoff; cooldown wakeup without new input; auth requires explicit repair; no CPU/log/billing storm. |
| Q06 | Search, code, collections | Multi-word AND-style query versus explicit phrase, CJK/mixed scripts, punctuation, long/empty queries, hostile query syntax, date endpoints/time zones, chronological versus relevance ordering, records beyond initial top-N pool, stable pagination, batch hydration scope, deleted/stale index rows, no vector backend, index rebuilding, concurrent writes, requested file not truncated, unknown parser language, renamed symbol, corpus filter preservation, old-date rebuild and interrupted rebuild. Return accurate citations and honest partial/fallback status. |
| Q07 | Privacy and trust | Private/nested/malformed tags, excluded projects/tools/files, credential-adjacent paths, secrets in source/error/provider output, prompt injection in a stored title/fact, HTML/control characters, malicious import, path traversal/symlink escape, origin/CSRF/DNS-rebinding attempts, unauthorized local/remote mutations, secret export, deletion during indexing, retention and sync tombstones. Assert forbidden content is absent from DB/spool/log/provider/index/export/notification payloads. |
| Q08 | Index/runtime resources | Missing embedding dependency, unsupported platform/native ABI, failed download/install, corrupt index, interrupted backfill, cancellation, OOM/resource ceiling, failed sidecar startup, stale lock/same-process reacquisition, repeated launches, upgrade and uninstall. Keyword read path survives semantic degradation; no dependency-install loop or orphan child tree; rebuild starts from primary records. |
| Q09 | Dashboard | Every existing and new route; filters/bookmarks; 1280/900/560 and 320px; both themes; keyboard/Enter/focus; screen-reader labels; zero console errors; XSS fixture; paginated large history; one event/duplicate event/missed events/disconnect/reconnect; settings validation and version conflict; preserve scroll/project/filter on update; exact backend-derived totals; pending versus failed versus ready. |
| Q10 | Schema and data mutation | Fresh DB, every supported legacy fixture, missing/extra indexes, applied version inconsistent with schema, concurrent migration attempts, interruption per migration, foreign keys, null historical fields, backup/restore with live WAL, deletion cascade and tombstone, corrupt database, incompatible newer schema. No hidden constructor DDL; no loss of attempts, options, feedback, mastery, or provenance. |
| Q11 | Import, install, update, uninstall | Source DB snapshot with active WAL, source/export format versions, resume at each import checkpoint, second import, conflicting source IDs/projects, invalid dates/encoding, source changed mid-import, unknown fields, profiles/settings compatibility, secret omission, partial bundle, stale cache, old/new binaries racing, npm/marketplace/local install, spaces/special characters in paths, compose/restore user config and statusline, disabled stays disabled, data-preserving uninstall. |
| Q12 | Adapter/profile/workflow contracts | All 12 host targets and existing Eklavya surfaces; host capability differences, stdout schema, tool visibility, stdin/environment routing, supported provider families, custom endpoint/auth profiles, profile inheritance cycles/invalid overrides, supported locales, tier routing, every shipped workflow outcome, action authorization, and no duplicate skill registration. Fixtures plus real-host smoke evidence; unavailable hosts block that adapter's parity claim. |
| Q13 | Optional remote features | Two tenants/projects/devices, API key scopes/revocation, unauthenticated requests, TLS/transport failures, offline writes, reordered/duplicate sync, deleted records, revision conflict, one corrupt operation, dependency-preserving quarantine/repair/rebase, lost notification acknowledgment, rate limits, redacted destination payload, usage/cost unknowns, no analytics before opt-in or after opt-out. Local operation works with all optional services absent. |
| Q14 | Learning regression | Existing suite and real transport journey; explicit logging plus extracted candidates; decay equality across hooks/planner/banner/dashboard; old timestamp formats; all learning dials; quiet/off/enforced; early checkpoint and Stop sweep; tutor/subagent guards; skip versus don't-know; MCQ cap; wrong/repeated answers; review versus work gate credit; caps/cooldowns; prerequisite fairness; new-concept budget; auto/pinned level; worktree/session concurrency; late candidate must not reopen a completed gate. |
| Q15 | Replacement and rollback | New install without any Claude Mem files; imported history with source renamed/unavailable; fresh capture→summary→recall across two sessions→question→answer→live dashboard; process restart; offline/provider outage; disable/uninstall Claude Mem; restore old Eklavya snapshot with export of new events. No network/IPC/path dependency on Claude Mem remains after import. |

## Testing layers and release evidence

### Unit, property, and contract tests

- Pure scheduling, score decay, shared candidate rules, timestamp parsing,
  privacy filtering, identity, stable IDs, context arithmetic, ranking, and job
  transitions have deterministic tests with injected time.
- Property/model-based tests cover replay idempotency, state reachability,
  tenant/project separation, gate monotonicity, conservation of accepted events,
  and exact accounting of a migration/import. Validated terminal no-ops count as
  accounted events; dropped/corrupt events never masquerade as completed work.
- Every supported transition/error branch in these critical policies is covered.
  Use branch coverage and targeted mutation tests to find missing assertions;
  exclude unreachable branches only with reviewed justification. Do not use a
  global line-coverage percentage as a substitute for scenario evidence.
- Contract suites exercise every host/provider/storage/transport implementation
  against the same behavior. Include negative fixtures and response-shape checks.

### Integration and end-to-end tests

- Real SQLite/WAL, real stdio JSON-RPC, real child processes, local HTTP/SSE, and
  real Git pre-commit gate; temporary homes/repos/configs only. Tests must not
  touch a developer's actual databases, plugin registry, credentials, or messages.
- Crash injection at persistence/claim/result/commit/ack boundaries; assert final
  rows and recovery, not just exit status. Repeated crash/restart and full queues
  must terminate in a known inspectable state.
- Run supported Node versions on Linux, macOS, and Windows. Pin a minimum/current
  Node matrix before implementation; do not weaken the package engine contract.
  Windows uses real spawning and handle-lifetime tests, not a mocked platform flag.
- Browser tests cover user flows and pure dashboard transforms. Verify historical
  totals independently of pagination/truncation and client render state.
- Network providers/notification destinations use recordable fixtures in routine
  CI. Credentialed live checks are gated release jobs against sandbox accounts;
  disclose missing live evidence rather than reporting unrun adapters as passed.
- Supported published artifacts are installed in a clean environment with no
  repository devDependencies or preexisting Bun/Python/Chroma assumed available.

### Product evaluations

- Build a licensed/synthetic, versioned golden corpus with at least 100 queries
  across decisions, fixes, files, dates, CJK/mixed-language search, worktrees,
  adversarial stale facts, and explicitly cross-project queries. Human-label
  relevance and expected sources; hold back a regression set.
- Proposed initial goals: recall@20 at least 0.90 and precision@5 at least 0.80
  on answerable queries. Publish per-slice scores and failure examples; aggregate
  success may not hide a broken locale or permission scope. These are targets,
  not measured results. Baseline them in Phase 0 and explicitly approve any
  justified adjustment before implementation, rather than lowering them after failure.
- Compare with the pinned reference using identical sanitized input and query
  fixtures. Preserve intended behavior, not an upstream bug. Cite failure reports
  separately from observed results. Model summaries need factual equivalence and
  source faithfulness, not byte equality.
- Measure extraction precision/recall for concept candidates, citation validity,
  observer cost per accepted event, retries, latency, and number of missed events.
  False mastery promotion and cross-project leakage have zero tolerance.
- Keep Eklavya's existing question-generation/shape/judge/history evaluations.
  Use the same fixtures and model settings before/after a change, report
  uncertainty, and inspect regressions. A model judge alone cannot certify
  learning; correct answered assessments remain the mastery input.

## Initial performance and resource budgets

These are proposed acceptance targets, not measurements or promises about existing
software. Phase 0 records reference hardware/OS, warm/cold definitions, corpus
sizes, event payload distribution, and benchmark commands. The initial reference
fixture is 100,000 memory entries, 1,000,000 evidence events, and 10 simultaneous
coding sessions on an 8-core/16-GB/SSD machine; also test small fresh installs.

| Operation | Initial acceptance budget |
|---|---|
| Steady-state hook capture including its local process | p95 ≤250 ms; bounded fallback returns within 1 s if service is unavailable. Host scheduling time reported separately. |
| SessionStart context/banner from committed data | p95 ≤1 s, 2 s hard local wait budget; no awaited external inference. |
| Search | p95 ≤300 ms keyword and ≤1 s warm local semantic search at reference size; external embedding/provider latency reported separately. |
| Live dashboard | Committed change visible within 2 s at p95; reconnect/gap resync converges to the current committed revision. |
| Ordinary observation freshness | Eligible batch scheduled within 5 s of flush condition; provider execution separated from scheduling latency. |
| Idle footprint | No periodic inference while idle; control-service idle CPU <1% on reference hardware; report RSS per service/index/provider child and set ceilings before backend selection. |
| Failure containment | Auth failure stops automatic inference; transient errors use bounded exponential backoff with jitter; one recovery probe per cooldown; logs/spool/jobs have explicit byte/count limits and overflow policy. |

Record p50/p95/max and failures, not only averages. Use controlled performance
jobs rather than flaky microsecond assertions in every unit-test run. Resource
ceilings are configurable only where users can make a meaningful tradeoff.

## Go / no-go

No full-replacement release if any of the following remains:

- Accepted work silently lost; unexplained import mismatch; corrupt migration;
  leaked project/tenant/private content; secrets in logs/exports; unrelated process killed.
- A memory error blocks a normal user prompt or changes commit-gate policy.
- Incorrect savings or mastery claims; unknown data reported as zero; startup
  display exceeds the agreed contract; silent disabled-feature reactivation.
- Known regression in existing teaching, grading, review, level, gate, or dashboard
  journeys; missing real-host evidence for an advertised host capability.
- Any required PAR row still omitted, even if a local subset works. Explicit user
  scope changes are recorded, never inferred from schedule pressure.

Each implementation PR records which Q scenarios ran, environment/fixture
versions, command/result, and unrun checks. The final release attaches the filled
parity ledger, clean-install and Eklavya-only transcripts, migration/restore report,
retrieval/learning evaluations, performance/resource report, and dashboard evidence.
