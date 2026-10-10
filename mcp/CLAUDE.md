# Working in `mcp/`

This directory owns the runtime: MCP server, learning and memory stores,
scheduling, hooks, installer, CLI and dashboard. Read the root `CLAUDE.md` first.

## Find the responsible module

| Area | Sources and boundary |
|---|---|
| Configuration | `config.ts`: defaults, validation, legacy aliases and scope merge; no database access. `config-path.ts`: dotted CLI keys and nullable types. |
| Paths and identity | `paths.ts`: all paths, env overrides, project config, worktree folding, private permissions and dashboard port. Never construct `~/.eklavya` paths elsewhere. `session.ts`: host session identity and checkout-specific session pointers. |
| Learning | `srs.ts`: pure scheduling, tiers, scores and promotion; explicit `now`, no database or clock. `store.ts`: queries and gates. `slug.ts`: deduplication. |
| Database | `db.ts` opens WAL, foreign keys and busy timeout, then migrates and seeds. `migrations/` is forward-only. `seed.ts` never overwrites mastery. |
| Packs | `packs.ts`: validated overlays after seeds, fail-open per file, never delete concepts referenced by attempts. |
| Tools | `server.ts` wires stdio; stdout is the MCP protocol, diagnostics use stderr. `tools/index.ts` registers all tools, applies busy retries and returns JSON error envelopes. Inputs use bounds in `tools/types.ts`. |
| Hooks | `hooks/*.ts`; registration and launcher in the top-level `hooks/`. Read `hooks/CLAUDE.md` for output, pacing, delegation and fail-open rules. |
| CLI | `cli.ts` builds to `dist/cli.js`; `cli-memory.ts` loads only for memory commands, keeping statusline startup light. The top-level `cli/` is the POSIX git gate. |
| Installation | `install.ts`, `safe-write.ts`, `install-lock.ts`, `onboard.ts`, `claude-mem.ts`, `update.ts`. Preserve user files, lock ownership and recovery paths. |
| Terminal | `theme.ts` owns CLI styling (keep its talea counterpart aligned); `statusline.ts` owns dials in the host status bar. `stdin.ts` owns bounded input. |
| Questions | `mcq.ts`: answer positioning. `ask.ts`: historical header stripping. `surface.ts`: host-specific attribution. |
| Quiz side panel | `panel.ts`: `present_question`, `panel_sync`, `panel_answer` over the `panel_questions` table (migration 025). `panel-state.ts`: heartbeat, `panelPresentation` and `hasOpenPanelQuestion`, light enough for hooks to import. `tools/panel_tools.ts`: the three tool definitions. `recordAttemptCore` in `tools/record_attempt.ts` is the one grading body `record_attempt` and `panel_answer` share; never copy it. |
| Prompt feedback | `feedback.ts` is the one gate: `insertFeedback` refuses while a row is pending (one `INSERT … WHERE NOT EXISTS`, with a unique index behind it), `acknowledgeFeedback` is the only thing that sets `acknowledged_at` and is reached only from `POST /api/feedback/acknowledge`, and `feedbackEnabled` is the one place `feedback.enabled` and `memory.enabled` combine. `feedback-review.ts` owns the review wording (the gap areas and `REVIEW_SYSTEM`, scored by `eval/gepa/feedback/`), the output schema and `parseReview`; the call goes through `runClaude` with a `CallSpec`, so it shares the summariser's safety flags. `prompt-text.ts` holds the prompt filters the nudge hook and the review share. There is no MCP tool for any of it, and `feedback_items` has no foreign key to the grading tables: keep both true, because they are why feedback cannot change mastery. The review runs only from `eklavya feedback generate`, started detached by `startBackgroundFeedback`; a hook never waits on it. `relocate.ts` re-files `feedback_items`. |
| Dashboard and artifacts | `dashboard.ts`, `assets/dashboard.html`, `artifacts.ts`, `assets/artifact-template.html`; read `.claude/skills/eklavya-dashboard/SKILL.md` before dashboard work. `dist/assets/vendor/` (the tips library) is copied from `node_modules/driver.js` at build, and the build fails without it. `dashboard-daemon.ts` keeps one background `dashboard --serve` per machine: the port is the lock, `/api/health` names the process, and only an older version on the same database is replaced. Tests use `EKLAVYA_DASHBOARD_PORT`. The Feedback workflow's reads are `/api/feedback` and `/api/feedback/list`; its writes (`acknowledge`, `delete`, `opened`) are `WRITES` rows, and the state payload's `feedback` carries ids and counts, never prompt text. |
| Memory | `memory/`: capture, privacy, spool, queries, search/embeddings, summarization, worker/reservation, recall, replay, learning candidates, collections, code lookup, notifications, sync and import. No MCP or host API dependencies. |
| Evaluation | `eval/*.ts` is deterministic and I/O-free; root `eval/harness.mjs` orchestrates model calls. |

## Configuration and trust

Read defaults from `DEFAULT_CONFIG`: quiz enabled, unenforced; focus `concept`;
cadence `as-you-go`; difficulty `auto`. Tool descriptions and skills must use
the same values. Normalize legacy `mode` and cadence `interleaved` per file before merging, permanently:
otherwise a global `quiz` can incorrectly override a project's old `mode`.
`quiz.enabled: false` forces enforcement off; `doctor` reports the conflict.

Project settings and packs are written outside checkouts under
`~/.eklavya/projects/<slug>/`. Worktrees share their main checkout's project.
`providers` is global-only because the worker is machine-wide. Detect project
slug collisions using the recorded project identity.

Legacy `<repo>/.eklavya.json` is untrusted: apply `CLONED_FORBIDDEN` /
`withoutUntrustedKeys` on both fallback read and migration. Trusted project
config does not need that legacy filter. `loadConfig` stays read-only;
`migrateLegacyRepoConfig` runs from SessionStart (before the database guard),
`doctor` and `config`. Do not reintroduce writes behind routine config reads.
Legacy in-repo packs remain read-only sources and are not deleted.

For a new config key, update its type/comment, default, coercion, CLI help and
`set_config` schema, plus the corresponding documentation. **The CLI and the
dashboard are both interfaces to config**: give a leaf key its row in
`SETTING_RULES` (`config-path.ts`: type, range, lengths — the one table the CLI,
the dashboard and `set_config`'s number schemas check against; a test fails
without it), place it in `SETTINGS` (label and help only) or `CLI_ONLY` in
`dashboard.ts`, and write through `applySetting`, the one write path
`eklavya config set|unset` and `POST /api/settings` share. The page's
`fieldProblem` mirrors `settingProblem` word for word; change both. An uncoerced field
silently disappears. `config-path.ts` derives keys from defaults; nullable keys
also need `NULLABLE`. Keep the tool's patch construction derived from defaults.

## Learning invariants

Memory and quizzes are independent. Memory runs before hook quiz checks and
cannot write attempts, mastery or gates. `learning_sources` proposes candidates;
only an answered assessment changes mastery.

Read `countAnswered`, `syncGate` and `gateRetryConcepts` before modifying gates:

- `answered` counts attempted concepts including review; passes count only
  work-origin concepts. Review debt cannot clear a gate about current work.
- `required` never decreases. Logging caps its hint at
  `min(unmastered, max_questions_per_task)`; `needed` is
  `ceil(required * pass_threshold)`. Return `passed_count` separately.
- A clean `declined` outcome is excluded from retries. `dont_know` is eligible. `invalid` is the tutor's own mistake and never reaches `attempts`: `recordAttemptCore` returns before any scoring, and `invalid_questions` (migration 027) is read only by `hasAskedQuestion`. Keep every scoring, level, gate and schedule query off that table.
  Decline plus feedback is contradictory: the tool returns `outcome_conflict`,
  and legacy contradictory rows remain retryable. Never guess an outcome.
- A pass needs `outcome` answered (or NULL). `declined`/`dont_know` with grade
  >= 3 is rejected as `outcome_grade_conflict` before any write; gate passes,
  retry eligibility and level counts ignore legacy rows of that shape.

The planner owns the as-you-go cap: one question only when unenforced and no
explicit domain/slugs. An explicit `max` wins; a resolved `learn` focus topic
does not count as an explicit request. Keep hooks, skills and docs aligned.

Level counts start at `promoted_at`; previous-band answers are spent. Counts
are derived from attempts so changing a promotion threshold takes effect without
rewriting rows. Say “at this band” when documenting answer requirements.

Slug matching uses qualifier-stripped equality, plural-insensitive equality,
then token Jaccard at the configured threshold. Do not broaden plural matching
into fuzzy matching: `https`/`http` and `refresh-token`/`refresh-token-rotation`
must remain distinct. This prevents new duplicates; it does not merge old rows.

Profile lists and graph responses are capped. Read their constants instead of
assuming completeness or ordering: `known` is strongest-first, accompanied by
`known_total` and `truncated`; it is not a recent-history list.

The panel's invariants: a question is a row, and answering it writes the attempt
and the row's `answered` phase in one `.immediate()` transaction, so a retry or a
lost reply cannot record twice. `panel_sync` never returns the key, the grades or
the explanation. Placement of the right option is checked server-side against
`answerPosition(slug, recentQuestions(..., ASKED_HISTORY).length)`; keep that count
the planner's. With `quiz.panel` off the three tools refuse and nothing is read,
and `presentation` is `"tool"`. Typed answers are two calls: the text alone (the
question becomes `grading`, the right label is returned for the mod's grader),
then the text with the grader's verdict. A pending row never changes mastery.

## Persistence, updates and safe writes

All tool handlers register through `registerTools` to retain retries on
`SQLITE_BUSY` and the error envelope. Transactions roll back before retry.
Tests must use temporary `EKLAVYA_HOME` / `EKLAVYA_DB` or explicit config,
including in-process tests. `EKLAVYA_SESSION_ID` intentionally joins sessions.
Tools resolve the host's session first (`hostSession` in `session.ts`:
the hooks' record for this `claude` process, then `CLAUDE_CODE_SESSION_ID`);
tests blank both variables in `vitest.config.ts`. The fallback session pointers
use checkout roots, keeping concurrent worktrees distinct; project settings fold
worktrees, session pointers do not.

Migrations update `LATEST_SCHEMA_VERSION`, expected files and relevant table
lists in `test/migrate.test.ts`. Read the current version there instead of
duplicating it in guidance. Seed changes require `SEED_VERSION` and a recount of
any published concept totals. Packs reapply after seeds; include seed version
in a fingerprint per directory scope, including an empty scope. `doctor` forces
application so same-size, same-mtime edits are recoverable. Concept rows are
global to a learner, so a project pack's shared-slug override is global too.

User-owned JSON must be parseable before installation writes begin. Use
`safe-write.ts`: retain one pre-command `.eklavya-bak`, preserve permissions,
write atomically and through symlinks. Never turn unreadable JSON into `{}`.
Onboarding writes global settings only; a repeat install does not silently
answer the Claude Mem question. Claude Mem retirement moves data for rollback.

The runtime lock uses exclusive creation, PID plus ownership token, verified
stale-claim replacement and token-checked release. Its launcher copy in
`hooks/run.mjs` must match. Updates never downgrade, never overwrite an
`EKLAVYA_RUNTIME` build and never need sudo. Keep SessionStart imports light.

## Memory and local pages

Redact before persistence. Keep hot capture separate from worker/provider
imports. Observer work uses one machine-wide reservation identified by PID and
process start time; a lease clock alone cannot prevent duplicate workers.
Honor `EKLAVYA_INTERNAL_OBSERVER` before hook input or side effects.

Memory tool use is “search, choose, then get”: index tools return small results,
`memory_get` hydrates selected entries. Describe `local-hash-v1` accurately:
morphology and character overlap are not general semantic understanding.

The dashboard is loopback-only and read-only (GET/HEAD, security headers), except
the routes in `WRITES` (`dashboard.ts`). Every write goes through `acceptWrite`:
a loopback Origin, JSON, the per-start page token and the route's size cap. A new
write is a `WRITES` row plus a handler; the page posts through its one `postJson`.
Artifact resolution must reject traversal and stay inside the real artifact
root. Artifact creation never overwrites or publishes; metadata lives in HTML
heads, not a database table. The template inlines shared design tokens and
carries no frame code: `embedHtml` adds `EMBED_SCRIPT` to every `?embed`
response, so pages on disk of any age report their height to the viewer.

## Documentation and verification

Tool descriptions are behavior: update them with the handlers and verify every
field used by skills against the schema and returned shape. Check the complete
`TOOLS` array when documenting the inventory, not imports alone.

Use the root change-to-document map and `web/CLAUDE.md` page map in the same PR.
Configuration changes affect `configuration`/`dials`; CLI changes affect `cli`;
memory changes affect `memory`/`your-data`; installer changes affect
`installing`/`installation-options`/`updates`; gate and grading changes affect
their dedicated pages and diagrams. Check package README and landing claims.

```bash
npm test             # pretest builds before tests execute dist files
npm run coverage     # CI's check: the suite under c8, 100% on every metric
npm run build        # TypeScript and bundled assets
npm run dev          # MCP server from source
```

Bare watch-mode Vitest does not rebuild the files spawned by integration tests.
For behavior changes, also run the live acceptance check in `CONTRIBUTING.md`.
Pedagogy changes require eval evidence; docs changes require the website build.
Report missing evidence explicitly.
