---
name: eklavya-dashboard
description: How Eklavya's dashboard (`eklavya dashboard`) is built and how to change it — the five workflows (Learning, Memory, Artifacts, Feedback, Settings) and their registry, the one JSON payload plus the project inventory, the live event stream and the per-cursor memo behind it, the URL-driven hash router and its legacy redirects, how a redraw keeps the reader's place, the hand-rolled SVG charts, the table/pagination helpers, and the checks a change has to pass. Use whenever adding, editing or debugging anything in mcp/src/dashboard.ts or mcp/src/assets/dashboard.html, or when a request mentions the dashboard's sections, charts, filters, drill-downs or routes.
---

# Working on the dashboard

`eklavya dashboard` serves the learning and memory history as a local web page.
It is the long view — `/eklavya:progress` gets twenty lines and answers *what
now*, this answers *am I getting better* and *what did that session actually
teach me*. It is five workflows in one shell, **Learning**, **Memory**, **Artifacts**, **Feedback** and
**Settings**, each with its own Dashboard and sidebar.

Two client/server files, shared design tokens and mascot assets, plus one vendored library. The exception is the tips
library: Driver.js's `hints` module, pinned exactly (`"driver.js": "1.9.0"`, a
devDependency), copied from `node_modules` into `dist/assets/vendor/` by
`copy-assets.mjs` (the build fails without it) and served from this origin. A
second library needs the same case made, and never comes from a CDN.

| File | What it is |
|---|---|
| `mcp/src/dashboard.ts` | `dashboardState(db)` — the whole payload — `projectInventory(db)`, the one list of projects both workflows use, `memoryPage`, `memoryEntry` and `memorySessionPage` for the paged memory resources, `localTokens` (the shared tokens minus their remote font import), `SETTINGS` / `CLI_ONLY` (the settings registry), `settingsState` and `updateSetting`, and `startDashboard`, a loopback `http.createServer` with explicit read routes: `/api/health` (app, version, pid and database, read by `dashboard-daemon.ts`), `/api/state`, `/api/cursor` (`changeCursor`: the cursor on its own, which the page no longer polls), `/api/events` (`createLive`: the cursor as a `text/event-stream`, GET only), `/api/projects`, `/api/memory`, `/api/memory/entry`, `/api/memory/sessions`, `/api/settings`, `/api/attempts/correction`, `/api/feedback` and `/api/feedback/list` (the Feedback workflow's item and its acknowledged list), `/tokens.css`, `/brand/mascot/mascot.js`, `/brand/mascot/mascot.css` and `/mascot.html` (shared Archer Cloak component and studio), `/vendor/driver-hints.js` and `/vendor/driver-hints.css` (the tips library, `VENDOR`, cached an hour), `/manifest.webmanifest` and the three PNG icons it and the page name (`MANIFEST`, `APP_ICONS`: what makes the page installable as an app), `/artifacts/<folder>/<file>`, `/` — and the writes in `WRITES` (`POST /api/settings`, `POST /api/attempts/retry`, `POST /api/feedback/acknowledge`, `/api/feedback/delete` and `/api/feedback/opened`), all through `acceptWrite`. Any other method is a 405, and every response carries `SECURITY_HEADERS` (a same-origin CSP with `frame-ancestors 'none'`, `nosniff`, `X-Frame-Options: DENY`, `no-referrer`; an artifact overrides the framing pair to `'self'` / `SAMEORIGIN` for the viewer) — a new route goes through `send()` or it ships without them. Memory search escapes `%`, `_` and `\` and uses `LIKE … ESCAPE '\'`, so the box matches them literally. Reads other than `/api/health`, `/api/cursor`, `/api/events`, one feedback item and a correction are answered from a per-database memo (`memoFor`, `stateBody`, `inventoryOf`, `pageBody`: see *The stream, the watcher and the memo*). `send()` answers `no-store` unless the caller says otherwise: `CACHE_HOUR` (`private, max-age=3600`) for `/tokens.css`, the mascot files and thumbnails, `max-age=3600` for the tips library, and `/` goes out `no-cache` with an `ETag` (the write token is in the page, so a restart changes the tag). `DEFAULT_PORT` lives in `paths.ts` (re-exported here) so the SessionStart hook can probe the port without importing this module. |
| `mcp/src/assets/dashboard.html` | The entire client: styles, markup shell, workflow registry, router, views, charts. One file, no framework, no build step. |
| `mcp/test/dashboard.test.ts` | The payload's contract, the inventory's rules, and `/api/state`'s key set. |
| `mcp/test/dashboard-browser.test.ts` | The page in a real Chromium: every legacy redirect, the workflow control, collapse persistence, the drawer, picker bounds, overflow, console errors and outbound requests. |
| `mcp/test/dashboard-events.test.ts`, `dashboard-memo.test.ts`, `dashboard-queries.test.ts` | The stream and its watcher (the intervals are `startDashboard`'s `opts.live`, so a case runs in milliseconds), the memo, its expiry and the headers (read off the SQL the database prepares, not a counter in the code), and every rewritten read held beside the statement it replaced. |
| `mcp/test/dashboard-inpage-browser.test.ts`, `dashboard-fills-browser.test.ts`, `dashboard-render-browser.test.ts`, `dashboard-live-browser.test.ts` | The page in Chromium, one rule per file: an adjustment keeps the reader's place, a revisit makes no request and paints no loader, the kept lists and the sidebar equal a fresh build, and a real write from a second database connection reaches an open page without moving the reader. `probeTransition` in `dashboard-browser-helpers.ts` records each transition (loader, collapse, requests, scroll). |
| `mcp/scripts/dashboard-perf.mjs` | Seeds a temporary learner at `small`, `medium` or `large` and times the builders, the payload and the routes; `--live` also times a write reaching an open page in headless Chromium. Documented in `CONTRIBUTING.md`; run it before and after a change to builders, queries, caps or caching. |
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
spawns a tab every time. **Use `--port`** too: without it the command reuses or
starts the background dashboard on 41729 (`dashboard-daemon.ts`) instead of
serving your build in the foreground. Editing only the HTML? `cp src/assets/dashboard.html
dist/assets/` and reload — no rebuild needed.

## The one rule about data

**One payload of mostly flat rows. The page derives the views.**

`/api/state` ships the newest `ATTEMPT_LIMIT` attempts and the newest
`LOGGED_LIMIT` logged context lines (800 each), one row per day for 365 days, the
whole concept catalogue with its SM-2 state and graph edges, and per-project level
standing. The sessions list, the streak, the heatmap, the
forecast and one concept's question history are five readings of the same rows.

So: **do not add an endpoint or a SQL aggregate per card.** A query shaped like a
card is a query that has to change when the card moves. Aggregate in SQL only for
what the page cannot honestly derive — all-time totals, which must stay right
even though `attempts` and `logged` are capped at `ATTEMPT_LIMIT` and
`LOGGED_LIMIT` rows. A cap shortens a list and never a number: the totals, `daily`,
the catalogue (its counts and last context) and the inventory's per-project counts
are aggregated over every row. The two caps are the payload's size budget, 1.5 MB at
a year of daily use (800 rows of each kind is 1.15 to 1.44 MB, by the length of the
repository path every row carries; `scripts/dashboard-perf.mjs medium` prints it), so
raising either needs that budget measured again.

**Two exceptions, and both are resources, not cards.**

The first is `/api/projects`: the project inventory. `projects` in `/api/state`
is built from `attempts` and so cannot see a project that logged concepts but was
never asked a question, or one that only captured memory; the page's selector and
both Projects pages read the inventory instead. It establishes a project from any
row that names one (attempts, logged concepts through their gate, evidence —
processed or not — entries, receipts, `project_levels`), folds identities with
`projectKey`, and ships `aliases` (every raw spelling → one id) and `sessions`
(no-repository sessions proven by their own rows). Each project's `learning` also
carries `concept_slugs` (every concept any answer or logged line of any origin names
for it, from every row, sorted, attributed as `pid()` does) and `sessions`, so a
project's scope and its session count never depend on how many rows the payload
holds. The page's `pid(raw, sid)` is
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
payload stops at `MEMORY_SESSION_LIMIT`. With `?session=<id>` it also returns
`learning: { logged, attempts, attempts_total }`, everything that session logged and
was asked however old (`sessionLearning`, in the payload's row shapes): how a session
the caps cut, or one that captured no memory, is opened whole.

`/api/events` is a resource too, the cursor as a stream, and not a card: it says
*that* something changed and never *what*.

The asynchronous views (the timeline, an entry, the Memory Dashboard's two
lists, Memory Sessions, the memory half of a session, a session looked up because
the caps cut it, Feedback's item and history, and Settings) return `slot(id, url,
draw, opts)` where the target element goes; `fill(id, url, draw)` is what it
queues, on `AFTER` exactly as `chart()` does. `slot` is the one place that decides
what a fetched region shows:

- **A hit draws at once.** Answers are cached by URL (`RESP`: parsed bodies, never
  markup; `RESP_MAX` is 50, least recently used out first), each under the
  `S.cursor` it was read under. A hit draws inside `render()`: no request, no
  loader. The URL carries the project, so a project switch leaves the cache alone.
  `invalidateData()` clears it (a save, and `adoptState` when new data arrives), a
  write that changed one answer forgets just that prefix (`respForget`), and a read
  that was out when the cache was dropped is not stored when it lands (`respAt`).
- **A miss reserves its room.** The target holds a box as tall as that region last
  drew (`SLOT_H`), else an estimate measured at a year of use (`SLOT_MIN`), with the
  mascot loader in it after its own 150ms delay, so the footer does not move.
- **A region that already shows an answer keeps it.** A pager, a filter or a refetch
  of the same region leaves the old content under `aria-busy` and `data-kept`: out
  of the pointer's reach at once (and the keyboard's, in `onActivate`), dimmed only
  if the answer takes longer than 150ms, so one that comes from the server's memo in
  a few milliseconds never flashes. A failed read shows its error and leaves nothing
  dimmed.

Each render bumps `GEN`, and a response from an older render is dropped (and cached
for later), so a late fetch can never paint one workflow's content over the other's.
A `draw` may queue its own charts and slots; `slot` runs them. Otherwise `draw` is
a pure function of the response, and must not change it: a cached body is drawn
again.

**`adoptState(s, inv)` is the one place `S` and `INV` are assigned after boot** (boot
and `liveAdopt` call it, and a test reads the source for that). It recomputes the
scope and drops what was derived from the old data and what was read under it. The
lists the views read (`sessions()`, `conceptsInScope()`, `seenConcepts()`, the
attempts and logged rows in scope, `dailyInScope()`, `streaks()`, the sidebar's
counts, the heatmap's bucketed days) are built once per `S`, `INV`, `PROJECT` and
local day (`derived()`), then frozen, so a caller that sorts or pushes onto one
throws: copy first, and never write to a row. The Learning Dashboard draws in about
20 ms at a year of use and about 24 ms at a large history, from about 55 and 70 to 85
(headless Chromium on the development machine; reported, not asserted in CI).

**`/api/state` is append-only.** Add keys; never rename or remove one.

**Live, and never moves the reader.** This replaces the old rule, *announced, never
silent* (a button offered a reload because a redraw would have moved the table the
reader was halfway down). The open dashboard shows new activity by itself. A redraw
on new data may change numbers, rows and badges in place. It may not change the
scroll, the focus, the caret, an open fold, a typed value or a framed page. A banner,
a button or a toast that asks for a refresh is a defect, and so is a poll:
`dashboard-live-browser.test.ts` holds the page to this with real writes.

**The stream, the watcher and the memo follow `changeCursor`.** The cursor is the
`change_version` counter that triggers move (migration 021), a hash of the effective
config (the user file's and each answered project's) and a stat of the artifact
files. A new table the page shows needs its triggers in a new migration, or work
landing in it never moves the cursor and an open page never hears of it; a column
that changes on every turn without changing the page needs a `WHEN` like `gates`'.
`/api/state` carries the cursor it was built under as `cursor`, which is what the
page compares each event with.

- **The stream.** `GET /api/events` (`createLive`) sends `event: cursor` with the
  current cursor on connect and again each time it moves, with a `: keep-alive`
  comment every `EVENTS_KEEPALIVE_MS` (25 s). It carries nothing else: a thing to
  push is a field of `/api/state`. It sits behind the same handler as every read
  (the loopback check, `SECURITY_HEADERS`, `no-store`), refuses the 33rd open stream
  with a 503 (`EVENTS_MAX_STREAMS`) and cuts a stream that will not take a write
  instead of buffering for it. `/api/cursor` stays for older pages and anything that
  polls.
- **The watcher** runs only while a stream is open, and hooks, the SessionStart path
  and `/api/health` never wait on it. The floor reads `changeCursor` every
  `EVENTS_FLOOR_MS` (1 s, 0.5 to 3 ms a read); it keeps the stream right where
  `fs.watch` is silent (a network mount, an editor that replaces a file). The early
  trigger is `fs.watch` on the database's `-wal` (through its directory, by name),
  the user config file, each project's config file and each artifact folder,
  debounced by `EVENTS_DEBOUNCE_MS` (150 ms) into one check. Each folder is watched
  by itself, never through one recursive watch: on Linux that holds a watch per
  inode, so the first atomic rewrite of a file (every config write, most editors'
  saves) leaves the new file unwatched. Every watch is optional and a failed one is
  dropped. A `WRITES` route calls `live.bump()` after it writes, so the page that
  wrote and every other open page redraw without waiting for a check. On a change the
  memo is rebuilt first (`warmMemo`), then every stream is written, so the read the
  event provokes is a repeat. The writers are other processes (hooks, the MCP server,
  the CLI), which is why the server reads the database and cannot be told.
- **The memo** is one per database handle, in a `WeakMap` (`memoFor`), valid for the
  cursor and `reviewFailed` as they were read before any build stored in it. It
  holds `/api/state` as the bytes it is sent as, the project inventory (kept across a
  config or artifact change, which it does not read) and an LRU of serialised
  responses by full URL (`pageBody`, `PAGE_CACHE_ENTRIES`, none over 1 MB). The cursor
  does not cover the clock (scores decay at read time) or the filesystem (a
  checkout's `.git`, the artifact files), so the state, the inventory and the Settings
  pages also expire after `MEMO_TTL_MS` (60 s). `reviewFailed` is asked beside the
  cursor because `feedback_reviewed` has no change triggers on purpose and the state
  says "could not review" from it. Settings adds a stamp of the config files and of
  the inventory's build time, and a settings write drops its pages
  (`forgetSettings`). Never memoized: `/api/cursor`, `/api/health`, one feedback item
  (a POST acknowledges it) and a correction (graded live). The first build is made
  when the server starts listening (`warmMemo`, unref'd, swallowed on failure). Do not
  add a per-request build to a read.
- **The page** holds one `EventSource` while its tab is visible. On a cursor that is
  not `S.cursor` it reads `/api/state` and `/api/projects`, swaps them in
  (`adoptState`), writes what boot writes outside the view (`paintChrome`: the
  footer's database path and cap line, the dial line, the project picker) and draws
  the screen it is on again through `syncFromUrl` with `LIVE_PASS` set. Events that
  arrive while a read is out are one more read (`LIVE.busy`, `LIVE.more`). A hidden
  tab closes the stream and makes no request, and the reconnect's first event is the
  current cursor, so a tab left open all afternoon catches up in one read. A server
  that goes away is the browser's to retry, and the page keeps what it has with no
  banner; a stream the server refuses (a 503) is not retried by the browser, so the
  page opens it again after 5 s, doubling to 60 s. A write the page made itself
  redraws from its own answer, and the event that follows replaces nothing.

| Key | Shape |
|---|---|
| `config` | `quiz_enabled`, `quiz_enforced`, `focus`, `focus_topic`, `cadence`, `difficulty`, plus the thresholds the Projects page reports against. The two `quiz_*` booleans replaced a single `mode` string — the dial line renders `enforced` only when set, and `questions off` when `quiz_enabled` is false |
| `totals` | all-time answers/passed/missed/skipped, mastered, due, touched, catalogue, sessions, active days |
| `daily` | `{day, repo, passed, missed, skipped}`, one row per day **per project**, 365 days |
| `projects` | answers, accuracy, concepts, first/last active, plus `levelStanding` — level, next, counts, needed, unmet |
| `domains` | catalogue / touched / mastered / learning / unseen |
| `concepts` | the whole catalogue: `seen`, decayed `score` and `stored_score`, ease, interval, reps, `due`, `overdue_days`, last context, `prereqs` / `unlocks` / `related` as slugs |
| `attempts` | newest `ATTEMPT_LIMIT` (800): question, options JSON, answer, feedback, grade, tier, outcome, format, repo, level, session id |
| `attempts_shown`, `attempts_total` | the rows that travelled and every answer there is; the footer prints a line when shown is less than total |
| `logged` | newest `LOGGED_LIMIT` (800) `session_concepts` rows: slug, context, origin, ts, session id, repo |
| `logged_shown`, `logged_total` | the same disclosure for the context lines; `logged_total` is the count over every row |
| `cursor` | the `changeCursor` the build was made under, which the page compares with each `/api/events` event |
| `memory` | counts, not rows: captured / processed / indexed / reused / exposed / assessed, entries live vs superseded vs deleted, candidate statuses, and the type / tag / project facets the filters are built from |
| `reuse` | `receiptTotals` (confirmed rows only), the `savingsFrom` verdict and `savingsLine`, the estimator's name, counts by delivery, and the newest `RECEIPT_LIMIT` receipts with their index/detail split |
| `health` | capture heartbeat and mode, `queueDepth`, stalled jobs grouped by `error_class`, the spool's drop count, and whether a provider is configured |
| `memory_sessions` | one row per session that captured evidence: events, entries, candidates, first/last — what lets the Sessions view line the two halves up |
| `feedback` | `{ enabled, memory, observer, pending: { id } \| null, notify, acknowledged, failed }` from `feedbackSummary`: switches, whether an item waits (its id, never its text), whether to show the badge (`notify`: waiting, feedback on and memory on), the acknowledged count and whether the last session looked at could not be reviewed. The prompt text is only ever served by `/api/feedback` to the page that shows it |
| `artifacts` | `listArtifacts()` from `artifacts.ts`: every page under `~/.eklavya/artifacts/`, newest first — `id` (`<folder>/<file>`), title, description, project, kind (`explainer` or `artifact`), concept, `attempt` (the `eklavya:attempt` meta, or null), created, bytes, plus `correction` (`open`, `done` or null, one query for all rows). Read from the files' heads on each load; there is no table |

Two things that have bitten this file already:

- **Timestamps come in two shapes.** `attempts.ts` is SQLite's `2026-09-05
  21:04:00` — UTC with no marker, which `Date.parse` reads as *local*. `next_review`
  and `last_seen` are JS ISO strings that already carry a `Z`. Both ends have a
  parser that handles both (`parseTs` in `dashboard.ts`, `parse()` in the page).
  Appending `Z` unconditionally gives `...ZZ` → `NaN`, and every overdue count
  silently reads zero. Never write a third parser.
- **A day is the learner's local day.** The server groups with
  `date(a.ts, 'localtime')` (the dashboard runs on the learner's machine), and
  the page reads "today" only through `todayKey()` (`localKey(new Date())`).
  Stepping between keys (`fromKey`, `+DAY_MS`) stays in UTC. A UTC "today"
  puts an answer at 01:00 in India on yesterday and breaks a streak.
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

## Adding a tip

A tip is one row of `TIPS` in `dashboard.html`; `TIP` does the rest (Driver.js
places the bubble and beacons; `TIP` decides which apply and remembers what the
reader saw under `eklavya-dash-tips`).

```js
{ id: 'concept-filters', where: ['learning/concepts'], el: '#chips', title: 'Concept filters',
  text: 'Filter concepts by state. The filter is part of the link, so you can bookmark it.',
  side: 'bottom',                 // optional: top | right | bottom | left
  state: 'tip',                   // optional: the companion's mascot state, default tip (wink)
  when: () => S.concepts.length } // optional: only when the data makes it true
```

- `id` is kebab-case and never reused. Renaming one shows the tip again to
  everyone who dismissed it: reword `text` instead, and give a new message a new id.
- `where` lists `<workflow>/<page>` keys of `WORKFLOWS`; `el` is the feature on
  each of them. `title` (at most 32 characters) is the beacon's accessible name;
  `text` (at most 140) says what the feature does, plain, no emoji, no "click here".
  Both go through `esc()`.
- Order is priority: only the first eligible tip on a screen opens by itself, once;
  the rest stay beacons until it is dismissed. A feature that is not laid out, or sits in
  the sidebar while it is the phone drawer (900px and below), is not eligible.
- `TIP.sync()` runs after every `render()` and every `fill()` draw, and when
  the drawer, a picker or the correction dialog opens or closes. A new overlay
  that a beacon must not sit on calls it too.
- The registry guard in `dashboard-browser.test.ts` opens every `where` on the
  fixture and fails if `el` does not resolve to a rendered element. A typo
  fails CI, not a reader. Browser tests run with tips off unless they pass
  `tips: true` to `open()`; `window.__eklavyaTestTips` replaces `TIPS` for engine tests.

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
- Fill with role tokens: `var(--spot)` for right, `var(--spot-soft)` with a
  `var(--spot)` hairline for corrected, `var(--warning)` for missed,
  `var(--faint-2)` for skipped. Sequential ramps are
  `color-mix(in srgb, var(--spot) N%, var(--mass))` — a `--vd-*` step is legible on
  one ground and invisible on the other.
- Tooltips are `<title>` children unless the chart already owns a `.tip` div.
- **Plot the empty intervals.** `fillDays()` exists because a time axis must
  allocate a slot per day, not per data point: three sessions in a month must not
  close up into three adjacent bars. Gaps are the honest part.

Existing ones to copy from: `chartActivity` (stacked bars + hover tip),
`chartHeatmap` (week columns; picks its *window* from the width and keeps the
cell fixed; four colour steps over the visible window's busiest day; the
current streak's cells outlined inside their own bounds; on a window under 53
weeks, ‹ › buttons page it by its own width through `HEAT_OFF`, a view offset
that `render()` resets and the URL does not carry, redrawing only the SVG),
`chartForecast` (14 days plus one overdue column), `chartGrades`
(one concept's grades in order), `segbar` (a whole, split — plain HTML).

## Tables, paging and filters

`table(cols, rows)`, `pager(key, total, page, per)`, `page(key, total, per)`,
`slice(arr, p, per)`. `PER` is 20; a concept's question history pages at 10. `page()` clamps a
stored page number to a list that shrank under a filter — always route through it
rather than reading `T[key].page` directly.

Per-view control state lives in `T`. A filter the reader would want to **link to**
lives in the hash instead (`#/learning/concepts/due`, `#/learning/review/skipped`, `?tag=`) and is read back
from `param` at the top of the view — the view derives it, the chip only navigates.
Search text and sort order stay in `T`: they are typing, not destinations.

A search box sits outside every region, and what is typed in it is not part of the
markup a redraw compares, so a keystroke replaces the list and nothing else: the box
keeps its caret and any input method session. A future text input that filters a
list does the same: outside the regions, its text in `T`.

## Progressive disclosure: what a page shows first

The timeline set the rule and every page follows it: **the answer first, one
line per item, detail one click away.** A page is, in order:

1. `pageHead(title, counts, about, back)` — the title, one mono line of counts
   (`.counts`, joined with ` · `), and the page's explanation folded under a
   "How this works" `<details class="about">`. Arithmetic the honesty rules
   require is said there, not in a paragraph above the fold.
2. At most four `tiles()` — only numbers the reader acts on. A total that is
   context, not a decision, belongs in the counts line.
3. `nextStep(html, ok)` — the one thing waiting on the reader (due reviews, a
   stalled job), or nothing. Never a banner per fact.
4. The lists. `lines(items)` for short lists (`{ t, s, v, go }`: title, quiet
   mono second line, one value); `table()` for paged ones, at most four or five
   columns — secondary fields go in the row's second line. A question answered
   is `qaLine(a, lead)`, a `<details>` that opens to its options and feedback.
5. `fold(id, title, peek, body, { open, hint })` — secondary cards (calendars,
   grade history, settings, audit detail) as a closed `<details class="card fold">`.
   The `peek` is what the closed summary still answers: a count or a verdict.

Folds remember being opened or closed in `localStorage` under
`eklavya-dash-folds`, keyed by `id` (`<page>:<what>`, stable across renders);
storage that throws means the defaults. A `chart()` whose element is inside a
closed `<details>` has no width to measure, so it waits in `LAZY` and the
capture-phase `toggle` listener on `#view` draws it when its fold opens. All
helpers take HTML the caller already escaped — `esc()` at the call site, as
everywhere else.

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
- **All handlers are delegated** on `#view`. The markup is replaced wholesale, a view
  or a region at a time, so a listener bound to an element is a listener that vanishes.
- Navigation goes through `goTo(hash)`, which re-renders in place when the hash
  is already what we want (clicking the chip you are already on).

**Navigation versus adjustment.** `render()` tells a *navigation* (another page,
workflow, project, concept or entry) from an *adjustment* (a tab, a chip, a select, a
date range, a pager, a search keystroke, a resize, the ground, and new data). A
navigation rebuilds the shell, brings the sidebar in line, replaces `#view` and
scrolls to the top with `behavior: 'instant'` (`html` has `scroll-behavior: smooth`,
and a bare scroll would glide up from where the reader was). `renderNav` builds the
rail only when the workflow changes, and otherwise updates its links, counts and open
groups in place, so a link followed from the keyboard stays focused. An adjustment
keeps the scroll, leaves the shell alone and redraws only what changed. It is one
when the screen on show is the same page (or another route to the same screen:
`screen` in the registry, for `#/settings/user` and `#/settings/dashboard`), in the
same project, and either nothing in the URL moved or the page is `inPage`, which says
its `param` and `query` are tabs and filters of the one screen. Mark a page `inPage`
only when that is true: on a detail page another `param` is another subject.
`render({ nav: true })` forces a navigation for a caller that replaces what the
screen is about.

A view marks what a control changes with `region(id, html)` (or `slot(..., {
region: true })` for a fetched list): a `data-region`, unique in the view and never
nested. The markup with every region emptied is the screen's skeleton
(`scanRegions`). `drawAdjusted()` compares it with the skeleton the screen was drawn
from (`DRAWN`). When they are equal, only the regions whose markup differs are
replaced, each wholesale, in the element already on the page; otherwise the view's
content is replaced, still without scrolling, which is what a view with no regions,
two regions of one id or nested regions gets. The comparison leaves out what the
reader owns: whether a fold is open (`FOLD` holds it), the text in a search box (`T`
holds it) and anything marked `data-hold`. A view stays a pure function of the
payload, the scope and its controls, and a region is replaced, never patched by hand.

What a redraw may change: numbers, rows, badges, the sidebar's counts, the charts.
What it may not change: the scroll, the focus and the caret (`captureUi` and
`restoreUi` carry them, with every open `<details>` that has a stable key: a fold id,
an entry id or a `data-key`), a Settings value that is typed and not saved, a choice
list that is open, or a framed page. A redraw for new data (`LIVE_PASS`) leaves alone
a region that holds a control the reader is using (`unitsInUse`: the focused one, an
open list, an edited value), puts it on `HELD_BACK`, and draws it when focus leaves
(`catchUp`). The heatmap's page (`HEAT_OFF`) survives it too. A view with no regions
still works: its content is replaced without scrolling, and only what `captureUi`
carries (focus, the caret, open folds) survives.

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

## Settings: the first write

The Settings workflow is the dashboard's half of a promise: **configuration has
two interfaces, `eklavya config` and this page, and they change together.**

- Both write through `applySetting` in `config-path.ts`. It checks the key,
  coerces the value and refuses one `coerce` would silently drop, builds the
  patch against the file (siblings kept), stamps `project`, and calls
  `writeConfigFile` (backup, atomic rename, global-only refusal). `value`
  `undefined` is unset: that is `eklavya config unset` and the page's
  Inherit / Reset button. Never write a config file from `dashboard.ts` any
  other way.
- `SETTINGS` in `dashboard.ts` is the registry the page renders (label, help,
  group); its type, options, range and lengths are merged in from
  `SETTING_RULES` in `config-path.ts`, never written here. `CLI_ONLY` lists keys the page shows but
  will not change — providers, notifications and sync, because each sends work
  off the machine or runs a command. `dashboard.test.ts` fails when a
  `DEFAULT_CONFIG` leaf is on neither list, so **a new config key is placed
  here in the same change** as its CLI help and `set_config` schema.
- `updateSetting` leaves every value rule to `applySetting` (the table, then
  `coerce`, then combinations such as `learn` with no topic), so its 400s are
  the CLI's messages word for word, and checks that a project is one of
  `configurableProjects(db)` — inventory projects with a `.git` on disk. The
  page can never name an arbitrary path to write to.
- The page validates before it POSTs: `fieldProblem` mirrors `settingProblem`
  in the same words, `ruleHint` prints the accepted range under the help, and
  `fieldError` puts a refusal — the page's or the server's — in the field's
  `-e` element with `aria-invalid`, keeping the typed value.
- `POST /api/settings` is a row in `WRITES`, so `acceptWrite` guards it: a
  loopback `Origin` (not `null`: a sandboxed frame sends that),
  `application/json` (no cross-origin form can), a body of at most 256 KB, and
  `x-eklavya-token` equal to the per-start token the `/` response writes into
  `<meta name="eklavya-token">`. A hostile origin cannot read that page, so it
  cannot learn the token. The page sends it through `postJson`.
- The page saves on `change` and redraws `#settings` in place (not via
  `render()`), restoring focus to the control used. Errors come back as `{ error }`
  and show in that row's `data-msg`. `saveSetting` still says "saved" when a redraw
  for new data lands while the save is out.
- A tab draws from `SETS`, the last `/api/settings` response, when `settingsFresh()`
  says it was read under the page's cursor and project: no request. One response
  holds both scopes, so it serves any tab of either. `invalidateSettings()` runs on a
  project change and `invalidateData()` on a save and on new data; the next draw then
  reads once more. The pane is the regions `sw-head`, `sw-tabs`, `sw-body` and
  `sw-rail`, so a tab redraws what it changes and the scope rail stays. Arriving by
  `#/settings/user` or `#/settings/dashboard` is the same screen.
- New data never redraws `sw-body` under a control being used: the tab strip, its
  counts and the rail still update, the rows wait, and `catchUp` draws them when focus
  leaves.

## Feedback: one item, one rule

The fifth workflow shows one reviewed prompt at a time, and everything about it
serves one rule: **only a POST the server saw acknowledges.** A GET, a page view,
a reload, an item opened by URL and Back never do, and a test per path says so.
Do not add a route, a query string or a render path that writes `acknowledged_at`.

- **The payload says that an item waits, never what it says.** `S.feedback` has
  the id and counts; the prompt, better prompt, notes and tips come from
  `/api/feedback` into `#fb-item` through `fill()`. A new field on the payload
  must not be text the learner wrote.
- **The badge is `S.feedback.notify`**, not `pending`: a stale item from before
  feedback or memory was switched off waits quietly. `syncBadge()` runs from
  `renderShell()`, sets the caret's label (`Switch workflow, 1 feedback unread`) and
  the visible `1` on every workflow; the picker item says `Feedback, 1 unread`.
  The badge is `--warning` with `--bg` text, `aria-hidden`, and never animates.
- **`via` is how the page was reached**: the greeting link carries `?via=greeting`,
  the picker `?via=badge`, anything else is `direct`. `fbOpened()` POSTs it once
  per opening (`FB.counted`, reset when another page renders, so a resize does not
  count twice) and then drops `via` from the URL with `replaceState`. It is declared
  in the page's `query` list so the router keeps it.
- **Acknowledge and Delete go through `postJson`**, disable while in flight, and
  end in `fbDone()`: redraw from the response's `state`, focus the heading, and
  announce through `#fb-live`, which is outside `#view` so it exists before its
  text does. Delete confirms inline; there is no `confirm()` dialog.
- **The "Found a problem with Eklavya?" card is not a tip.** Its words run past a
  bubble's 140 characters, so it is not in `TIPS`. Dismissal is
  `eklavya-dash-feedback-tip` in `localStorage`; storage that throws shows the
  card, the opposite of the tips engine, because it is information and not a nudge.

## Loopback is not the boundary it looks like

`startDashboard` refuses any request whose `Host` is not a loopback name, and
any cross-origin `Origin` that is not loopback either. Do not remove that check
and do not widen it to "starts with 127.": a page the developer has open can
point a hostname it controls at loopback and fetch from here, and the browser's
same-origin rule does not stop it because the page's origin *is* that hostname.

Two consequences for anything added here. A new endpoint inherits the check
because it sits behind the same handler — keep it that way rather than
registering a second server. And a mutating endpoint needs more than this
check: every route in `WRITES` goes through `acceptWrite`, which adds the page
token, a required loopback `Origin`, a JSON content type and a size cap. A new
write is one `WRITES` row and one `WriteHandler`; the page calls it with
`postJson(path, body)`, never its own `fetch`. The table-driven guard test in
`dashboard.test.ts` covers every row, so the new route inherits it.

## An artifact page is not the dashboard

**The one frame: the viewer.** Every page opens at `#/artifacts/view/<id>`, as
a tab: an `<iframe>` of `/artifacts/<id>?embed` with `sandbox` lacking
`allow-same-origin` (never add it), plus, for an explainer whose `correction`
is not null, the pinned correction bar and a native `<dialog>` for the modal.
`?embed` goes through `embedHtml`: it strips the template's Google Fonts links,
renames a 1.46.0 page's own height message out of the race, and adds
`EMBED_SCRIPT` before `</body>`, which hides the page's overflow and reports
where an empty block appended after the content sits (it can shrink, and it
ignores `html,body{height:100%}`; `scrollHeight` does neither). Content that
grows with the frame (a `100vh` box) outruns three reports in a row; the page
then sends `eklavya:scroll` and the viewer gives it the 80vh frame to scroll
in. Nothing is reported while the frame has no width: one word per line
measures past the cap, and a frame stuck at the cap never resizes, so the
outrun count never reaches three. The response
carries `ARTIFACT_EMBED_CSP` (no font hosts), so the viewer keeps the
no-outbound-request promise. The framed page may only `postMessage` its
height (`eklavya:height`, accepted from that frame's `contentWindow` alone, and
clamped to [200, 20000]) and receive the ground (`eklavya:mode`); it never
writes. The frame sits in a box (`.viewer__box`, `data-hold`) at the height that
tab last reported (`TABS.height`), else 80vh (`--wait-h`), with the loader over its
top for a tab not opened before, so opening a page reflows once, when the real height
arrives. After 1.5s without a report the frame falls back to 80vh and scrolls inside.
The box and the correction bar are `data-hold`, so a redraw of the screen (new data,
the ground) leaves them in the document: the frame is the same element, its page is
not loaded again, and the ground reaches it by message. The tab strip is a region.

`TABS` holds the open tabs (at most `TAB_MAX`, persisted under
`eklavya-dash-tabs`, least-recently-viewed eviction that spares open
corrections); `drawTabs(active)` draws the strip at the top of the gallery and
the viewer. The URL names the active tab. Scroll per tab lives in memory and is
restored once the page is tall enough to reach it, or abandoned when the
reader scrolls first. Every write
is page code calling `postJson('/api/attempts/retry', …)`; the server grades and
never sends `correct`. `armLeave` holds a `beforeunload` prompt while the bar is
open and `render()` disarms it on every navigation. The resize handler skips
the viewer: nothing on it depends on the width, and its frame reports its own height. In the browser suite, `ready()`
counts the page's own open requests: Playwright never reports `networkidle`
again once a sandboxed frame has attached.

`/artifacts/<folder>/<file>` serves HTML an agent wrote, from this origin. It
goes out with `ARTIFACT_CSP` instead of the page's CSP: `sandbox` without
`allow-same-origin` gives it an opaque origin, so its scripts run (the PDF and
HTML buttons need them) but a fetch to `/api/state` is refused, and
`default-src 'none'` plus the Google Fonts hosts is all it may load. The page
opens every page in the viewer; the viewer's **Open in new browser tab** is the
one plain `<a target="_blank" rel="noopener">` to the raw file, never `data-go`. `resolveArtifact` is the only way from a URL to a
file; do not join paths here. `test/artifacts.test.ts` covers traversal, a
planted symlink and the rebound host, and the browser suite checks the opened
page cannot read the API.

The Artifacts Dashboard is a gallery: one `.art` card per page, its thumbnail
an `<img>` of `/artifacts/<id>?thumb=ink|paper&v=<bytes>`. `artifactThumb`
cuts the page's first `<figure>` `<svg>` out with the page's `<style>` blocks
and sets `data-mode` on its root; a page with no diagram gets the cover sheet.
An image runs no script and loads nothing, which is why this is safe where an
iframe is not. `eklavyaGround.apply` swaps every `img[data-thumb]` to the new
ground; `v` busts the hour-long cache when a page is rewritten.

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
- Disclose every cap. `attempts_shown < attempts_total` and `logged_shown <
  logged_total` each print a line in the footer rather than letting a truncated
  history look complete. A cap shortens a list and never a number.
- Keep the pre-migration rows. A null repo is "recorded before projects were
  tracked" and stays visible; dropping it would shrink every total on the page.
- Scope is *activity*, not mastery: the project selector narrows attempts,
  sessions and the concept list, but a concept you know is a concept you know, so
  scores and review dates never change with it.
- **Captured is not assessed.** Six words for six different things, never one
  "memories" number: evidence can be captured and never processed, an entry
  indexed and never retrieved, retrieved and never delivered, delivered and
  never asked about. Only `assessed` required the developer to answer something.
- **A receipt no hook wrote out is never a saving.** `savingsFrom` in
  `memory/tokens.ts` is the only place the percentage is computed and it refuses
  to divide unless the delivery was `emitted` (or a legacy `confirmed`, the same
  fact); the page shows `unknown` and `prepared` rows in the ledger with no
  verdict beside them. Never call emitted context host-confirmed: Claude Code
  does not acknowledge hook context. Say "estimated
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
4. Payload changes get a case in `mcp/test/dashboard.test.ts`. A change to the
   stream, the watcher or the memo gets one in `dashboard-events.test.ts` or
   `dashboard-memo.test.ts`, and a change to what a redraw keeps gets one in the
   in-page, fills or live browser suites. Run `scripts/dashboard-perf.mjs` before
   and after a change to a builder, a query, a cap or what a route caches.
5. **Docs ship in the same commit** — this is the repo contract, not a follow-up:
   `web/src/content/docs/docs/dashboard.mdx` (sections, routes, page sizes), the
   `#dashboard` block in `web/public/index.html`, and the route table in
   `user-skill/eklavya/SKILL.md` so chat can hand back `#/learning/review` rather than the
   bare root. A new route that nothing documents is a route nobody will find.
