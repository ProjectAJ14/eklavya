---
name: eklavya-dashboard
description: How Eklavya's dashboard (`eklavya dashboard`) is built and how to change it — the two workflows (Learning, Memory) and their registry, the one JSON payload plus the project inventory, the URL-driven hash router and its legacy redirects, the hand-rolled SVG charts, the table/pagination helpers, and the checks a change has to pass. Use whenever adding, editing or debugging anything in mcp/src/dashboard.ts or mcp/src/assets/dashboard.html, or when a request mentions the dashboard's sections, charts, filters, drill-downs or routes.
---

# Working on the dashboard

`eklavya dashboard` serves the learning and memory history as a local web page.
It is the long view — `/eklavya:progress` gets twenty lines and answers *what
now*, this answers *am I getting better* and *what did that session actually
teach me*. It is two workflows in one shell, **Learning** and **Memory**, each
with its own Dashboard and sidebar.

Two files, and there is deliberately nothing else:

| File | What it is |
|---|---|
| `mcp/src/dashboard.ts` | `dashboardState(db)` — the whole payload — `projectInventory(db)`, the one list of projects both workflows use, `memoryPage`, `memoryEntry` and `memorySessionPage` for the paged memory resources, `localTokens` (the shared tokens minus their remote font import), and `startDashboard`, a loopback `http.createServer` with seven read-only routes: `/api/state`, `/api/projects`, `/api/memory`, `/api/memory/entry`, `/api/memory/sessions`, `/tokens.css`, `/`. |
| `mcp/src/assets/dashboard.html` | The entire client: styles, markup shell, workflow registry, router, views, charts. One file, no framework, no build step. |
| `mcp/test/dashboard.test.ts` | The payload's contract, the inventory's rules, and `/api/state`'s key set. |
| `mcp/test/dashboard-browser.test.ts` | The page in a real Chromium: every legacy redirect, the workflow control, collapse persistence, the drawer, picker bounds, overflow, console errors and outbound requests. |
| `mcp/test/dashboard-fixture.ts` | One synthetic learner with every project shape — memory-only, logged-but-unanswered, answered-only, mixed, worktrees (one deleted), same-named repos, a gone checkout, no-repository and legacy rows. Both suites and the screenshots use it. |
| `web/src/content/docs/docs/dashboard.mdx` | The manual page. It is a **test of this code**, not prose about it. |

`web/public/tokens.css` is copied into `dist/assets/` by `mcp/scripts/copy-assets.mjs`
and served at `/tokens.css`. The dashboard and the site therefore share one
palette by construction; do not fork it. The site's copy imports Google Fonts;
`localTokens` strips that import on the way out, and the page itself loads no
font — **the dashboard makes no request to any other host**, and the browser
suite fails if it does. The font stacks fall through to system faces.

When iterating: `npm run build` in `mcp/` (tsc + copy-assets), then
`node dist/cli.js dashboard --port 41799 --no-open`. **Use `--no-open`** — the
command opens the reader's browser by default, and a restart loop without it
spawns a tab every time. Editing only the HTML? `cp src/assets/dashboard.html
dist/assets/` and reload — no rebuild needed.

## The one rule about data

**One payload of mostly flat rows. The page derives the views.**

`/api/state` ships every attempt, every logged context line, one row per day for
365 days, the whole concept catalogue with its SM-2 state and graph edges, and
per-project level standing. The sessions list, the streak, the heatmap, the
forecast and one concept's question history are five readings of the same rows.

So: **do not add an endpoint or a SQL aggregate per card.** A query shaped like a
card is a query that has to change when the card moves. Aggregate in SQL only for
what the page cannot honestly derive — all-time totals, which must stay right
even though `attempts` is capped at `ATTEMPT_LIMIT` rows.

**Two exceptions, and both are resources, not cards.**

The first is `/api/projects`: the project inventory. `projects` in `/api/state`
is built from `attempts` and so cannot see a project that logged concepts but was
never asked a question, or one that only captured memory; the page's selector and
both Projects pages read the inventory instead. It establishes a project from any
row that names one (attempts, logged concepts through their gate, evidence —
processed or not — entries, receipts, `project_levels`), folds identities with
`projectKey`, and ships `aliases` (every raw spelling → one id) and `sessions`
(no-repository sessions proven by their own rows). The page's `pid(raw, sid)` is
the only place a row is given a project — call it, never compare `repo` strings.
Never discover projects from a capped array or a page of the timeline.

The second is the memory corpus. An
observation carries a narrative and the tool output it was distilled from, so a
year of them is megabytes and shipping it on every load is what PRD DASH-02
forbids. `/api/memory` is one paged, filtered endpoint over `memory_entries`
(`project`, `session`, `type`, `tag`, `q`, `since`, `until`, `page`, `per`) and
`/api/memory/entry?id=` is one observation with its tags, its raw evidence, its
candidates and its receipts. Both are *resources* — a filter added to them is a
parameter, never a second endpoint. Everything else about memory (the counts, the
facets, the receipts ledger, the health block) still rides in `/api/state`.

`/api/memory/sessions` is the same kind of resource over sessions that captured
or remembered anything, with a real total, because `memory_sessions` in the state
payload stops at `MEMORY_SESSION_LIMIT`.

The asynchronous views — the timeline, an entry, the Memory Dashboard's two
lists, Memory Sessions, the memory half of a session, and a session looked up
because it is not in the payload — go through `fill(id, url, draw)`, which queues
on `AFTER` exactly as `chart()` does. Each render bumps `GEN`, and a response
from an older render is dropped, so a late fetch can never paint one workflow's
content over the other's. A `draw` may queue its own charts and fills; `fill`
runs them. Otherwise `draw` is a pure function of the response; keep it that way.

**`/api/state` is append-only.** Add keys; never rename or remove one.

| Key | Shape |
|---|---|
| `config` | `quiz_enabled`, `quiz_enforced`, `focus`, `focus_topic`, `cadence`, `difficulty`, plus the thresholds the Projects page reports against. The two `quiz_*` booleans replaced a single `mode` string — the dial line renders `enforced` only when set, and `questions off` when `quiz_enabled` is false |
| `totals` | all-time answers/passed/missed/skipped, mastered, due, touched, catalogue, sessions, active days |
| `daily` | `{day, repo, passed, missed, skipped}`, one row per day **per project**, 365 days |
| `projects` | answers, accuracy, concepts, first/last active, plus `levelStanding` — level, next, counts, needed, unmet |
| `domains` | catalogue / touched / mastered / learning / unseen |
| `concepts` | the whole catalogue: `seen`, decayed `score` and `stored_score`, ease, interval, reps, `due`, `overdue_days`, last context, `prereqs` / `unlocks` / `related` as slugs |
| `attempts` | newest `ATTEMPT_LIMIT`: question, options JSON, answer, feedback, grade, tier, outcome, format, repo, level, session id |
| `logged` | every `session_concepts` row: slug, context, origin, ts, session id, repo |
| `memory` | counts, not rows: captured / processed / indexed / reused / exposed / assessed, entries live vs superseded vs deleted, candidate statuses, and the type / tag / project facets the filters are built from |
| `reuse` | `receiptTotals` (confirmed rows only), the `savingsFrom` verdict and `savingsLine`, the estimator's name, counts by delivery, and the newest `RECEIPT_LIMIT` receipts with their index/detail split |
| `health` | capture heartbeat and mode, `queueDepth`, stalled jobs grouped by `error_class`, the spool's drop count, and whether a provider is configured |
| `memory_sessions` | one row per session that captured evidence: events, entries, candidates, first/last — what lets the Sessions view line the two halves up |

Two things that have bitten this file already:

- **Timestamps come in two shapes.** `attempts.ts` is SQLite's `2026-09-05
  21:04:00` — UTC with no marker, which `Date.parse` reads as *local*. `next_review`
  and `last_seen` are JS ISO strings that already carry a `Z`. Both ends have a
  parser that handles both (`parseTs` in `dashboard.ts`, `parse()` in the page).
  Appending `Z` unconditionally gives `...ZZ` → `NaN`, and every overdue count
  silently reads zero. Never write a third parser.
- **Scores are decayed at read time**, exactly as `get_learner_profile` does it
  (`decayedScore`, `isKnown`, `isDue` from `srs.ts`). Two surfaces disagreeing
  about one score is worse than either being wrong. Import from `srs.ts`; never
  re-implement the arithmetic in the page.

## Workflows, routes and adding a view

`WORKFLOWS` is the registry: per workflow, its `name`, its sidebar `groups`
(`{ id, label, items }`), and `pages` — `{ label, view, query }` for a page with a
sidebar entry, `{ parent, view }` for a detail page, which keeps its parent
highlighted. The sidebar, the picker, the resolver and `render()` all read it, so
they cannot disagree. `ICONS` holds the Lucide-style paths.

Canonical routes are `#/<workflow>/<page>/<param>?<query>`. `resolve(hash)` is
pure: it returns the screen, or a `redirect` for a legacy or partial form, or
`missing` / `bad` for an unknown page or undecodable parameter.
`syncFromUrl()` applies a redirect with `history.replaceState` (no extra history
entry), reads `?project=`, and renders. Every navigation lands there.

- **Build links with `href(wf, page, param, query)`** (`LH`, `MH`, `sessHref`).
  It carries the project scope and nothing else unless asked, which is how a
  workflow switch keeps the project and drops screen filters. Never write a
  `#/…` string by hand.
- **A filter worth linking to lives in the URL**: a path segment for the primary
  one (`#/learning/concepts/due`, `#/memory/timeline/bugfix`), a query key for the
  rest (`?domain=`, `?tag=&from=&to=`), listed in the page's `query` so it
  survives a project change. Selects rewrite the query with `setQuery()` (replace);
  chips navigate (push). Search text and sort order stay in `T`.
- **Legacy links are forever.** `LEGACY` maps each pre-workflow route to its
  canonical home; `#/memory` and `#/memory/<type>` are special-cased in
  `resolve()` because canonical Memory pages share the prefix. A new route never
  reuses an old one's meaning.

To add a page: write `viewThing(param)` returning an HTML **string**, add it to
the workflow's `pages`, and to a group's `items` if it deserves a sidebar entry
(with a count in `navCounts` if there is an honest number). Add a row to the
browser suite that loads it directly and checks the highlight. Detail pages start
with `<a class="page__back" data-go="${esc(LH('parent'))}">`.

Collapsed groups are stored per workflow under
`eklavya-dash-nav-collapsed:<workflow>` — only the collapsed ids, so a new group
starts open; unknown ids and malformed JSON are ignored, and storage that throws
means everything is open. A direct link into a collapsed group reopens it.

**The drawer.** At 900px and below the rail is a drawer: `inert` while closed,
`role="dialog"` + `aria-modal` with focus held inside while open, `#main` and the
top bar `inert` behind it. `syncDrawer()` strips every one of those on a wide
screen — the desktop rail must never be hidden from assistive technology. The
workflow picker is `#wf-menu` at the end of `<body>`, outside the rail's scroll
clip, positioned by `placePicker()` and clamped to the viewport.

## Adding a chart

All charts are hand-rolled inline SVG. **No charting library, ever** — the page
must work with no network and no build.

```js
chart('c-thing', (el) => chartThing(el, data));   // queues it until the DOM exists
```

`chart()` pushes into `AFTER`, which `render()` runs after `innerHTML` — a chart
needs a laid-out parent to measure. Inside a chart function:

- Size from `el.parentElement.clientWidth` and set `viewBox` to real pixels, so
  10px axis labels stay 10px. `addEventListener('resize', …)` re-renders the view.
- Fill with role tokens: `var(--spot)` for right, `var(--warning)` for missed,
  `var(--faint-2)` for skipped. Sequential ramps are
  `color-mix(in srgb, var(--spot) N%, var(--mass))` — a `--vd-*` step is legible on
  one ground and invisible on the other.
- Tooltips are `<title>` children unless the chart already owns a `.tip` div.
- **Plot the empty intervals.** `fillDays()` exists because a time axis must
  allocate a slot per day, not per data point: three sessions in a month must not
  close up into three adjacent bars. Gaps are the honest part.

Existing ones to copy from: `chartActivity` (stacked bars + hover tip),
`chartHeatmap` (week columns; picks its *window* from the width and keeps the
cell fixed), `chartForecast` (14 days plus one overdue column), `chartGrades`
(one concept's grades in order), `segbar` (a whole, split — plain HTML).

## Tables, paging and filters

`table(cols, rows)`, `pager(key, total, page, per)`, `page(key, total, per)`,
`slice(arr, p, per)`. `PER` is 20; question histories page at 5. `page()` clamps a
stored page number to a list that shrank under a filter — always route through it
rather than reading `T[key].page` directly.

Per-view control state lives in `T`. A filter the reader would want to **link to**
lives in the hash instead (`#/learning/concepts/due`, `#/learning/review/skipped`, `?tag=`) and is read back
from `param` at the top of the view — the view derives it, the chip only navigates.
Search text and sort order stay in `T`: they are typing, not destinations.

The search box re-renders on every keystroke, so `render({id:'q', pos})` restores
focus and caret. Any future text input needs the same.

## The interaction contract

These are not nice-to-haves; a reader who clicks something that does nothing
stops trusting the page.

- **The wordmark goes home** — to the active workflow's Dashboard. `renderShell()` sets its `href`.
- **Anything that looks clickable is clickable**: a row that has a detail page
  gets `class="row" data-go="…"`, a stat tile whose number *is* a list gets a
  `go` as its fifth `tiles()` field, a concept name is a `.link`.
- **Everything clickable is keyboard-operable.** `focusable()` gives every row
  and every `[data-go]` a `tabIndex` on render (and after each `fill`); Enter and Space are handled by the delegated `keydown` on `#view`;
  focus styles are `--ring` or a `--spot` outline. Never a click handler on an
  element nobody can Tab to.
- **All handlers are delegated** on `#view` — the markup is replaced wholesale on
  every render, so a listener bound to an element is a listener that vanishes.
- Navigation goes through `goTo(hash)`, which re-renders in place when the hash
  is already what we want (clicking the chip you are already on).

## Design

The visual language is `.claude/skills/eklavya-design/SKILL.md`; the token
contract is `web/CLAUDE.md`. The parts this page is strict about:

- **Name a role, never a scale step or a raw hex.** `--ink`, `--dim`, `--faint`,
  `--faint-2`, `--line`, `--line-2`, `--panel`, `--mass`, `--spot`, `--spot-ink`,
  `--warning`. Grep before you ship: a `#hex` or a `--vd-*` in this file is a bug.
- **One rhythm, owned in one place.** `.stack > * + *` is 24px between cards;
  `.head` is 16px from a heading block to its content; `.card` pads 24. Nothing
  sets its own vertical margins — that is how the spacing drifted the last time.
- Archivo for page titles, Inter for body at 14.5px, JetBrains Mono for slugs,
  micro-labels, timestamps and anything terminal-shaped. Square chrome, hairline
  rules, no emoji, sentence case.
- Both grounds are the product. `data-mode` is applied by the head script before
  paint and re-applied on boot (the toggle does not exist yet when the head runs).

## Loopback is not the boundary it looks like

`startDashboard` refuses any request whose `Host` is not a loopback name, and
any cross-origin `Origin` that is not loopback either. Do not remove that check
and do not widen it to "starts with 127.": a page the developer has open can
point a hostname it controls at loopback and fetch from here, and the browser's
same-origin rule does not stop it because the page's origin *is* that hostname.

Two consequences for anything added here. A new endpoint inherits the check
because it sits behind the same handler — keep it that way rather than
registering a second server. And if a mutating endpoint is ever added, this
check is necessary and not sufficient: it would also need a token the page
holds and a hostile origin cannot read.

## Escaping is not optional

Learning rows are written by the tutor. **Memory rows are arbitrary tool output
and developer prose**, and this page is served on loopback from the same origin
as everything else on the machine — one unescaped `${e.title}` is stored XSS.
Every stored string goes through `esc()` on its way into a template, including
inside `data-*` attributes, and `dashboard.test.ts` has a case that scans this
file for a stored field interpolated without it. Raw evidence bodies go in a
`<pre class="raw">`, escaped, capped server-side, and marked when truncated.

## Honesty rules

The page is a record of someone's learning; it does not get to flatter them.

- The catalogue is a **library, not a to-do list**. Untouched concepts are never
  debt, never a percentage-complete, never a nag.
- Say the arithmetic out loud where it decides something: mastery is score ≥ 0.7
  with ≥ 2 reps, decay is ~5%/week overdue, a promotion needs answers **and**
  accuracy **and** distinct concepts.
- Disclose every cap. `attempts_shown < attempts_total` prints a line in the
  footer rather than letting a truncated history look complete.
- Keep the pre-migration rows. A null repo is "recorded before projects were
  tracked" and stays visible; dropping it would shrink every total on the page.
- Scope is *activity*, not mastery: the project selector narrows attempts,
  sessions and the concept list, but a concept you know is a concept you know, so
  scores and review dates never change with it.
- **Captured is not assessed.** Six words for six different things, never one
  "memories" number: evidence can be captured and never processed, an entry
  indexed and never retrieved, retrieved and never delivered, delivered and
  never asked about. Only `assessed` required the developer to answer something.
- **An unconfirmed receipt is never a saving.** `savingsFrom` in
  `memory/tokens.ts` is the only place the percentage is computed and it refuses
  to divide unless the delivery was `confirmed`; the page shows `unknown` and
  `prepared` rows in the ledger with no verdict beside them. Say "estimated
  context volume", never a cost or a bill.
- **Superseded and deleted rows stay visible, marked.** The timeline is the
  audit trail — a correction that erases what it corrected is not one. Strike
  the title as well as labelling it: colour alone is not a marker.

## Before you call it done

```bash
cd mcp && npm test          # builds, then everything — the browser suite included
node dist/cli.js dashboard --port 41799 --no-open
```

1. Every section and both detail levels, at **1280, 900 and 560**, in **both
   grounds**. A bug that only shows on paper is the commonest kind.
2. No console errors, no outbound request, and `scrollWidth <= clientWidth` at 560
   and 390 — `dashboard-browser.test.ts` checks all three on every workflow page;
   add a new page to its list.
3. Click the thing you added, then Tab to it and press Enter.
4. Payload changes get a case in `mcp/test/dashboard.test.ts`.
5. **Docs ship in the same commit** — this is the repo contract, not a follow-up:
   `web/src/content/docs/docs/dashboard.mdx` (sections, routes, page sizes), the
   `#dashboard` block in `web/public/index.html`, and the route table in
   `user-skill/eklavya/SKILL.md` so chat can hand back `#/learning/review` rather than the
   bare root. A new route that nothing documents is a route nobody will find.
