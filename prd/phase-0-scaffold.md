# Phase 0 — Scaffold

**Status:** 🟡 In progress
**Depends on:** nothing
**Spec:** [PRD §6](PRD.md#6-architecture-overview), [§7](PRD.md#7-data-model-sqlite), [§13](PRD.md#13-milestones-and-acceptance-criteria)

## Objective

Stand up the repo skeleton, a building TypeScript MCP server, the SQLite schema with migrations, and the seed concept graphs. No pedagogy, no hooks behavior yet — just a server that starts and a DB that exists.

## Scope

In: repo layout, toolchain, migrations, seed loader, `tools/list` responding over stdio, doc verification.
Out: any MCP tool logic beyond a stub, hooks, commands, skill content.

## Tasks

### 0.1 Doc verification (do first — PRD §6 note)
- [ ] Fetch https://code.claude.com/docs/en/plugins — confirm `plugin.json` schema and directory conventions
- [ ] Fetch https://code.claude.com/docs/en/hooks — confirm `hooks.json` schema, stdin fields, output/exit-code semantics
- [ ] Fetch https://code.claude.com/docs/en/mcp — confirm how a plugin registers an MCP server (`.mcp.json` at plugin root)
- [ ] Record findings in `docs/verified-schemas.md` with the fetch date, so later phases don't re-guess

### 0.2 Repo hygiene
- [ ] `.gitignore` (node_modules, dist, *.db, *.db-wal, *.db-shm)
- [ ] `LICENSE` (MIT)
- [ ] `README.md` stub with prerequisites (`node >= 18`, `jq`, `sqlite3`)
- [ ] Directory skeleton per PRD §6

### 0.3 Plugin manifest
- [ ] `.claude-plugin/plugin.json` — name `eklavya`, description, version `0.1.0`, author
- [ ] `.mcp.json` at plugin root registering `eklavya` server via `${CLAUDE_PLUGIN_ROOT}`
- [ ] `claude plugin validate .` passes

### 0.4 MCP server toolchain
- [ ] `mcp/package.json` — `@modelcontextprotocol/sdk`, `better-sqlite3`, `vitest`, `typescript`, `tsx`
- [ ] `mcp/tsconfig.json` — NodeNext, strict, outDir `dist`
- [ ] `mcp/src/server.ts` — stdio transport, registers tool stubs, responds to `tools/list`
- [ ] `npm run build` produces `mcp/dist/server.js`

### 0.5 Database layer
- [ ] `mcp/src/db.ts` — resolve `~/.eklavya/knowledge.db`, create dir, open, `PRAGMA journal_mode=WAL`, `PRAGMA foreign_keys=ON`
- [ ] `mcp/src/migrations/001_init.sql` — all 7 tables exactly as PRD §7
- [ ] Migration runner: numbered files applied in order, current version stored in `meta.schema_version`, idempotent on restart
- [ ] Indexes: `session_concepts(session_id)`, `attempts(concept_id, ts)`, `mastery(next_review)`, `concepts(domain)`

### 0.6 Seed concept graphs
- [ ] `mcp/src/seed/web-auth.json` — ≥ 20 concepts with tiers + prerequisite edges
- [ ] `mcp/src/seed/git.json` — ≥ 10 concepts
- [ ] `mcp/src/seed/react.json` — starter set
- [ ] `mcp/src/seed/node-backend.json` — starter set
- [ ] Seed loader: idempotent upsert by slug, marks `source='seed'`, never clobbers `mastery`
- [ ] Slug normalization helper (kebab-case) shared with future `upsert_concepts`

### 0.7 Tests
- [ ] vitest configured, runs against a temp DB (not `~/.eklavya`)
- [ ] Test: migrations apply cleanly twice in a row (idempotent)
- [ ] Test: seed loader is idempotent — running twice yields the same concept count
- [ ] Test: WAL + foreign_keys pragmas actually set

## Acceptance criteria

- [ ] `sqlite3 ~/.eklavya/knowledge.db '.tables'` lists `meta concepts edges mastery attempts session_concepts gates`
- [ ] Server responds to a `tools/list` JSON-RPC request over stdio
- [ ] `web-auth` seeds ≥ 20 concepts with edges; `git` seeds ≥ 10
- [ ] `npm test` green

## Notes / decisions

_(record deviations from the spec here as they happen)_
