# Working on `web/`

The hand-written landing page and Astro Starlight manual share design tokens
and deploy to Firebase at https://eklavya-run.web.app. Read the root `CLAUDE.md`
and `.claude/skills/eklavya-design/SKILL.md` before changing them.

## File map

| Path | Owns |
|---|---|
| `public/index.html`, `styles.css`, `app.js` | Landing copy, components and interactive terminal |
| `public/tokens.css` | Shared scale and semantic roles for ink/paper themes |
| `src/content/docs/docs/*.mdx` | Manual pages at `/docs/…` |
| `src/styles/docs.css` | Starlight theme integration |
| `src/components/` | Branding, theme/head overrides, generated-diagram embed and simple `DocFlow` sequences |
| `src/plugins/rehype-brand.mjs` | Build-time accent on prose mentions of Eklavya |
| `astro.config.mjs` | Hand-ordered sidebar; every page needs an entry |
| `SEO.md`, `src/lib/seo.mjs` | Metadata, canonical identity and build/publication checks |

```bash
npm ci
npm run dev       # development at localhost:4321
npm run build     # production output plus SEO/link audit
npm run preview   # serve the built site
```

## Keep documentation aligned with source

Behavior and documentation ship in the same PR. Check each factual claim
against the implementation, not against another page. Guides teach a task;
reference pages enumerate complete fields and commands. Keep a single canonical
home for details and link to it from shorter introductions.

Every manual page has a row below. Add a row, sidebar entry, unique frontmatter
description and incoming link with each new page. Moving a page requires fixing
links and preserving useful anchors or adding a redirect.

| Page | Source of truth |
|---|---|
| `index.mdx` | the loop as it actually runs: the seven hooks in `mcp/src/hooks/` and `max_questions_per_task` in `mcp/src/config.ts`. It also carries the one prerequisite — `mcp/package.json` `engines` — read directly from `mcp/package.json`. Keep it short: it introduces the product and directs the reader to the next guide |
| `installing.mdx` | `mcp/src/install.ts` (recommended install and verification path), `mcp/src/onboard.ts` (settings walkthrough), `mcp/src/safe-write.ts` (the `.eklavya-bak` backups and the refusal to touch an unparseable file), `.mcp.json`, `hooks/run.mjs` (the background runtime heal). `README.md` points here rather than repeating it — keep it that way |
| `installation-options.mdx` | `mcp/src/install.ts`, plugin manifests, `.mcp.json`, `hooks/run.mjs`, `mcp/src/surface.ts`; verify marketplace, Cowork and contributor paths and their limitations |
| `updates.mdx` | `mcp/src/update.ts`, `install.ts`, `safe-write.ts`, `hooks/run.mjs`; update timing, repair, uninstall and retained data |
| `first-run.mdx` | `skills/setup/SKILL.md` |
| `first-session.mdx` | `hooks/hooks.json` and the seven hooks in `mcp/src/hooks/` |
| `dials.mdx` | `QuizConfig`, `Focus`, `Cadence`, `Difficulty`, `MemoryConfig` in `mcp/src/config.ts` — **and** `mcp/src/tools/get_session_quiz_plan.ts`, because the `interleaved` one-question cap and its exemptions live in the planner, not in the config |
| `levels-and-tiers.mdx` | `LEVEL_BANDS`, `LEVEL_UP_MIN_CONCEPTS`, `checkPromotion` in `mcp/src/srs.ts`; the tier labels are `TIER` in `mcp/src/assets/dashboard.html` and the tier table in `skills/tutor/SKILL.md` — `TIER_LABEL` left `ask.ts` with the settings line in 1.14 |
| `memory.mdx` | `mcp/src/memory/` — `privacy.ts` for the exclusion list and the secret shapes, `summarize.ts` for the local summariser and its ceiling, `embed.ts` and `search.ts` for what "semantic" means here, `tokens.ts` for what the savings percentage measures, `code.ts` for the scanner's ceiling. The tool arguments are `mcp/src/tools/memory_read_tools.ts`, `memory_write_tools.ts`, `code_tools.ts` and `collection_tools.ts`; the honesty constraints are ADR-03 and ADR-07. Privacy lives here rather than on its own page |
| `commands.mdx` | the complete user-invocable inventory from `skills/` frontmatter, plus plain-chat skills under `user-skill/`; explain task, arguments and side effects without requiring one heading per command |
| `cli.mdx` | the `USAGE` string and command handlers in `mcp/src/cli.ts`, memory handlers in `cli-memory.ts`, and artifact handlers in `artifacts.ts` |
| `configuration.mdx` | `DEFAULT_CONFIG` in `mcp/src/config.ts` — every key, no omissions |
| `packs.mdx` | `mcp/src/packs.ts` (seed, global, legacy checkout and project layers; merge order and fail-open reads) and `validateSeedGraph` in `mcp/src/seed.ts` for the field rules. `skills/pack/SKILL.md` is the command it documents |
| `commit-gate.mdx` | `mcp/src/store.ts` (`PASSING_GRADE`, `syncGate`, `gateRetryConcepts`), the `gate_work` pass in `mcp/src/tools/get_session_quiz_plan.ts`, `cli/eklavya-gate`, `mcp/src/hooks/pre-tool-gate.ts` and `commit-lib.ts` (what counts as a commit, and the accepted misses), `scripts/install-git-hook.sh` |
| `dashboard.mdx` | `DEFAULT_PORT` (in `mcp/src/paths.ts`), `startDashboard`, `dashboardState`, `ARTIFACT_CSP` and `projectInventory` (which rows establish a project, and how worktrees and missing checkouts are named) in `mcp/src/dashboard.ts`, `listArtifacts` in `mcp/src/artifacts.ts`; the three workflows, their sidebars, routes and legacy aliases in `mcp/src/assets/dashboard.html` (`WORKFLOWS`, `LEGACY`, `resolve`), and its page sizes (`PER`) |
| `how-it-works.mdx` | the `mcp/` / `hooks/` / `skills/` split in the root `CLAUDE.md`, `mcp/package.json` `engines` and its `better-sqlite3` dependency, and `cli/eklavya-gate` for the one place `jq` and `sqlite3` are still needed. This is where architecture and rationale trimmed off `index.mdx` belongs. It also embeds the runtime diagram and `DocFlow.astro` sequences; verify their labels against hook and planner code |
| `grading-engine.mdx` | `mcp/src/srs.ts` constants; the `get_session_quiz_plan` and `record_attempt` tool descriptions; `mcp/src/mcq.ts` and `skills/tutor/SKILL.md` for the option count, the "Other" escape hatch and the MCQ grade ceiling — none of which are in `srs.ts` |
| `your-data.mdx` | `mcp/src/paths.ts` (and `makePrivate`, the `0700`/`0600` modes), `mcp/src/db.ts`, `mcp/src/safe-write.ts`, `mcp/src/migrations/` |
| `usage-analytics.mdx` | `public/analytics.js` — the consent banner, the `eklavya-analytics` key and every event it sends. The page's event table must list exactly what that file sends |
| `migrating.mdx` | `mcp/src/memory/import.ts` and the `memory import` handler in `mcp/src/cli-memory.ts` — the flags and the field-disposition report are quoted from there |
| `troubleshooting.mdx` | `doctor` in `mcp/src/cli.ts`, and the fail-open paths — `mcp/src/hooks/lib.ts`, `cli/eklavya-gate` |
| `faq.mdx` | `mcp/src/paths.ts`, the `AttemptOutcome` handling in `mcp/src/store.ts` (what a decline does), `uninstall` in `mcp/src/install.ts`, and `localTokens` in `mcp/src/dashboard.ts` — the dashboard strips the shared tokens' Google Fonts import and loads no font of its own, which is what lets the FAQ say it makes no outbound request at all |


## Write for a developer's first week

Lead with the outcome, show the shortest working path, then separate optional
routes and troubleshooting. Explain jargon once. Use second person, present
tense, sentence case and concrete examples. Prefer short paragraphs, ordered
steps for procedures and tables for repeated fields; avoid long bullet walls.
Do not use emoji or unsupported performance/privacy promises.

Installation's primary page should get the reader installed and verified.
Alternative hosts and development setup belong in `installation-options`;
upgrades/removal in `updates`; complete flags in `cli`; complete settings in
`configuration`. Do not grow the quick start back into an exhaustive reference.

Command examples must run as written; identify required replacements such as
`/path/to/eklavya` and `<topic>`. Describe unverified host UI as the interactive
`/plugin` menu rather than guessing subcommands. Exported rules and a standalone
MCP connection do not provide another editor with Claude Code's ambient hooks.

Starlight supplies the title, table of contents and previous/next navigation.
Use `##`/`###`, `<Steps>`, restrained notes/tips/cautions, and code-fence titles
for filenames. Keep warnings next to the action they affect.

## Diagrams

Use `DocFlow.astro` for short ordered sequences or timelines. Keep stage labels
brief and put conditions, branch outcomes and limitations in nearby prose.
Meaning must survive without arrows, color or JavaScript; maintain a readable
text order, accessible caption and narrow-screen layout. Update each flow with
the behavior it depicts and inspect both themes.

`EmbeddedDiagram.astro` displays the detailed generated runtime architecture.
`prebuild`/`predev` copy `docs/eklavya-runtime.html` through
`scripts/embed-diagram.mjs`; do not edit the generated HTML or commit the public
copy. Root guidance owns regeneration. The copy alone receives website icons,
canonical/share metadata and `noindex, follow`; missing markers fail the build.

The embedded viewer is a noninteractive still picture with a real link to open
the full viewer. Preserve disabled pointer events, fit/crop after fonts load,
fallback when measuring fails, and theme synchronization. Supply an iframe
title and explanatory caption; neither alone substitutes for the diagram's
information in text.

## Landing output and design invariants

The hero quotes real output: SessionStart banner from `session-start.ts`, dials
from `statusLine` in `statusline.ts`, checkpoint from `checkpoint-quiz.ts`.
Re-quote affected examples when those outputs change. Keep `app.js` `VERDICTS`
aligned with the no-JS fallback in `.term__screen:not([data-ready])` CSS.
Terminal commit gating requires the separate git-hook installer and project
enforcement; never promise it from the default install alone.

- Use role tokens (`--ink`, `--dim`, `--line`, `--spot`, etc.), not raw colors or
  palette scale steps. The hero terminal deliberately keeps its fixed palette.
- Preserve terminal/arrow geometry, timing and behavior. Honor reduced motion.
- Override Starlight colors in both theme blocks. Check text against its own
  fill so token mistakes do not create invisible labels.
- Keep table cells at `overflow-wrap: break-word`, not `anywhere`; retain the
  first-column width floor. Code-containing grids need `minmax(0, 1fr)`.
- Let `rehype-brand` and `PageTitle.astro` accent the product name; do not add
  manual spans. Lowercase `eklavya` remains a binary/key, not branded prose.
- Bump affected `?v=N` queries when changing hand-written public assets.
- Preserve Firebase HTML revalidation and immutable fingerprinted assets in
  non-overlapping header rules. A second hosting path requires another build.

## Before opening a PR

Build and require the SEO audit to pass. It checks internal pages, fragments,
resources, metadata and README website links. Preview changed pages at 1280,
900 and 560px in both themes, with no horizontal page scroll, console errors,
broken sidebar state or inaccessible controls. Test terminal interaction when
landing behavior changes. Report the actual checks, including any not run.

After changing shared identity, run `npm run seo:refresh` and commit the
homepage update. The root README reuses `public/brand/mark.svg` directly; do not introduce another logo.
After changing `public/brand/mark.svg`, run `npm run icons`
and commit exports. Share cards derive from page title/description. Follow
`SEO.md` for publishing checks; a local build is not proof of indexing or a
production deployment. Site-only commits use `docs:` and do not cut a release.
