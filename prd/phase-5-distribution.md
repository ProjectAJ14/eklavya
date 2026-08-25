# Phase 5 — Distribution & Cursor

**Status:** ⬜ Not started
**Depends on:** Phase 4 (or Phase 3, if Phase 4 is deferred)
**Spec:** [PRD §12](PRD.md#12-portability-design-constraints-for-future-cursor-support)

## Objective

Ship it. One install command for Claude Code, one `mcpServers` entry for Cursor.

## Tasks

### 5.1 npm package
- [ ] Scoped package `@<org>/eklavya-mcp`, bin entry so `npx eklavya-mcp` works standalone
- [ ] Prebuild / rebuild strategy for `better-sqlite3` native bindings across platforms
- [ ] Version/release process documented

### 5.2 Marketplace listing
- [ ] `.claude-plugin/marketplace.json` (or submission to the community marketplace)
- [ ] `claude plugin validate .` clean, no warnings
- [ ] Install instructions verified on a clean machine

### 5.3 `export-rules` CLI
- [ ] `eklavya export-rules` derives a Cursor rules file from `skills/tutor/SKILL.md` — single source of truth, no forked pedagogy
- [ ] `eklavya config get/set` subcommands (PRD §4 references `eklavya config set mode off`)

### 5.4 Docs
- [ ] README: Claude Code quickstart
- [ ] README: Cursor quickstart (MCP entry + rules export + git hook)
- [ ] README: manual test script per phase demo (PRD §14)
- [ ] Pin the three official doc URLs (PRD §6) so drift is easy to re-check

## Acceptance criteria

- [ ] Clean machine: install plugin → `/eklavya:setup` → working quiz loop
- [ ] Clean machine: Cursor with one `mcpServers` entry → tools reachable, git gate enforced
- [ ] Published package version matches the plugin manifest version

## Notes / decisions
