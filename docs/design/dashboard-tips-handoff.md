# Dashboard tips — design handoff

- **Base:** `main` @ `e1be369` (includes artifact tabs from #99 and the viewer fix from #100)
- **Branch:** `feat/dashboard-tips`
- **Previous brief:** `docs/design/artifact-tabs-handoff.md`
- **Design source:** the maintainer's screenshot of a Claude desktop tip (a filled
  bubble with an icon, one sentence, a close `×` and an arrow pointing at the
  feature), restyled to Eklavya's rules in `.claude/skills/eklavya-design/SKILL.md`.
  No Figma.
- **Library:** [Driver.js](https://driverjs.com) `1.9.0`, its `hints` module
  (MIT, no dependencies, 4.9 KB gzipped, no storage, no network requests).

## Agent preamble

Follow the root `CLAUDE.md` and `mcp/CLAUDE.md`; read `web/CLAUDE.md` before
the docs stage. Load `eklavya-dashboard` and `eklavya-design` before any UI
work and `verify-docs` before opening the PR. Tests use a temporary
`EKLAVYA_HOME` / `EKLAVYA_DB` and `EKLAVYA_DASHBOARD_PORT`, never the real ones.
Preserve everything the artifact-tabs brief established (the frame sandbox,
`TABS`, the pinned correction bar, `armLeave`).

## The feedback, verbatim intent

1. The dashboard shows a lot of information, so new users miss features.
   Add tips like the screenshot: a small bubble pointing at a feature, saying
   what it does, with a close button.
2. A tip appears when the user opens a page or goes somewhere.
3. Tips come from **one configurable list** that we keep adding to.
4. The goal is that the user learns about every feature: what it is and what it does.
5. Use a well-established library rather than building the tip mechanics ourselves.

## What the investigation found

| Fact | Where | Status |
|---|---|---|
| The dashboard has no tips, tour or first-run code today, and none in history. | `git log -S tips`, `git log -S onboard` on `dashboard.html` | Verified. New feature. |
| Every screen change goes through `render()`, which rebuilds `#view` and runs `AFTER` hooks once the DOM exists. That is the one place to decide which tips apply. | `render` `dashboard.html:3916-3948` | Verified. |
| Content loaded later (timeline, Settings, a memory entry) arrives through `fill()`, which runs its own `AFTER` hooks after drawing. A tip anchored inside it must be checked there too. | `fill` `dashboard.html:1415-1437` | Verified. |
| The page already keeps three per-viewer conveniences in `localStorage` inside `try/catch`: `eklavya-ground`, `eklavya-dash-folds`, `eklavya-dash-tabs`. | `dashboard.html:22`, `:1088`, `:2845` | Verified. Tip state is the same kind of thing. |
| The sidebar's **Ground** switch (`[data-ground]`, two `aria-pressed` buttons) is the existing pattern for a per-browser on/off. | `dashboard.html:795-801` | Verified. The tips switch copies it. |
| The page CSP allows scripts and styles from its own origin (`script-src 'self' 'unsafe-inline'`). The page loads nothing from other hosts, and the browser suite fails if it does. | `dashboard.ts:1408-1409`; skill "makes no request to any other host" | Verified. A library must be **served by the dashboard itself**, never a CDN. |
| `copy-assets.mjs` already copies files into `dist/assets/` at build time, and `/tokens.css` is served from there. | `mcp/scripts/copy-assets.mjs`; `dashboard.ts:1767` | Verified. The library ships the same way. |
| The dashboard skill says "No charting library, ever" and "Two files, and there is deliberately nothing else". | `.claude/skills/eklavya-dashboard/SKILL.md` | Verified. This brief adds the first client library. The skill must be updated in the same PR (Stage 3). No `CLAUDE.md` rule is broken: the no-network rule holds. |

### Library choice

| Candidate | License | Weekly downloads | What it gives | Verdict |
|---|---|---|---|---|
| **Driver.js `hints`** | MIT | 2.6 M (whole package) | Beacons on elements, an anchored popover with arrow and close button, auto-placement, reposition on scroll and resize, hide when the element leaves view, Escape and click-outside to close, `onDismiss` hook | **Pick.** Does every mechanical part; we write only the list and the remembering. |
| Driver.js core `highlight()` | MIT | same | One spotlight popover | Fallback. It dims the page and swallows the next click, which the screenshot does not do. |
| Shepherd.js, Intro.js | **AGPL-3.0** | — | Full tours | Rejected: AGPL in a published npm package. |
| Floating UI | MIT | 123 M | Positioning only | Rejected as primary: we would still write the popover, arrow, close, Escape and beacons. |
| Tippy.js | MIT | — | Tooltips | Rejected: last release 6.3.7 in 2021, needs Popper. |

**Risk to name:** the `hints` module first shipped in Driver.js `1.9.0`, published
**2026-10-03**. The package is long established; this module is new. So:
pin the exact version, and Stage 1 starts with a spike that checks six behaviours
before any other code is written. If any fails, use the fallback in the spike section.

What was verified by reading the `1.9.0` build: the browser file is
`dist/hints.iife.js` (15.5 KB) and defines the global `driverHints.hints(config)`;
`dist/hints.css` is 3.7 KB. It has no `localStorage`, no `fetch` and no URL other
than the SVG namespace. Beacons are real `<button>`s appended to `<body>` with
`aria-label` = the popover title and `aria-expanded`. The popover's button
(`Got it`) calls `dismiss(id)`, which fires `onDismiss`; the close `×`, Escape and
a click outside call `close()`, which keeps the beacon. `overlay: false`
(the default) draws no dimming layer.

## How it works for the learner

- On any screen, every tip that applies and is not yet dismissed puts a small
  pulsing **beacon** (a verdigris dot) on its feature.
- The **first** of those tips opens by itself, once per browser, 600 ms after the
  screen draws. That is the screenshot's bubble.
- **Got it** dismisses the tip for good. `×`, Escape or clicking elsewhere closes
  the bubble but leaves the beacon, so it can be reopened by clicking the dot.
- Only one bubble is open at a time. A tip that has already opened by itself
  never opens by itself again; it stays a beacon until dismissed.
- The sidebar gets a **Tips** switch (`on` / `off`) under **Ground**. Off hides all
  beacons and bubbles. Switching it back on shows every tip again from the start.

Example: a first-time reader lands on Learning → Dashboard. A bubble points at the
workflow switcher: "Eklavya has four workflows: Learning, Memory, Artifacts and
Settings. Switch between them here." A dot also sits on "How this works". They
click **Got it**; the bubble and its dot go. They open Concepts: a bubble points at
the filter chips. The "How this works" dot is still there until they open it or
dismiss it.

## Delivery order

One PR. After every stage, from `mcp/`:

```bash
npm run build
npm test
npm run coverage
```

100% on every metric. Stage 3 also runs `npm run build` in `web/`,
`.github/scripts/check-docs-sync.sh` and `/verify-docs`.

1. `feat:` The library, served locally, and the tip engine with the sidebar switch.
2. `feat:` The starter tips and the registry guard test.
3. `docs:` Manual, landing, READMEs, dashboard skill.

## Stage 1 — Library and tip engine

### 1a. Spike first (no commit)

Load the vendored file into the running dashboard and confirm, in Chromium, each of:

1. No request leaves `127.0.0.1` (the browser suite's outbound check).
2. With `overlay: false`, clicking anywhere on the page still works on the first click.
3. `open(id)` opens a bubble after `show()` without the beacon being clicked.
4. Escape closes the bubble and returns focus to the beacon.
5. The close `×` has an accessible name and the bubble is reachable by Tab.
6. `onDismiss` fires on **Got it** with the hint's `id`.

If 2 or 3 fails: use Driver.js core (`driver.js.iife.js`, same package, global
`driver.js.driver`) with `driver({ overlayOpacity: 0, allowClose: true }).highlight({ element, popover })`
and drop beacons. Report it in the PR. If 1 fails: stop and tell the maintainer.

### 1b. Ship the library

- `mcp/package.json` `devDependencies`: `"driver.js": "1.9.0"` (exact, no caret).
  A devDependency: the file is copied into `dist`, so users install nothing extra.
- `copy-assets.mjs`: copy `node_modules/driver.js/dist/hints.iife.js`,
  `hints.css` and `license` to `dist/assets/vendor/driver-hints.js`,
  `driver-hints.css`, `driver-hints.LICENSE`. **Fail the build** if they are
  missing (unlike the tutor skill, the page needs them).
- `dashboard.ts`: two routes through `send()`, so `SECURITY_HEADERS` apply:
  `/vendor/driver-hints.js` (`text/javascript`) and `/vendor/driver-hints.css`
  (`text/css`), `Cache-Control: max-age=3600`. Read once at start, like the page.
  No CSP change: `'self'` already covers them.
- `dashboard.html` `<head>`: `<link rel="stylesheet" href="/vendor/driver-hints.css">`
  before the page's own `<style>`, and `<script src="/vendor/driver-hints.js" defer>`.
  If the script fails to load, tips are simply absent: every call is guarded by
  `window.driverHints`.

### 1c. The tip engine (in `dashboard.html`)

One module-level `TIPS` array (Stage 2 fills it) and one `TIP` object, about
70 lines, next to `TABS`. No class, no framework.

**A tip entry:**

```js
{
  id: 'wf-switch',                       // stable, kebab-case, never reused
  where: ['learning/dashboard'],         // `<workflow>/<page>` from WORKFLOWS
  el: '#wf-caret',                       // CSS selector for the feature
  title: 'Switch workflow',              // beacon's accessible name, ≤ 32 chars
  text: 'Eklavya has four workflows…',   // one or two sentences, ≤ 140 chars
  side: 'right',                         // optional: top | right | bottom | left (default bottom)
  when: () => S.artifacts.some(…),       // optional: only when the data makes it true
}
```

Rules for entries, enforced by the Stage 2 test:

- `id` matches `/^[a-z0-9]+(-[a-z0-9]+)*$/`, unique. Renaming an id shows the tip
  again to everyone who dismissed it; reword the text instead. A genuinely new
  message gets a new id.
- Every `where` names a real page in `WORKFLOWS`.
- `text` is plain sentence-case prose, says what the feature **does** for the
  reader, no emoji, no "Click here". The page shows it through `esc()`.
- Array order is priority: the first eligible tip on a screen is the one that opens.

**Storage**: `localStorage['eklavya-dash-tips']` = `{ "off": false, "done": [ids], "opened": [ids] }`,
read and written in `try/catch`. Unknown ids are ignored. Malformed JSON means
the default (all on, nothing done). **Storage that throws means no tips at
all**: without memory a tip would reopen on every load.

**`TIP.sync()`**, called as the last `AFTER` hook of `render()` and at the end of
every `fill()` draw (both already guarded by `GEN`):

1. If tips are off, storage failed, `window.driverHints` is missing, the drawer
   is open, the correction `<dialog>` is open, or a picker menu is open:
   `hints.hide()` and stop.
2. Eligible = `TIPS` where `where` includes `${CUR.wf}/${CUR.page}`, the id is not
   in `done`, `when()` (if any) is true, and `document.querySelector(el)` is a
   rendered element (`getClientRects().length > 0`).
3. `hints.setHints(eligible.map(toHint))`, then `hints.show()`.
4. The first eligible id not in `opened`: after **600 ms** (cancelled if `GEN`
   changed), `hints.open(id)` and add it to `opened`.

`render()` calls `hints?.close()` at its start, so a bubble never survives a navigation.
`toHint` maps an entry to `{ id, element: el, popover: { title, description: text, side, align: 'start', buttonText: 'Got it' } }`.
`onDismiss` adds the id to `done` and saves.

**Also dismiss on use:** a delegated `click` on `document` (capture phase) that
finds an open tip whose element contains the target calls `hints.dismiss(id)`.
Using the feature is proof the tip worked.

**Sidebar switch**, after the Ground group, identical markup and styles:

```html
<div class="side__group">
  <p class="side__label">Tips</p>
  <div class="ground" role="group" aria-label="Feature tips">
    <button type="button" data-tips="on" aria-pressed="true">on</button>
    <button type="button" data-tips="off" aria-pressed="false">off</button>
  </div>
</div>
```

`off` sets `off: true` and hides everything. `on` sets `off: false` and clears
`done` and `opened`, then `TIP.sync()`.

### 1d. Look

Override Driver.js styles in the page's `<style>` with role tokens only. Never a
hex or a `--vd-*` step. The vendor CSS stays unmodified.

| Part | Rule |
|---|---|
| Bubble (`.driver-popover.driver-hint-popover`) | `background: var(--spot)`, `color: var(--spot-ink)`, `border-radius: 0`, `box-shadow: var(--shadow-lg)` (floats), `max-width: 320px`, `padding: 14px 16px` |
| Title | Hidden visually (`.driver-popover-title` → visually-hidden class); it exists for the beacon's name |
| Text | Inter 14px / 1.45, `--spot-ink`; prefix **Tip:** in weight 600, like the screenshot |
| Icon | 18px Lucide `lightbulb` stroke 1.8 in `--spot-ink`, left of the text, gap 12px, injected in `onPopoverRender` |
| Close `×` | 24×24 hit area, `--spot-ink`, focus ring `box-shadow: inset 0 0 0 2px var(--spot-ink)` |
| Got it | Text button, mono 12px, `--spot-ink`, underline on hover/focus, right-aligned under the text |
| Arrow | Same `--spot` fill as the bubble |
| Beacon | `--driver-hint-color: var(--spot)`; 14px; the pulse animation off under `prefers-reduced-motion` (the existing rule already kills it) |
| Open / close | 160 ms opacity, `--ease`; instant under reduced motion |
| ≤ 560 px | `max-width: calc(100vw - 32px)`; Driver.js flips the side to fit |

Check both grounds: `--spot` is `--vd-300` on ink and `--vd-700` on paper, and
`--spot-ink` is defined as the text colour on a `--spot` fill. If the paper
contrast of `--spot-ink` on `--spot` is under 4.5:1, use `--panel` / `--ink`
with a 3px `--spot` left rule instead, and note it in the PR.

### Tests (Stage 1, `dashboard-browser.test.ts`, new `describe('tips')`)

Use one test-only tip injected with `page.addInitScript` (`window.__eklavyaTestTips`
replaces `TIPS` when set) so Stage 1 is testable before Stage 2's content.

- Fresh storage, Learning → Dashboard: after the bubble opens, it is visible, its
  text matches, and there is one beacon per eligible tip.
- **Got it**: bubble and beacon gone; storage `done` has the id; reload: not shown.
- `×` / Escape: bubble gone, beacon stays; reload: no automatic open (already `opened`), beacon still there.
- Clicking the feature itself dismisses the tip.
- Navigating while a bubble is open closes it; at most one bubble exists at any time.
- Tips switch `off`: no beacons on any page; `on`: the first tip opens again.
- `localStorage.getItem` throws: no beacons, no console error.
- No bubble while the correction dialog or the drawer is open.
- At 560 px the bubble's rect is within `[8, innerWidth - 8]`.
- The existing outbound-request and console-error checks pass on every page with tips on.
- `dashboard.test.ts`: both vendor routes answer 200 with the right type and `SECURITY_HEADERS`.

## Stage 2 — The starter tips

Selectors below were read from the current code. Each is a real element on that screen.

| id | where | el | title | text |
|---|---|---|---|---|
| `wf-switch` | `learning/dashboard` | `#wf-caret` | Switch workflow | Eklavya has four workflows: Learning, Memory, Artifacts and Settings. Switch between them here. |
| `how-this-works` | `learning/dashboard`, `memory/dashboard` | `#view details.about > summary` | How this works | Every page explains where its numbers come from. Open this to read it. |
| `project-scope` | `learning/sessions`, `memory/timeline` | `#proj` | Project scope | Pick a project to narrow every page to its activity. Your scores stay the same everywhere. |
| `concept-filters` | `learning/concepts` | `#chips` | Concept filters | Filter concepts by state. The filter is part of the link, so you can bookmark it. |
| `review-tabs` | `learning/review` | `#tabs` | Review lists | Due, missed and skipped answers each have their own list here. |
| `timeline-open` | `memory/timeline` | `#view .tl-item > summary` | Open an entry | Open a line to read what was remembered and the evidence it came from. |
| `to-correct` | `artifacts/dashboard` | `#view .chips [data-go*="to-correct"]` | Answers to correct | Missed answers wait here. Open one, read the page, then correct your answer. `when: some artifact has correction === 'open'` |
| `artifact-tabs` | `artifacts/view` | `#view [role="tablist"]` | Open pages | Pages you open stay here as tabs, up to eight. All artifacts takes you back. |
| `settings-scope` | `settings/dashboard` | `#nav` | User or project | User settings apply everywhere. Project settings override them for one project. |
| `ground` | `settings/dashboard` | `.ground[aria-label="Colour ground"]` | Ink or paper | Switch the dashboard between a dark and a light ground. |

The implementer verifies each selector against the fixture and corrects it if the
markup differs; the guard test below makes a wrong one fail.

**Guard test** (`dashboard-browser.test.ts`, the one that makes "keep adding"
safe): for each entry in `TIPS`, read from the page with `page.evaluate(() => TIPS)`:

- id format, uniqueness, `title` ≤ 32 and `text` ≤ 140 characters;
- every `where` exists in `WORKFLOWS`;
- with fresh storage and the fixture loaded, navigating to each `where` and
  waiting for `data-rendered` (and any `aria-busy` fill to clear) makes `el`
  resolve to a rendered element, unless the entry has `when` and `when()` is false.

A new tip is one array row; a typo in its selector fails this test.

## Strings

| Where | String |
|---|---|
| Sidebar label | Tips |
| Switch group label | Feature tips |
| Switch buttons | on / off |
| Bubble prefix | Tip: |
| Bubble button | Got it |
| Close label | Close (Driver.js default) |
| Tip titles and texts | the Stage 2 table |

## Data and migrations

None. No migration, no config key, no `/api/state` change. Two new routes
(`/vendor/driver-hints.js`, `/vendor/driver-hints.css`), one devDependency,
one per-viewer storage key `eklavya-dash-tips`.

## Tests the gate expects

- Server: vendor routes, types, headers; build fails without the vendor files (`dashboard.test.ts`).
- Browser: engine behaviour (open once, dismiss, close keeps beacon, use dismisses, off/on, storage throws, dialog/drawer, 560 px, no outbound) and the registry guard (`dashboard-browser.test.ts`).
- `npm run coverage` at 100%.

## Acceptance

Build, then run against a temp home seeded by the test fixture, or against your
own data in a **private browser window** (fresh storage; tips write nothing to the database):

```bash
cd mcp && npm run build && node dist/cli.js dashboard --port 41799 --no-open
```

1. Open `http://127.0.0.1:41799/`. Within a second a verdigris bubble points at
   the workflow switcher; a dot also marks "How this works".
2. Press Escape: the bubble closes, the dot stays. Reload: no bubble opens by itself, the dot is still there. Click the dot: the bubble opens.
3. Click **Got it**: bubble and dot are gone. Reload: still gone.
4. Visit Concepts, Review, Timeline, Artifacts, an open artifact and Settings:
   each shows its tip once; never two bubbles at once.
5. Click the filter chips while their tip is open: the tip goes away for good.
6. Sidebar → Tips → off: no dots anywhere. On: the first tip opens again.
7. Open the correction dialog on a correctable page: no bubble appears over it.
8. Narrow to 560 px and open the drawer: no bubble; close it: the bubble fits on screen.
9. Keyboard only: Tab reaches a beacon, Enter opens it, Tab reaches **Got it**.
10. DevTools Network: no request leaves `127.0.0.1`.
11. Check at 1280, 900 and 560 px in both grounds.

## Docs to update in the same PR

- Manual `dashboard`: a **Tips** section (what the dots and bubbles are, Got it vs
  close, the sidebar switch, per browser), and add **Tips** to "Projects, scope,
  ground and paging".
- Manual `your-data`: tips state lives only in this browser's storage, nothing is sent anywhere.
- Landing `#dashboard` block (`web/public/index.html`): one sentence, "First visits point out each feature with a tip you can dismiss or switch off."
- `README.md`: one line in the dashboard paragraph (line ~95).
- `mcp/README.md`: the dashboard paragraph lists the two vendor routes are served locally.
- `.claude/skills/eklavya-dashboard/SKILL.md`: replace "Two files, and there is
  deliberately nothing else" with the vendored exception (one pinned library,
  copied at build, served from this origin); add an **Adding a tip** section
  (the entry fields, the id rule, the guard test); add the routes to the route list.
- `mcp/CLAUDE.md` "Dashboard and artifacts" row: mention `vendor/` is copied from `node_modules` at build.

## Decisions taken for the user (change here if wrong)

1. **Driver.js `hints`, vendored at build and served by the dashboard.** It covers placement, arrows, beacons, Escape and reposition; we write the list and the memory (~70 lines). Cost: its `hints` module is one day old, mitigated by the exact pin and the Stage 1 spike with a same-package fallback. Rejected: Shepherd and Intro (AGPL), Floating UI (positioning only), Tippy (unmaintained), a CDN (breaks the no-outbound promise).
2. **The list lives in code (`TIPS` in `dashboard.html`), not in config or a user-editable file.** "Configurable" here means one place maintainers add rows to, guarded by a test. Cost: adding a tip needs a release. Making learners author tips has no stated need.
3. **Beacons plus one automatic bubble per tip, ever.** Rejected: opening every tip as a bubble each visit until dismissed (nags), a one-time guided tour (users skip it, and it can't reach pages they haven't opened), tooltips on hover only (nobody discovers them).
4. **Per-browser state in `localStorage`, no config key.** Matches Ground and tabs. Cost: a second browser or a changed `--port` shows the tips again. A config key would need the CLI, Settings registry and `set_config` in the same PR for a display preference.
5. **Existing users see the tips too.** They have not seen these explanations either. Cost: one bubble per page for them after upgrading; the sidebar switch turns them off.
6. **Storage that throws means no tips.** Better silent than a bubble on every load.
7. **Using the feature dismisses its tip.** Cost: someone who clicked by accident loses the tip; the sidebar switch brings all back.
8. **Square bubble, not the screenshot's rounded one.** The design system makes chrome square; `--radius-*` is for data marks only.
9. **No link to the online manual from a tip.** The page has no outbound links today; a tip explains in place.
