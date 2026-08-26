# Phase 5 — Distribution & Cursor

**Status:** 🟠 Prepared — publishing and clean-machine verification are yours to run
**Depends on:** Phase 4 (or Phase 3, if Phase 4 is deferred)
**Spec:** [PRD §12](PRD.md#12-portability-design-constraints-for-future-cursor-support)

## Objective

Ship it. One install command for Claude Code, one `mcpServers` entry for Cursor.

## Tasks

### 5.1 npm package
- [x] Scoped package `@<org>/eklavya-mcp`, bin entry so `npx eklavya-mcp` works standalone
- [ ] Prebuild / rebuild strategy for `better-sqlite3` native bindings across platforms
- [ ] Version/release process documented

### 5.2 Marketplace listing
- [x] `.claude-plugin/marketplace.json` (or submission to the community marketplace)
- [x] `claude plugin validate .` clean, no warnings
- [ ] Install instructions verified on a clean machine

### 5.3 `export-rules` CLI
- [x] `eklavya export-rules` derives a Cursor rules file from `skills/tutor/SKILL.md` — single source of truth, no forked pedagogy
- [x] `eklavya config get/set` subcommands (PRD §4 references `eklavya config set mode off`)

### 5.4 Docs
- [x] README: Claude Code quickstart
- [x] README: Cursor quickstart (MCP entry + rules export + git hook)
- [x] README: manual test script per phase demo (PRD §14)
- [x] Pin the three official doc URLs (PRD §6) so drift is easy to re-check

## Acceptance criteria

- [ ] Clean machine: install plugin → `/eklavya:setup` → working quiz loop
- [ ] Clean machine: Cursor with one `mcpServers` entry → tools reachable, git gate enforced
- [ ] Published package version matches the plugin manifest version

## Notes / decisions

**2026-08-26 — everything that can be done from here is done; three items are deliberately left to you.**

Built and verified:

- **`eklavya` CLI** — `export-rules`, `config get/set` (with `--repo`), `doctor`, `db-path`. 15 tests.
- **`export-rules` has no forked pedagogy.** The build copies `skills/tutor/SKILL.md` into `dist/assets/`, so the Cursor rules file is generated from the same text Claude Code reads and the two editors cannot drift. It also ships inside the npm package, so a standalone install can generate rules with no plugin checkout. A test asserts the actual pedagogy survives the export, not just the wrapper.
- **`.claude-plugin/marketplace.json`** — `claude plugin validate . --strict` passes clean.
- **npm packaging** — `bin` entries for both `eklavya-mcp` and `eklavya`, `files` limited to `dist`, `prepublishOnly` builds.
- **README** — Claude Code and Cursor quickstarts, and a by-hand test script for each phase demo (PRD §14).

Left undone, on purpose:

- **`npm publish` was not run.** Publishing is irreversible and public, and it needs your npm account. The PRD asks for a scope (`@<org>/eklavya-mcp`); the package is currently unscoped as `eklavya-mcp`, so decide the scope before the first publish — renaming after the fact is worse than choosing now.
- **The marketplace install command has a placeholder owner** (`<your-github-user>/eklavya`) rather than a guessed GitHub account. Fill it in once the repo is pushed.
- **Clean-machine verification is not something this environment can honestly claim.** Both acceptance boxes below stay unchecked until someone runs them on a machine that has never had Eklavya on it — that is exactly the check that catches a missing native build or a path that only worked here.
