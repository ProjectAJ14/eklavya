# Working in `mcp/`

This directory owns the runtime: MCP server, learning and memory stores,
scheduling, hooks, installer, CLI and dashboard. Read the root `CLAUDE.md` first.

## Find the responsible module

| Area | Sources and boundary |
|---|---|
| Configuration | `config.ts`: defaults, validation, legacy aliases and scope merge; no database access. `config-path.ts`: dotted CLI keys and nullable types. |
| Paths and identity | `paths.ts`: all paths, env overrides, project config, worktree folding, private permissions and dashboard port. Never construct `~/.eklavya` paths elsewhere. `session.ts`: checkout-specific session pointers. |
| Learning | `srs.ts`: pure scheduling, tiers, scores and promotion; explicit `now`, no database or clock. `store.ts`: queries and gates. `slug.ts`: deduplication. |
| Database | `db.ts` opens WAL, foreign keys and busy timeout, then migrates and seeds. `migrations/` is forward-only. `seed.ts` never overwrites mastery. |
| Packs | `packs.ts`: validated overlays after seeds, fail-open per file, never delete concepts referenced by attempts. |
| Tools | `server.ts` wires stdio; stdout is the MCP protocol, diagnostics use stderr. `tools/index.ts` registers all tools, applies busy retries and returns JSON error envelopes. Inputs use bounds in `tools/types.ts`. |
| Hooks | `hooks/*.ts`; registration and launcher in the top-level `hooks/`. Read `hooks/CLAUDE.md` for output, pacing, delegation and fail-open rules. |
| CLI | `cli.ts` builds to `dist/cli.js`; `cli-memory.ts` loads only for memory commands, keeping statusline startup light. The top-level `cli/` is the POSIX git gate. |
| Installation | `install.ts`, `safe-write.ts`, `install-lock.ts`, `onboard.ts`, `claude-mem.ts`, `update.ts`. Preserve user files, lock ownership and recovery paths. |
| Terminal | `theme.ts` owns CLI styling (keep its talea counterpart aligned); `statusline.ts` owns dials in the host status bar. `stdin.ts` owns bounded input. |
| Questions | `mcq.ts`: answer positioning. `ask.ts`: historical header stripping. `surface.ts`: host-specific attribution. |
| Dashboard and artifacts | `dashboard.ts`, `assets/dashboard.html`, `artifacts.ts`, `assets/artifact-template.html`; read `.claude/skills/eklavya-dashboard/SKILL.md` before dashboard work. |
| Memory | `memory/`: capture, privacy, spool, queries, search/embeddings, summarization, worker/reservation, recall, replay, learning candidates, collections, code lookup, notifications, sync and import. No MCP or host API dependencies. |
| Evaluation | `eval/*.ts` is deterministic and I/O-free; root `eval/harness.mjs` orchestrates model calls. |

## Configuration and trust

Read defaults from `DEFAULT_CONFIG`: quiz enabled, unenforced; focus `concept`;
cadence `interleaved`; difficulty `auto`. Tool descriptions and skills must use
the same values. Normalize legacy `mode` per file before merging, permanently:
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
`set_config` schema, plus the corresponding documentation. An uncoerced field
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
- A clean `declined` outcome is excluded from retries. `dont_know` is eligible.
  Decline plus feedback is contradictory: the tool returns `outcome_conflict`,
  and legacy contradictory rows remain retryable. Never guess an outcome.

The planner owns the interleaved cap: one question only when unenforced and no
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

## Persistence, updates and safe writes

All tool handlers register through `registerTools` to retain retries on
`SQLITE_BUSY` and the error envelope. Transactions roll back before retry.
Tests must use temporary `EKLAVYA_HOME` / `EKLAVYA_DB` or explicit config,
including in-process tests. `EKLAVYA_SESSION_ID` intentionally joins sessions.
Session pointers use checkout roots, keeping concurrent worktrees distinct;
project settings fold worktrees, session pointers do not.

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

The dashboard is loopback-only and read-only (GET/HEAD, security headers).
Artifact resolution must reject traversal and stay inside the real artifact
root. Artifact creation never overwrites or publishes; metadata lives in HTML
heads, not a database table. The template inlines shared design tokens.

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
npm run build        # TypeScript and bundled assets
npm run dev          # MCP server from source
```

Bare watch-mode Vitest does not rebuild the files spawned by integration tests.
For behavior changes, also run the live acceptance check in `CONTRIBUTING.md`.
Pedagogy changes require eval evidence; docs changes require the website build.
Report missing evidence explicitly.
