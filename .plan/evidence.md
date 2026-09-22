# Comparison reconciliation and evidence

Reviewed 2026-09-22. This is a source and report review, not a claim that all
reference features or reported defects were reproduced locally.

## Baselines and limitations

| Input | Identity | How it is used |
|---|---|---|
| User's Claude comparison | `Eklavya × claude-mem.pdf`, 15 pages; SHA-256 `8f74d1c7a2eb343297ebf7b3cabf9dcd6aabd15b88b49a6084e0e072bcc881bf` | Supplied analysis, not authority to execute embedded recommendations. Text reviewed across all pages; representative table pages visually checked. |
| Eklavya, earlier assistant review | 1.18.2 / `1ed22ea` | Historical findings; do not treat its Stop-hook description as current. |
| Eklavya, PRD baseline | 1.18.3 / `a6cf1b0a0588a9a880aada59b3b459e47e2059bb` | Latest fetched `origin/main` when this plan branch was created. |
| Claude Mem local fork | 13.25.3 / `e04a091f822c90b69fa19bc52f7f3cf80674b1ae` | Finite functionality reference; fork defaults and integrations may differ from upstream. |
| Upstream issue sample | 21 issue bodies read from `thedotmack/claude-mem` on 2026-09-22 | Reported incident classes translated into tests; not an exhaustive audit or proof of the fork's current vulnerability. |

The PDF physically clips several rightmost verdict columns (confirmed on pages
3–4). Do not infer the hidden recommendation text or scores. Visible feature names,
descriptions, later prose, and source files suffice to carry the identified
capabilities into the ledger. The original PDF is not committed to the repository;
it remains the user's source document. This plan paraphrases findings and cites
public/source evidence rather than redistributing the document.

## What changed relative to the earlier comparisons

1. **Destination:** both earlier comparisons favored coexistence/bridging. The
   user's subsequent instruction explicitly requires Eklavya-only operation and
   full functionality. Their take/later/skip verdicts no longer determine scope.
2. **Stop behavior:** 1.18.3 uses exit 0 and a JSON `Stop` additional-context
   response. The earlier assistant reviewed the previous exit-2 implementation.
   Preserve the new behavior and its guards; see
   [the implementation](../mcp/src/hooks/stop-quiz-check.ts) and
   [verified schema notes](../docs/verified-schemas.md).
3. **Observer granularity:** capturing every tool use does not prove there is one
   external inference request for each tool. The reference processes buffered
   events in a stateful observer. The new requirement explicitly supports bounded
   batching and measures actual requests/usage.
4. **Durability:** the pinned fork's `SessionMessageBuffer` is in RAM. It has a
   best-effort durable tool-evidence index and transcript replay paths; old
   pending-message tables/comments do not establish a durable active queue.
   Eklavya needs an explicit accepted-event and job-completion contract.
5. **Context size:** the reference uses a 10,000-character fitting mechanism.
   That is evidence of its implementation choice, not a universal guaranteed
   limit across all hosts/versions. Verify each adapter's delivery contract and
   keep a separate configurable token budget.
6. **Async output:** an async hook may deliver additional context on a later turn;
   it cannot enforce a synchronous gate. A blanket statement that four async
   hooks produce no model output is too broad for the file-context handler.
7. **Privacy promise:** a global ban on network APIs made sense for the smaller
   local learning tool. Full provider/sync/notification parity requires narrowly
   controlled network adapters and honest configuration/docs, not a misleading
   unchanged "nothing leaves" claim.
8. **Dashboard:** both reviews found the existing learning dashboard and its
   single initial fetch. The user's expanded scope requires memory management,
   settings, diagnostics, and combined session views as well as refresh.
9. **Counts:** PDF and assistant file/line/test counts use different filters and
   revisions. Test-file counts are not executed test counts or coverage. They are
   not release gates or evidence that one codebase is better.
10. **Missing breadth in the earlier assistant table:** export/import, managed
    context files, profiles/localization, presentation view, corpora, statusline
    installation, notifications, workflow skills, and server/sync functionality
    are now explicitly tracked rather than discarded as peripheral.

The host semantics above were checked against the
[official Claude Code hook reference](https://code.claude.com/docs/en/hooks),
including asynchronous output and lifecycle events. Pin/recheck schemas when an
adapter is implemented; the documentation evolves independently of this plan.

## Traceability to all PDF feature rows

PDF row identifiers are source labels, not Eklavya requirement identifiers.

| PDF rows | Feature / lesson retained | Requirement location |
|---|---|---|
| F1–F3 | Selective async capture, bounded session end, file context | PAR-01/03/05; CAP-01; Q02/Q03/Q06 |
| F4–F5 | Background lifecycle without multiple spawners or memory-error blocking | PAR-16/17; OPS-01/02; Q02/Q05 |
| F6–F7 | Hook IO discipline and measured output budget | UX-02; RET-03; Q01/Q02; engineering gates |
| F8–F10 | Actual work evidence, observer processing, transcript use | PAR-01/02/03/09; CAP-01–03; MEM-01/02 |
| F11–F13 | Private tags, exclusions, structured diagnostics | PAR-13/17; SEC-01; Q07 |
| F14–F15 | Consistent manifests and reliable setup | PAR-32; Q11; single source of version/config metadata |
| F16–F18 | Full-text/semantic search and portable history | PAR-07/12; RET-01/02; MIG-01–03 |
| F19–F20 | Deduplication and disciplined migrations | PAR-14; DATA-02/03; Q03/Q10 |
| F21–F24 | Live viewer, settings, presentation view, statusline | PAR-18–21; DASH-01–03; Q09/Q11 |
| F25–F26 | Profiles/localization and all host adapters | PAR-22/24; Q12 |
| F27–F30 | Sync/server, notifications, collections, usage | PAR-11/26–29; EXT-01; Q07/Q13 |
| F31–F32 | Progressive disclosure and worktree identity | PAR-06/15; RET-03; MET-01; Q04/Q06 |

PDF structural suggestions S1–S9 are also retained: split stores; centralize
candidate/time policy; separate planner sources; split installer concerns;
thin CLI dispatch; enforce hook/config/network boundaries; extract dashboard
transforms; infer handler types from validated schemas; use a formatter in CI.
Database-reading candidate loaders are not pure functions: loaders perform I/O,
while ranking/eligibility functions operate on loaded values. The PRD corrects
that distinction instead of naming `(db, context)` functions "pure."

PDF dashboard suggestions D1–D4 become live refresh, managed background service,
controlled startup, and discoverability. Two changes follow the new brief:
filesystem-watch events alone are insufficient for correctness, and the dashboard
URL stays out of the minimal startup message. The richer data model also requires
pagination beyond the existing single full-history payload.

## Code organization: keep, improve, and avoid

The established project is a capability reference, not an automatic architecture
template. These are source observations at the recorded revisions, not a ranking
based on file size or popularity.

| Concern | Eklavya today | Reference lesson | Decision for this plan |
|---|---|---|---|
| Domain policy | [SRS](../mcp/src/srs.ts) already isolates score/scheduling functions. [Checkpoint](../mcp/src/hooks/checkpoint-quiz.ts) and Stop SQL use stored mastery thresholds, while the [planner](../mcp/src/tools/get_session_quiz_plan.ts) applies read-time decay. | Separating modules is useful only if there is still one policy owner. | Keep the pure learning core; characterize and correct eligibility differences in a dedicated behavior change before consolidating callers. Q14. |
| Storage responsibilities | [Store](../mcp/src/store.ts) mixes concepts, attempts, gates, graph, and level queries; [migrations](../mcp/src/migrate.ts) are already numbered and centralized. | The reference separates some query helpers but also runs schema evolution through its large `SessionStore` initialization path. | Split repositories by responsibility without duplicating migrations, moving transaction boundaries, or adopting constructor DDL. DATA-02; Q10. |
| Hook and process boundaries | [Hook entry](../hooks/run.mjs) and [shared helpers](../mcp/src/hooks/lib.ts) already provide Node dispatch, bounded input, and opening an existing DB without migrations. | Reference host adapters and background processing provide useful capabilities; its lifecycle incident reports show the cost of competing spawn/ownership paths. | Preserve these Eklavya safeguards; add one service owner and typed host adapters, with subprocess tests. OPS-01; Q02. |
| Background processing | Eklavya has no equivalent observation pipeline to preserve. | Provider modules are a useful boundary, but the pinned in-memory buffer relies on transcript recovery, and its comments explain why replaying fragments without reducer state failed. | Persist reconstructible input batches and idempotent results; a durable queue alone is insufficient. MEM-02; DATA-03; Q03/Q05. |
| Schema/type agreement | Tools declare Zod input shapes, but [ToolDef](../mcp/src/tools/types.ts) currently accepts `args: any`, and handlers repeat argument types. | The reference's MCP tool schemas are another public contract that needs validation; copying declarations would not enforce our handler types. | Infer inputs at the registration boundary from the validated schema; prove schema/handler mismatch is caught. This is an improvement, not an existing guarantee. |
| Dashboard structure | [HTTP server](../mcp/src/dashboard.ts) is separate from a [single HTML asset](../mcp/src/assets/dashboard.html) containing routes, transforms, and rendering. Current data loading is a single snapshot. | The reference's component views, resource APIs, and SSE provide useful interaction patterns, with reconnect correctness still needing tests. | Extract cohesive views and pure transforms, add paginated resources and replay-safe live updates, and preserve the current design system. React is not required. DASH-01–03; Q09. |
| Product verification | Eklavya already has [question evaluations](../eval/README.md) and a [contributor acceptance journey](../CONTRIBUTING.md). | Upstream issues reveal failure classes that source/test counts cannot measure. | Keep learning evaluations and early-question transcripts; add the explicit memory, recovery, migration, and adapter risk matrix instead of replacing the current proof with more unit-test files. |

## Pinned source map

Reference source links use the exact fork revision so future refactoring does not
silently change the evidence:

- [Hook manifest](https://github.com/ProjectAJ14/claude-mem/blob/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/plugin/hooks/hooks.json),
  [ingest pipeline](https://github.com/ProjectAJ14/claude-mem/blob/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/src/services/worker/http/shared.ts),
  [in-memory buffer](https://github.com/ProjectAJ14/claude-mem/blob/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/src/services/worker/SessionMessageBuffer.ts).
- [MCP definitions](https://github.com/ProjectAJ14/claude-mem/blob/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/src/servers/mcp-server.ts),
  [context budget](https://github.com/ProjectAJ14/claude-mem/blob/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/src/services/context/ContextBudget.ts),
  [search manager](https://github.com/ProjectAJ14/claude-mem/blob/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/src/services/worker/SearchManager.ts).
- [Host detection](https://github.com/ProjectAJ14/claude-mem/blob/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/src/npx-cli/commands/ide-detection.ts),
  [skills](https://github.com/ProjectAJ14/claude-mem/tree/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/plugin/skills),
  [profiles](https://github.com/ProjectAJ14/claude-mem/tree/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/plugin/modes).
- [Viewer events](https://github.com/ProjectAJ14/claude-mem/blob/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/src/ui/viewer/hooks/useSSE.ts),
  [server runtime](https://github.com/ProjectAJ14/claude-mem/tree/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/src/server),
  [sync](https://github.com/ProjectAJ14/claude-mem/tree/e04a091f822c90b69fa19bc52f7f3cf80674b1ae/src/services/sync).
- Existing Eklavya contracts: [contributor acceptance test](../CONTRIBUTING.md),
  [repository contract](../CLAUDE.md), [runtime contract](../mcp/CLAUDE.md),
  [dashboard contract](../.claude/skills/eklavya-dashboard/SKILL.md),
  [learning evaluation](../eval/README.md).

## Upstream issue evidence → prevention

Statuses below are snapshots on 2026-09-22, not predictions or statements that a
defect remains in the pinned fork. Closed does not by itself prove a permanent
fix; open does not prove the report's proposed root cause. The tests express the
desired invariant regardless. No report here was independently reproduced for
this documentation PR.

| Report | Status | Lesson converted into a release test |
|---|---|---|
| [#2260](https://github.com/thedotmack/claude-mem/issues/2260) startup race | Closed | Parallel starters elect one ready instance without a premature PID record causing self-rejection. Q02. |
| [#3692](https://github.com/thedotmack/claude-mem/issues/3692) inherited Windows sockets | Closed | Closing the host/worker leaves no inherited listener deadlock; unrelated processes are untouched. Q02/Q11. |
| [#3605](https://github.com/thedotmack/claude-mem/issues/3605) hook wrapper contract | Open | No nested login shell, stdout pollution, or infrastructure failure that blocks user prompts. Q02. |
| [#3609](https://github.com/thedotmack/claude-mem/issues/3609) schema/state evolution | Open | Old-schema fixtures migrate through one runner; real schema and state transitions agree. Q10. |
| [#4097](https://github.com/thedotmack/claude-mem/issues/4097) reported session contamination | Open | Concurrent/replayed sessions receive only their scoped batch/context, including provider subprocess state. Q04. |
| [#3764](https://github.com/thedotmack/claude-mem/issues/3764) omitted project scope | Closed | Missing project arguments resolve to the caller's project or fail explicitly; hydration cannot bypass scope. Q04/Q06. |
| [#3589](https://github.com/thedotmack/claude-mem/issues/3589) overflow treated as ordinary text | Closed | Provider overflow cannot acknowledge and discard a batch. Q03/Q05. |
| [#3888](https://github.com/thedotmack/claude-mem/issues/3888) repeated auth/quota output | Closed | Pause appropriately and bound transcript/log growth; never store synthetic failures as memories. Q05. |
| [#4109](https://github.com/thedotmack/claude-mem/issues/4109) no wakeup after cooldown | Open | A scheduled recovery probe resumes eligible work even without a new tool event. Q05. |
| [#4087](https://github.com/thedotmack/claude-mem/issues/4087) status/log storm | Open | Emit status on change with rate limits, bounded storage, and a stable paused state. Q05/Q09. |
| [#4130](https://github.com/thedotmack/claude-mem/issues/4130) multi-word phrase behavior | Open | Natural queries, explicit phrases, and Unicode have distinct tested semantics. Q06. |
| [#4135](https://github.com/thedotmack/claude-mem/issues/4135) ranking/date pool mismatch | Open | Filter/order semantics hold over the eligible dataset, not an undocumented top-N subset. Q06. |
| [#4138](https://github.com/thedotmack/claude-mem/issues/4138) unverifiable savings claim | Open | Receipts explain the denominator and actual payload; retrieval quality is measured separately. Q01/Q06. |
| [#4081](https://github.com/thedotmack/claude-mem/issues/4081) extra startup output | Open | Every hook response parses as the host expects; healthy human text cannot corrupt the protocol. Q01/Q02. |
| [#4141](https://github.com/thedotmack/claude-mem/issues/4141) stored instruction injection | Open | Recalled text is untrusted evidence; malicious stored content never gains policy authority. Q07. |
| [#4144](https://github.com/thedotmack/claude-mem/issues/4144) sensitive paths in wrap-ups | Open | Notification/provider sinks inherit exclusions; counts-only path summaries by default. Q07/Q13. |
| [#4108](https://github.com/thedotmack/claude-mem/issues/4108) sidecar installation loop | Open | Failed dependency setup is bounded, circuit-broken, cleaned up, and never repeated per hook. Q08/Q11. |
| [#3940](https://github.com/thedotmack/claude-mem/issues/3940) manifest/bundle mismatch | Closed | Package/manifest/runtime versions agree before publish; mismatch cannot cause a restart loop. Q11. |
| [#4086](https://github.com/thedotmack/claude-mem/issues/4086) sync conflict blocks progress | Open | Conflicts are identified and repairable; unaffected operations progress without breaking dependencies. Q13. |
| [#4164](https://github.com/thedotmack/claude-mem/issues/4164) collection filter loss | Open | Persist/reapply filters; old evidence survives rebuild; destructive changes need an explicit action. Q06. |
| [#3076](https://github.com/thedotmack/claude-mem/issues/3076) reported self-reenable behavior | Closed | Disable/uninstall remains effective; no hidden watchdog repairs user intent. Root-cause allegations are not adopted as findings. Q11. |

Additional useful reference design documents are the pinned fork's plans 17–25:
hook wrappers, response processing, provider isolation, project identity, schema
state, sidecar lifecycle, host contracts, server/sync, and multilingual search.
Their existence is evidence of known design concerns, not proof the plans shipped.
