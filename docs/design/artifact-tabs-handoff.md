# Artifact tabs and the correction bar — design handoff

- **Base:** `main` @ `0d3c487` (1.46.0, includes the explainer reattempt from #98)
- **Branch:** `feat/artifact-tabs`
- **Previous brief:** `docs/design/explainer-reattempt-handoff.md` (on the
  `feat/explainer-reattempt` branch; merged as `919de4e`)
- **Design source:** this brief; visual rules from `.claude/skills/eklavya-design/SKILL.md`
  and `.claude/skills/eklavya-dashboard/SKILL.md`. No Figma.

## Agent preamble

Follow the root `CLAUDE.md` and `mcp/CLAUDE.md`; read `web/CLAUDE.md` before
the docs stage. Load `eklavya-dashboard` and `eklavya-design` before any UI
work and `verify-docs` before opening the PR. Tests use a temporary
`EKLAVYA_HOME` / `EKLAVYA_DB` and `EKLAVYA_DASHBOARD_PORT`, never the real ones.
Preserve everything the reattempt brief established (server grading, sandbox
without `allow-same-origin`, `WRITES` / `acceptWrite`, `postJson`).

## The feedback, verbatim intent

1. In the explainer viewer, both the framed page and the dashboard page scroll.
   The framed page must never scroll; the dashboard page scrolls it all as one document.
2. Redesign the correction bar: button on the **right**, and the bar
   **pinned to the bottom of the screen** so it is always visible while reading.
3. Clicking an artifact in the dashboard opens a new browser tab. Pages opened
   that way have no correction bar, so a pending one cannot be corrected.
   Every artifact should open **inside the dashboard**.
4. The dashboard gets **tabs**: open artifacts stay open as tabs you can switch between and close.

## What the investigation found

| Fact | Where | Status |
|---|---|---|
| The viewer sizes the frame from an `eklavya:height` message sent by a script **inside the agent's page**, which only `artifact-template.html` from 1.46.0 contains. With no message, the frame stays `height:80vh` and scrolls on its own: the double scroll. | `.viewer` `dashboard.html:272`; message listener `dashboard.html:2730`; sender `artifact-template.html:180-195` | **Verified** for pages written before 1.46.0 (no script). Today only correctable pages reach the viewer, and they all have the script; item 3 sends *every* page there, so 32 of the learner's 40 pages would double-scroll. |
| For a page that has the script, Chrome sizes the frame exactly (frame 3848 px tall, framed document 3848 px, no inner overflow at 1280, 900 and 560 px, measured on the live 1.46.0 dashboard). | Playwright, `127.0.0.1:41729` | **Verified** in Chrome. |
| The learner's default browser is Comet (Chromium). A double scroll on a page that *has* the script is **not reproduced**. | `LSHandlerRoleAll = ai.perplexity.comet` | **Hypothesis:** (a) the 80vh frame scrolls on its own until the first message arrives; (b) the frame never shrinks, because `documentElement.scrollHeight` can't drop below the frame's own height, so the report goes stale after a resize; (c) the frame has no `scrolling="no"`, so any 1 px rounding gives it a scrollbar. Stage 1 fixes all three at once. To confirm before the fix, open a 1.46 explainer in Comet, run `document.getElementById('art-frame').style.height` in the console, and compare it with the frame's visible height. |
| The height script lives in agent-written files, so fixing it in the template fixes no page already on disk. The server already rewrites every `?embed` response (`withoutWebFonts`). | `dashboard.ts:1455`, `dashboard.ts:1704` | Verified. Putting the script in on the server is the one place every framed page passes through. |
| Gallery cards: correctable explainers link to `#/artifacts/view/<id>`; **every other page** links to the raw `/artifacts/<id>` with `target="_blank"`. | `artifactCard` `dashboard.html:2541-2558` | Verified: this is item 3. |
| The viewer is a full `render()`: switching pages rebuilds `#view`, which reloads the frame and drops the scroll position. | `render` `dashboard.html:3680-3700` | Verified. Tabs need to remember scroll per page. |
| `render()` disarms the leave prompt and the viewer re-arms it from `fixBar`. | `dashboard.html:3690`, `fixBar` | Verified. Keep that rule with tabs: armed only while the **visible** tab has an open correction. |
| `eklavya artifacts open` sends only correctable pages to the viewer; the rest open as files. | `artifactsCommand` `mcp/src/cli.ts` (`open` branch) | Verified. Change it to match item 3. |

## Delivery order

One PR. After every stage, from `mcp/`:

```bash
npm run build
npm test
npm run coverage
```

100% on every metric. Stage 4 also runs `npm run build` in `web/` and `/verify-docs`.

1. `fix:` One scroll: the server adds the frame script to every embed; the frame never scrolls.
2. `feat:` The pinned correction bar.
3. `feat:` Artifact tabs; every artifact opens in the dashboard; CLI `open` follows.
4. `docs:` Manual, landing, READMEs, skills.

## Stage 1 — One scroll (fix)

**Failing test first:** in `dashboard-browser.test.ts`, write a page *without* the
template script (plain `<html><body><p>…</p>×200</body></html>`) into the temp
artifacts folder and open `#/artifacts/view/<id>`. Assert that the frame's
`clientHeight` equals the framed document's height, and that the framed
document's `scrollHeight <= clientHeight`. It fails today (80vh).

Fix at the server, the layer every framed page passes through:

- `dashboard.ts`: `embedHtml(html)` = `withoutWebFonts(html)`, plus `EMBED_SCRIPT`
  added just before the last `</body>` (appended to the end when there is no `</body>`).
  `/artifacts/<id>?embed` serves `embedHtml(...)`. Raw (non-embed) responses
  are unchanged.
- `embedHtml` first **removes** the 1.46 template copy: any `<script>…</script>`
  whose body contains `eklavya:height`. If both ran, the old copy's
  `documentElement.scrollHeight` (which can't shrink) would race the new
  height. Test it with the exact block from the 1.46 template.
- `EMBED_SCRIPT` is one inline `<script>`, at most 25 lines, guarded by
  `if (parent === window || window.__eklavyaEmbed) return; window.__eklavyaEmbed = 1;`.
  - Adds a `<style>`: `html,body{overflow:hidden !important}` (overflow-y only; leave x alone so wide `pre` keeps its own inner horizontal scroll).
  - Height = `Math.ceil(document.body.getBoundingClientRect().bottom + parseFloat(getComputedStyle(document.body).marginBottom))`, which *can* shrink, unlike `scrollHeight`.
  - Posts `{type:'eklavya:height', h}` on `DOMContentLoaded`, `load`, every
    `ResizeObserver` callback on `document.body`, and after `document.fonts.ready`.
    Coalesce with `requestAnimationFrame`; skip a post when `h` did not change.
  - Takes over the template's `eklavya:mode` listener (same rules: only from `parent`, only `ink|paper`).
- `CSP`: the injected script is inline, which `ARTIFACT_EMBED_CSP` already allows (`script-src 'unsafe-inline'`). No CSP change.
- Delete the frame script from `artifact-template.html` (lines ~180-195) and the
  `.framed main{min-height:0}` rule's dependency on it: the injected script adds
  `framed` to `<html>` instead. A downloaded or `file://` page no longer carries frame code it never uses.
- `dashboard.html`:
  - `<iframe … scrolling="no">`.
  - `.viewer { height: 0 }` until the first message; keep a **1500 ms** fallback
    to `80vh` with internal scroll, only if no message ever arrives (script blocked).
    Show `loader('Opening the page…')` in place until then, so there's no 80vh flash.
  - The clamp stays `[200, 20000]`. Above 20000 px the frame scrolls internally. That limit is deliberate; note it in a comment.

Tests: `dashboard.test.ts`: the `?embed` body contains `EMBED_SCRIPT` exactly once, before `</body>`; with no `</body>` it is appended at the end; a non-embed response doesn't contain it. Browser test above passes; a second browser test resizes 1280 → 560 → 1280 and asserts the frame height drops back (the shrink case).

## Stage 2 — The pinned correction bar

Replace the `.fixbar` block (`dashboard.html:270-281`) and `fixBar()`.

**Placement:** directly after the frame, in flow, `position: sticky; bottom: 0; z-index: 5`.
While reading, it sits on the bottom edge of the window. At the end of the
page it rests right below the content, so the last lines are never covered.

**Shape (all widths ≥ 561 px):** one row, `min-height: 64px`,
`padding: 12px var(--space-5)`, `background: var(--panel)`,
`border-top: 1px solid var(--line-2)`, no shadow, square, full width of `#view`.
`display:flex; align-items:center; justify-content:space-between; gap:var(--space-4)`.

| State | Left (text) | Right |
|---|---|---|
| `open` | Line 1, `--ink` 14px: **You missed this one.** Line 2, `--dim` 13px: **Read it, then correct your answer. Not now? It stays under To correct.** | Primary `.btn` **Correct your answer** |
| `done` | `--spot` check icon + **Corrected on try {n}** · `--dim` date | Nothing |
| loading | `loader('Loading the question…')` inline, 64px tall so nothing jumps | Nothing |
| error (GET failed) | `--warning` text: the server's message | Ghost button **Retry** that refetches |

- A 3px `--warning` left rule on `open`, 3px `--spot` on `done`. That's the only colour signal besides the text.
- **≤ 560 px:** line 2 is hidden; the button stays on the right with `padding: 10px 12px`; text truncates with an ellipsis, never wraps under the button.
- `done` keeps the bar pinned. It is short and says the page is finished. Item 2 says "always visible".
- When the modal closes on a correct answer, the bar switches to `done` with a 180 ms opacity crossfade (`prefers-reduced-motion`: instant).
- `role="region"`, `aria-label="Correction"`. The button keeps `id="fix-open"`, so the existing modal code and tests keep working.
- Non-correctable pages get no bar at all.

Tests: browser test at 1280 and 560: the bar's `getBoundingClientRect().bottom === innerHeight` while scrolled to the top; at the bottom of the page, the bar's top `>=` the frame's bottom (no overlap); the button's right edge is within 24 px of the bar's right edge.

## Stage 3 — Artifact tabs

### What a tab is

A tab is an open artifact. Each tab shows the page's title, a status dot and a close button. The tab strip lives only in the
Artifacts workflow, directly under the crumb row and above the viewer. The
Artifacts gallery (`#/artifacts/dashboard`) is always the first, fixed tab,
labelled **All artifacts**, with no close button.

| Rule | Value |
|---|---|
| Opening | Any artifact card, any link to `#/artifacts/view/<id>`, `eklavya artifacts open`. Opening a page that's already open just switches to its tab. |
| Order | New tabs go to the right of the active tab. |
| Limit | **8** artifact tabs. A 9th closes the least recently viewed tab that has no open correction; if all 8 have one, the oldest goes. |
| Active | The URL is the authority: `#/artifacts/view/<id>` is the active tab. Back/forward walk tab switches, like any route. |
| Persistence | The tab list (ids, in order) is per-viewer convenience: `localStorage['eklavya-dash-tabs']`, read and written in `try/catch`, as the existing `eklavya-dash-project` key is. It never goes in the URL and never on the server. A deleted page drops out of the list on the next load. |
| Close | `×` on the tab, middle-click, or `Ctrl/Cmd+W` is **not** used (it belongs to the browser). Closing the active tab activates its right neighbour, else its left, else All artifacts. Closing a tab whose correction is open is allowed and doesn't prompt; the item stays under the To correct chip. |
| Scroll | Remember `scrollY` per tab in memory (a `Map`, not storage). Restore it after the tab's first `eklavya:height` message. |
| Leaving | Unchanged rule: `beforeunload` is armed only while the **visible** tab has an open correction. |

### Tab strip shape

- One row, `height: 40px`, `border-bottom: 1px solid var(--line-2)`, scrolls
  horizontally when it overflows (`overflow-x:auto`, no visible scrollbar on hover-less devices), with no wrapping.
- Tab: `max-width: 220px`, `padding: 0 var(--space-3)`, mono 12px, title truncated
  with an ellipsis; full title in `title=`. Status dot 6px before the title:
  `--warning` for `open`, `--spot` for `done`, none otherwise.
- Active tab: `--ink` text, 2px `--spot` bottom border. Inactive: `--dim`, hover `--ink`.
- Close `×`: a 20×20 hit area, always visible on the active tab, on hover/focus on the others. It's a real `<button aria-label="Close {title}">`.
- Pinned to the top of the window while you scroll (`position: sticky; top: 0` below the top bar on narrow layouts), so switching never needs scrolling up.

### Accessibility and keyboard

`role="tablist"`; each tab is `role="tab"` with `aria-selected` and
`aria-controls="view"`; roving `tabindex`. ←/→ move focus, Home/End jump to the
first/last tab, Enter/Space activate, Delete closes the focused tab.

### Every artifact opens here

- `artifactCard`: every card links to `AH('view', a.id)`. Delete the
  `target="_blank"` branch and its comment.
- The viewer gets a small toolbar row above the frame, on the right: **Open in new
  browser tab** (`↗`, a link to the raw `/artifacts/<id>`, `target="_blank" rel="noopener"`) for anyone who wants the page on its own. The page's own PDF/HTML buttons stay inside the frame.
- Replace the `page__back` link "← Artifacts" in `viewArtifact` with the tab strip (All artifacts is the way back).
- `eklavya artifacts open <path|id>` (`cli.ts`): open **every** artifact in the
  dashboard viewer when `ensureDashboard()` returns `running|started|replaced`; fall back to the file otherwise. Delete the "only pages with `eklavya:attempt`" condition.

### Code shape

- One module-level `TABS` object in `dashboard.html`: `{ ids, load(), save(), open(id), close(id), touch(id) }`. Around 60 lines. No class, no framework.
- `drawTabs()` returns the strip's HTML; `viewArtifact` and `viewArtifacts` put it at the top. Clicks and keys use one delegated listener on `#view`, like the existing `fix-open` listener.
- The strip draws from `S.artifacts`, so status dots match the gallery tags and update when a correction lands (`row.correction = 'done'` already exists in `pickFix`).

Tests (`dashboard-browser.test.ts`): opening three cards gives four tabs in
order; reopening one doesn't duplicate it; closing the active tab activates its
right neighbour; the 9th open evicts the least recently viewed tab without an
open correction; reload restores the tabs from storage; storage that throws
still renders (stub `localStorage.getItem` to throw); keyboard ←/→/Delete;
no card in the gallery carries `target="_blank"`; scroll position comes back after switching tabs. `cli.test.ts`: `open` on a page with no attempt meta now goes to the viewer URL when the dashboard answers, and to the file when it doesn't.

## Strings

| Where | String |
|---|---|
| Fixed first tab | All artifacts |
| Tab close label | Close {title} |
| Bar, open, line 1 | You missed this one. |
| Bar, open, line 2 | Read it, then correct your answer. Not now? It stays under To correct. |
| Bar button | Correct your answer (unchanged) |
| Bar, done | Corrected on try {n} (unchanged) |
| Bar, error button | Retry |
| Viewer toolbar | Open in new browser tab |
| Frame loader | Opening the page… |

Removed: the "Not now? Correct it later from Dashboard → Artifacts." note, and the "← Artifacts" back link in the viewer.

## Data and migrations

None. No migration, no config key, no new route. One new per-viewer storage key, `eklavya-dash-tabs`.

## Tests the gate expects

- Server: embed injection, once, positions, non-embed untouched (`dashboard.test.ts`).
- Browser: single scroll for a page without the template script; shrink on resize; pinned bar geometry at 1280/560; tabs open/dedupe/close/evict/restore/keyboard/scroll memory; no `target="_blank"` cards (`dashboard-browser.test.ts`).
- CLI: `open` routes every artifact to the viewer, with the file fallback (`cli.test.ts`).
- Template: no frame script left in `artifact-template.html` (`artifacts.test.ts`).
- `npm run coverage` at 100%.

## Acceptance

Run with `EKLAVYA_HOME=$(mktemp -d)`, copy in two explainers written before
1.46 and one correctable explainer (make it with the live loop in
`CONTRIBUTING.md`), then `node mcp/dist/cli.js dashboard`.

1. Open an explainer written before 1.46: one scrollbar (the window's). Scrolling with the wheel over the frame scrolls the page smoothly to the end.
2. Resize the window from 1280 to 560 and back: no gap or second scrollbar appears below the page.
3. Open the correctable one: the bar sits on the bottom edge while you read, with the button on the right. At the end of the page the bar sits under the content and covers nothing.
4. Correct it: the bar turns into "Corrected on try N" without jumping; its tab's dot turns verdigris.
5. From the gallery, open three artifacts: four tabs, none in a new browser tab. Reopen one: no duplicate tab.
6. Scroll halfway down tab 2, switch to tab 3 and back: you're back halfway down.
7. Close the active tab with its ×: the right neighbour opens. Reload the browser: the same tabs come back.
8. Open nine artifacts: the oldest-viewed tab without an open correction closes.
9. Use only the keyboard: Tab into the strip, ←/→, Enter, Delete.
10. `eklavya artifacts open <a page without a question>` opens it as a dashboard tab.
11. In Comet (the learner's browser), repeat 1 and 3.
12. Check the strip, bar and viewer at 1280, 900 and 560 px in both themes.

## Docs to update in the same PR

- Manual `dashboard`: tabs, all artifacts open inside the dashboard, the pinned bar, "Open in new browser tab".
- Manual `commands` and `cli`: `eklavya artifacts open` opens every artifact in the dashboard when it's running.
- `user-skill/eklavya-artifacts/SKILL.md` and `agents/explainer.md`: the template no longer carries frame code; don't add any.
- Landing page: if it says artifacts "open in a new tab", fix that sentence; otherwise add one source-backed sentence on dashboard tabs where artifacts are described.
- `README.md` / `mcp/README.md`: only where they describe how artifacts open.
- `mcp/CLAUDE.md` "Memory and local pages": the server adds the frame script to embedded pages, so agent-written pages carry no frame code.

## Decisions taken for the user (change here if wrong)

1. **The fix lives in the server, not the template.** Every page on disk, old or new, gets the same frame script when shown in the dashboard. Cost: the server edits agent HTML on the way out. It already does that for fonts.
2. **Bar pinned to the bottom (sticky), button on the right, both states stay visible.** Rejected: a floating button in the corner (covers content, and hides the reason to correct); showing the bar only at the end of the page (what you said you didn't want); a top banner (competes with the tab strip).
3. **Tabs only inside Artifacts.** Learning, Memory and Settings stay single pages. Cost: none today. Make tabs dashboard-wide only if you ask.
4. **Tabs are an in-dashboard strip with a fixed "All artifacts" first tab.** Rejected: browser tabs (they lose the bar, which was the original problem); a side panel next to the gallery (too narrow for the page at 900 px); a single viewer with no history (you asked for tabs).
5. **Limit 8 tabs, least-recently-viewed eviction that spares open corrections.** Cost: a 9th page silently closes one tab. It can always be reopened from the gallery.
6. **Tabs persist per browser in `localStorage`, not in the URL.** The URL still names the active page, so links stay shareable. Cost: another browser starts with no tabs open.
7. **Closing a tab with an open correction doesn't prompt.** The leave prompt is for leaving the dashboard. Closing a tab keeps the page under To correct.
8. **`eklavya artifacts open` sends every artifact to the dashboard.** Cost: needs the dashboard running; it falls back to the file when it can't start.
9. **Pages taller than 20000 px still scroll inside the frame.** Rare. Raising the limit costs memory for one giant frame.
