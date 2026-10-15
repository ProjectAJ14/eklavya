# Working on `web/`

The hand-written landing page and Astro Starlight manual share design tokens
and deploy to Firebase at https://eklavya-run.web.app. Read the root `CLAUDE.md`
and `.claude/skills/eklavya-design/SKILL.md` before changing them.

## File map

| Path | Owns |
|---|---|
| `public/index.html`, `styles.css`, `app.js` | Landing copy, mascot hero, compact `#legend`, embedded `#demo`, GitHub stars, navigation and theme controls |
| `public/demo/` | Automatic replay assets and the legacy `/demo/` redirect |
| `public/hero-eyes.js`, `hero-eyes.css` | Green eyes and mouse tracking for the landing-page hero mascot only |
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
| `installing.mdx` | `mcp/src/install.ts` (recommended install and verification path), `mcp/src/config.ts` (automatic defaults), `mcp/src/safe-write.ts` (the `.eklavya-bak` backups and the refusal to touch an unparseable file), `.mcp.json`, `hooks/run.mjs` (the background runtime heal). `README.md` points here rather than repeating it — keep it that way |
| `installation-options.mdx` | `mcp/src/install.ts`, plugin manifests, `.mcp.json`, `hooks/run.mjs`, `mcp/src/surface.ts`; verify marketplace, Cowork and contributor paths and their limitations |
| `updates.mdx` | `mcp/src/update.ts`, `install.ts`, `safe-write.ts`, `hooks/run.mjs`; update timing, repair, uninstall and retained data |
| `first-run.mdx` | `skills/setup/SKILL.md` |
| `first-session.mdx` | `hooks/hooks.json` and the seven hooks in `mcp/src/hooks/`; the quiz side panel section from `mcp/src/panel.ts`, `mcp/src/panel-state.ts` (`PANEL_SURFACES`, `PANEL_HEARTBEAT_TTL_MS`), `hooks/panel/model.ts` (strings) and `docs/verified-schemas.md` (tested host and version); the auto mode allow rule from `.claude-plugin/plugin.json` and `.mcp.json` (names) and `mcp/src/tools/panel_tools.ts` (tools), checked by `mcp/test/packaging.test.ts` |
| `dials.mdx` | `QuizConfig`, `Focus`, `Cadence`, `Difficulty`, `MemoryConfig` in `mcp/src/config.ts` — **and** `mcp/src/tools/get_session_quiz_plan.ts`, because the `as-you-go` one-question cap and its exemptions live in the planner, not in the config; the `quiz.panel` paragraph from `QuizConfig.panel` and `panelPresentation` in `mcp/src/panel-state.ts` |
| `levels-and-tiers.mdx` | `LEVEL_BANDS`, `LEVEL_UP_MIN_CONCEPTS`, `checkPromotion` in `mcp/src/srs.ts`; the tier labels are `TIER` in `mcp/src/assets/dashboard.html` and the tier table in `skills/tutor/SKILL.md` — `TIER_LABEL` left `ask.ts` with the settings line in 1.14 |
| `memory.mdx` | `mcp/src/memory/` — `privacy.ts` for the exclusion list and the secret shapes, `summarize.ts` for the local summariser and its ceiling, `embed.ts` and `search.ts` for what "semantic" means here, `tokens.ts` for what the savings percentage measures, `recall.ts` for what each recall sends and leaves out (with `hooks/session-start.ts` and `hooks/prompt-submit-nudge.ts` for when it runs), `code.ts` for the scanner's ceiling, `mcp/src/relocate.ts` for moved checkouts. The tool arguments are `mcp/src/tools/memory_read_tools.ts`, `memory_write_tools.ts`, `code_tools.ts` and `collection_tools.ts`; the honesty constraints are ADR-03 and ADR-07. Privacy lives here rather than on its own page |
| `commands.mdx` | the complete user-invocable inventory from `skills/` frontmatter, plus plain-chat skills under `user-skill/`; explain task, arguments and side effects without requiring one heading per command |
| `cli.mdx` | the `USAGE` string and command handlers in `mcp/src/cli.ts`, memory handlers in `cli-memory.ts`, and artifact handlers in `artifacts.ts` |
| `configuration.mdx` | `DEFAULT_CONFIG` in `mcp/src/config.ts` — every key, no omissions |
| `packs.mdx` | `mcp/src/packs.ts` (seed, global, legacy checkout and project layers; merge order and fail-open reads) and `validateSeedGraph` in `mcp/src/seed.ts` for the field rules. `skills/pack/SKILL.md` is the command it documents |
| `commit-gate.mdx` | `mcp/src/store.ts` (`PASSING_GRADE`, `syncGate`, `gateRetryConcepts`), the `gate_work` pass in `mcp/src/tools/get_session_quiz_plan.ts`, `cli/eklavya-gate`, `mcp/src/hooks/pre-tool-gate.ts` and `commit-lib.ts` (what counts as a commit, and the accepted misses), `scripts/install-git-hook.sh` |
| `dashboard.mdx` | `DEFAULT_PORT` (in `mcp/src/paths.ts`), `startDashboard`, `dashboardState`, `changeCursor` (what counts as a change; the watched tables are `mcp/src/migrations/021_change_version.sql`), `createLive` and its `EVENTS_*` constants (`/api/events`: what streams, what the watcher reads and when, the stream cap), `memoFor`, `MEMO_TTL_MS` and `send()`, `CACHE_HOUR` (what the server keeps and what the browser keeps), `ATTEMPT_LIMIT` and `LOGGED_LIMIT` (the caps), and `scopeTotals` and `sessionTotal` in `mcp/src/assets/dashboard.html` (which numbers it states from the server's aggregates and not from the capped rows), `ARTIFACT_CSP`, `MANIFEST` (the app install section) and `projectInventory` (which rows establish a project, and how worktrees and missing checkouts are named) in `mcp/src/dashboard.ts`, `listArtifacts` in `mcp/src/artifacts.ts`; the Settings section from `SETTINGS`, `CLI_ONLY`, `updateSetting`, `WRITES` and `acceptWrite` in `mcp/src/dashboard.ts` and `applySetting` in `mcp/src/config-path.ts`; the Feedback section from `feedbackSummary`, `listAcknowledged` and the `acknowledgeFeedback` gate in `mcp/src/feedback.ts`, `acknowledgeItem`, `deleteItem` and `openedItem` in `mcp/src/dashboard.ts`, and the `FB` strings and `fbTip` in `mcp/src/assets/dashboard.html`; the five workflows, their sidebars, routes and legacy aliases in `mcp/src/assets/dashboard.html` (`WORKFLOWS`, `LEGACY`, `resolve`), and its page sizes (`PER`); what a tab, chip, select, pager or live update keeps (`isAdjustment`, `drawAdjusted`, `captureUi`, `focusKey`, `unitsInUse`, `typingDate`), what a revisit reuses (`RESP`, `slot()`, `settingsFresh`) and the room a first visit holds (`slotMin`), what the open page does with the stream (`liveOpen`, `liveRefresh`, the `visibilitychange` handler) and the footer's cap line (`paintChrome`); the busy-dashboard paragraph from `PATIENT_PROBE_MS`, `stopDashboard` and `probeDashboard` in `mcp/src/dashboard-daemon.ts` and the probes in `mcp/src/cli.ts` |
| `how-it-works.mdx` | the prompt feedback section from `generateFeedback` and `startBackgroundFeedback` in `mcp/src/feedback.ts` (the 30-minute and 14-day windows, the cap of eight prompts, when it starts) and `REVIEW_SYSTEM` in `mcp/src/feedback-review.ts`; the `mcp/` / `hooks/` / `skills/` split in the root `CLAUDE.md`, `mcp/package.json` `engines` and its `better-sqlite3` dependency, and `cli/eklavya-gate` for the one place `jq` and `sqlite3` are still needed. The concept paragraph under the learning flow is from `mcp/src/concepts.ts` (name, tag and candidate rules) and `LIMITS` in `mcp/src/tools/types.ts`. This is where architecture and rationale trimmed off `index.mdx` belongs. It also embeds the runtime diagram and `DocFlow.astro` sequences; verify their labels against hook and planner code |
| `grading-engine.mdx` | `mcp/src/srs.ts` constants (`isKnown` and `KNOWN_SQL` hold the mastery rule; `passed_days` and `top_passed_tier` are written in `applyGrade`); the `get_session_quiz_plan` and `record_attempt` tool descriptions; `mcp/src/mcq.ts` and `skills/tutor/SKILL.md` for the option count, the "Other" escape hatch and the MCQ grade ceiling — none of which are in `srs.ts`; who grades in the panel from `mcp/src/panel.ts` (`panelAnswer`) and `hooks/panel/model.ts` (`RUBRIC`) |
| `your-data.mdx` | `mcp/src/paths.ts` (and `makePrivate`, the `0700`/`0600` modes), `mcp/src/db.ts`, `mcp/src/safe-write.ts`, `mcp/src/migrations/` (including `025_panel_questions.sql`, `PANEL_EXPIRY_HOURS` and `026_feedback.sql`, `027_invalid_questions.sql`) |
| `usage-analytics.mdx` | `buildEvents` in `mcp/src/telemetry-send.ts` (every event and field of the tool's ping, and `assertSafe`), `disabledReason`, `canSend` and `startBackgroundTelemetry` in `mcp/src/telemetry.ts` (the off switches, when it sends), `countUse` callers for `feature_use` names (including `openedItem` in `mcp/src/dashboard.ts`), and `public/analytics.js` for the website: its consent banner, the `eklavya-analytics` key and every event. Each table must list exactly what the code sends |
| `migrating.mdx` | `mcp/src/memory/import.ts` and the `memory import` handler in `mcp/src/cli-memory.ts` — the flags and the field-disposition report are quoted from there |
| `troubleshooting.mdx` | `doctor` in `mcp/src/cli.ts`, and the fail-open paths — `mcp/src/hooks/lib.ts`, `cli/eklavya-gate` |
| `faq.mdx` | `mcp/src/paths.ts`, the `AttemptOutcome` handling in `mcp/src/store.ts` (what a decline does), `uninstall` in `mcp/src/install.ts`, and `localTokens` in `mcp/src/dashboard.ts` — the dashboard strips the shared tokens' Google Fonts import and loads no font of its own, which is what lets the FAQ say it makes no outbound request at all; its testing answer comes from `mcp/.c8rc.json`, `mcp/vitest.config.ts` and the `test` job in `.github/workflows/test.yml` |


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

The landing hero introduces Eklavya with its mascot on a dark ground. Keep the
home page lean, with the automatic terminal replay embedded at `/#demo`.
Keep the faint bow-to-target animation in the first section's background. It
repeats while the hero is visible and the browser is active; reduced motion
shows still artwork. It must not obscure the copy, mascot or controls.
Only the hero mascot has green eyes, using the hero's `--spot` role. Its pupils
follow the mouse within the eye shapes and return to center when inactive.
Keep them centered on touch screens and with reduced motion. Leave the shared
mascot artwork and other instances unchanged.
`/demo/` redirects there for old links. How it works, dials, commands, dashboard
and memory details stay in the manual.

Keep the compact name story at `#legend`, with the eyebrow "The name", the
heading "The archer who taught himself", three short story columns and the
bow, arrow and target artwork. The SVG is decorative. Its animation runs once each time
the scene enters view, including after returning with Back; reduced motion shows a static scene. Preserve
`#legend` and `#legend-title` on the home page instead of redirecting them to docs.

Start the replay when the whole terminal box is visible. Wait or pause if the
analytics banner covers any part of it. The example types a
prompt, sends it with Enter, shows Claude working, then opens the quiz panel.
The example selects and submits an answer, shows the result, closes it with
Done and completes the task. The panel is hidden before the question arrives.
Visitors do not type or answer. Keep the prompt and quiz controls out of
keyboard navigation, and never move focus during the replay.
After completion, keep the same control enabled as "Replay demo". It resets the
whole example and follows the same visibility and pause rules. With reduced
motion, it returns to the beginning of the still transcript.

Pause the replay when the box leaves view, the tab is hidden or the window is
inactive. Honor reduced motion without animated typing, a blinking cursor or
panel transitions. Show that this is a browser replay and does not run Claude.
Do not invent live test results or GitHub star counts. Keep the star box and
its GitHub link visible while its count loads or if that request fails.

Keep quoted output consistent with `session-start.ts`, `statusline.ts` and
`checkpoint-quiz.ts`. Panel labels and logo come from `hooks/panel/model.ts`
through `scripts/demo-panel.mjs`. Terminal commit gating requires the separate
git-hook installer and project enforcement; never promise it from the default
install alone.

- Use role tokens (`--ink`, `--dim`, `--line`, `--spot`, etc.), not raw colors or
  palette scale steps. The demo terminal and mascot hero keep fixed dark roles.
- Match the demo's panel labels and states to the shipped mod, with the example
  selections and submission shown automatically. Honor reduced motion.
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
broken sidebar state or inaccessible controls. Check the demo's whole-box
visibility trigger and that the box fits each test viewport. Verify its initial
hidden panel, typing, work, question, automatic answer, result, Done and task
completion. Check pauses on scroll, tab visibility and window focus, stable
keyboard focus, and reduced motion. Check `/#demo` and the `/demo/` redirect.
Check the legend's heading, columns, in-page anchors, one-shot arrow animation
and static reduced-motion view in both themes.
Check the hero eyes against the brand accent, bounded mouse tracking, centered
touch/reduced-motion eyes and unchanged mascots elsewhere.
Report the actual checks, including any not run.

After changing shared identity, run `npm run seo:refresh` and commit the
homepage update. The root README reuses `public/brand/mark.svg` directly; do not introduce another logo.
After changing `public/brand/mark.svg`, run `npm run icons`
and commit exports. Share cards derive from page title/description. Follow
`SEO.md` for publishing checks; a local build is not proof of indexing or a
production deployment. Site-only commits use `docs:` and do not cut a release.
