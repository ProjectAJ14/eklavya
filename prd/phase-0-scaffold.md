# Phase 0 — Scaffold

**Status:** ✅ Done — 2026-08-26
**Depends on:** nothing
**Spec:** [PRD §6](PRD.md#6-architecture-overview), [§7](PRD.md#7-data-model-sqlite), [§13](PRD.md#13-milestones-and-acceptance-criteria)

## Objective

Stand up the repo skeleton, a building TypeScript MCP server, the SQLite schema with migrations, and the seed concept graphs. No pedagogy, no hooks behavior yet — just a server that starts and a DB that exists.

## Scope

In: repo layout, toolchain, migrations, seed loader, `tools/list` responding over stdio, doc verification.
Out: any MCP tool logic beyond a stub, hooks, commands, skill content.

## Tasks

### 0.1 Doc verification (do first — PRD §6 note)
- [x] Fetch https://code.claude.com/docs/en/plugins — confirm `plugin.json` schema and directory conventions
- [x] Fetch https://code.claude.com/docs/en/hooks — confirm `hooks.json` schema, stdin fields, output/exit-code semantics
- [x] Fetch https://code.claude.com/docs/en/mcp — confirm how a plugin registers an MCP server (`.mcp.json` at plugin root)
- [x] Record findings in `docs/verified-schemas.md` with the fetch date, so later phases don't re-guess

### 0.2 Repo hygiene
- [x] `.gitignore` (node_modules, dist, *.db, *.db-wal, *.db-shm)
- [x] `LICENSE` (MIT)
- [x] `README.md` stub with prerequisites (`node >= 18`, `jq`, `sqlite3`)
- [x] Directory skeleton per PRD §6

### 0.3 Plugin manifest
- [x] `.claude-plugin/plugin.json` — name `eklavya`, description, version `0.1.0`, author
- [x] `.mcp.json` at plugin root registering `eklavya` server via `${CLAUDE_PLUGIN_ROOT}`
- [x] `claude plugin validate .` passes

### 0.4 MCP server toolchain
- [x] `mcp/package.json` — `@modelcontextprotocol/sdk`, `better-sqlite3`, `vitest`, `typescript`, `tsx`
- [x] `mcp/tsconfig.json` — NodeNext, strict, outDir `dist`
- [x] `mcp/src/server.ts` — stdio transport, registers tool stubs, responds to `tools/list`
- [x] `npm run build` produces `mcp/dist/server.js`

### 0.5 Database layer
- [x] `mcp/src/db.ts` — resolve `~/.eklavya/knowledge.db`, create dir, open, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`
- [x] `mcp/src/migrations/001_init.sql` — all 7 tables exactly as PRD §7
- [x] Migration runner: numbered files applied in order, current version stored in `meta.schema_version`, idempotent on restart
- [x] Indexes: `session_concepts(session_id)`, `attempts(concept_id, ts)`, `mastery(next_review)`, `concepts(domain)`

### 0.6 Seed concept graphs
- [x] `mcp/src/seed/web-auth.json` — ≥ 20 concepts with tiers + prerequisite edges
- [x] `mcp/src/seed/git.json` — ≥ 10 concepts
- [x] `mcp/src/seed/react.json` — starter set
- [x] `mcp/src/seed/node-backend.json` — starter set
- [x] Seed loader: idempotent upsert by slug, marks `source='seed'`, never clobbers `mastery`
- [x] Slug normalization helper (kebab-case) shared with future `upsert_concepts`

### 0.7 Tests
- [x] vitest configured, runs against a temp DB (not `~/.eklavya`)
- [x] Test: migrations apply cleanly twice in a row (idempotent)
- [x] Test: seed loader is idempotent — running twice yields the same concept count
- [x] Test: WAL + foreign_keys pragmas actually set

## Acceptance criteria

- [x] `sqlite3 ~/.eklavya/knowledge.db '.tables'` lists `meta concepts edges mastery attempts session_concepts gates`
- [x] Server responds to a `tools/list` JSON-RPC request over stdio
- [x] `web-auth` seeds ≥ 20 concepts with edges; `git` seeds ≥ 10
- [x] `npm test` green

## Notes / decisions

**2026-08-26 — 0.1 doc verification complete.** Findings pinned in [`docs/verified-schemas.md`](../docs/verified-schemas.md). Three deviations from the PRD, which override the PRD text where they conflict:

- **D1** — the `Stop` hook blocks via **exit 2 + stderr**, not the `{"decision":"block","reason":...}` stdout envelope in PRD §9.2. No Stop-specific JSON output shape is documented any more.
- **D2** — `stop_hook_active` is no longer a documented stdin field. The loop guard must be a DB-side marker that is correct with zero help from the harness. This *raises* the P0 Stop-loop risk; phase 2 tests the guard before writing the hook.
- **D3** — `hooks[].timeout` is in seconds; the MCP server `timeout` is in milliseconds.

**2026-08-26 — 0.2–0.7 complete.** Notes on where the build differs from, or goes beyond, the phase plan:

- **Tool files.** PRD §6 wants one file per MCP tool. Phase 0 registers all nine in `mcp/src/tools/index.ts` with real zod input schemas and `not_implemented` handlers, so `tools/list` is already correct. Phase 1 splits them out as it fills in the logic.
- **Seeds ship larger than the floor:** web-auth 33 concepts, git 19, react 18, node-backend 17 — 87 concepts and 88 edges total, tiers 1–5.
- **Seeding runs on server start**, guarded by `meta.seed_version`, not only from `/eklavya:setup`. Idempotent, and mastery rows are never touched, so shipping new seed content just means bumping `SEED_VERSION`.
- **`busy_timeout = 5000`** set alongside WAL — Phase 4's concurrency work needs it and it costs nothing now.
- **`EKLAVYA_HOME` / `EKLAVYA_DB` env overrides** so tests never touch the real learner DB.
- **Seed validation is strict at load time:** slug shape, tier range, unknown relations, dangling and self edges all throw. Cheap insurance against slug sprawl (PRD §15).
- **Toolchain notes:** Node 26 has no `better-sqlite3` prebuild, so it compiles from source — `npm install-scripts approve better-sqlite3` is needed under npm 11's script policy. vitest pinned to ^4 to clear the vite/esbuild advisories; `npm audit` is clean.

Also confirmed: `.mcp.json` belongs at the **plugin root**, not inside `.claude-plugin/` (only `plugin.json` goes there), and `${CLAUDE_PLUGIN_ROOT}` needs no `:-` default in plugin-provided config.
