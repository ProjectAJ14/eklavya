---
name: eklavya-dashboard
description: How Eklavya's learning dashboard (`eklavya dashboard`) is built and how to change it — the one JSON payload, the hash router, the hand-rolled SVG charts, the table/pagination helpers, and the checks a change has to pass. Use whenever adding, editing or debugging anything in mcp/src/dashboard.ts or mcp/src/assets/dashboard.html, or when a request mentions the dashboard's sections, charts, filters, drill-downs or routes.
---

# Working on the dashboard

`eklavya dashboard` serves the learning history as a local web page. It is the
long view — `/eklavya:progress` gets twenty lines and answers *what now*, this
answers *am I getting better* and *what did that session actually teach me*.

Two files, and there is deliberately nothing else:

| File | What it is |
|---|---|
| `mcp/src/dashboard.ts` | `dashboardState(db)` — the whole payload — and `startDashboard`, a loopback `http.createServer` with three routes: `/api/state`, `/tokens.css`, `/`. |
| `mcp/src/assets/dashboard.html` | The entire client: styles, markup shell, router, views, charts. One file, no framework, no build step. |
| `mcp/test/dashboard.test.ts` | The payload's contract. |
| `web/src/content/docs/docs/dashboard.mdx` | The manual page. It is a **test of this code**, not prose about it. |

`web/public/tokens.css` is copied into `dist/assets/` by `mcp/scripts/copy-assets.mjs`
and served at `/tokens.css`. The dashboard and the site therefore share one
palette by construction; do not fork it.

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

| Key | Shape |
|---|---|
| `config` | the four dials plus the thresholds the Projects page reports against |
| `totals` | all-time answers/passed/missed/skipped, mastered, due, touched, catalogue, sessions, active days |
| `daily` | `{day, repo, passed, missed, skipped}`, one row per day **per project**, 365 days |
| `projects` | answers, accuracy, concepts, first/last active, plus `levelStanding` — level, next, counts, needed, unmet |
| `domains` | catalogue / touched / mastered / learning / unseen |
| `concepts` | the whole catalogue: `seen`, decayed `score` and `stored_score`, ease, interval, reps, `due`, `overdue_days`, last context, `prereqs` / `unlocks` / `related` as slugs |
| `attempts` | newest `ATTEMPT_LIMIT`: question, options JSON, answer, feedback, grade, tier, outcome, format, repo, level, session id |
| `logged` | every `session_concepts` row: slug, context, origin, ts, session id, repo |

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

## Adding a view

1. Write `viewThing(param)` returning an HTML **string**.
2. Add it to `VIEWS`. The key is the route: `#/thing/<param>`.
3. Add a row to `NAV` (`[key, label, inline SVG path]`) if it deserves a sidebar
   entry, and a count in `renderNav`'s `counts` if there is an honest number.
4. If it is a **detail** page reached from a list, leave it out of `NAV` and add
   it to the `root` map in `render()` so the parent nav item stays marked while
   you are on it (`concept → concepts`, `session → sessions`, `domain → domains`).

`route()` is `location.hash.slice(2).split('/')` — an unknown name falls back to
Overview. Detail pages start with `<a class="page__back" data-go="#/parent">`.

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
lives in the hash instead (`#/concepts/due`, `#/review/skipped`) and is read back
from `param` at the top of the view — the view derives it, the chip only navigates.
Search text and sort order stay in `T`: they are typing, not destinations.

The search box re-renders on every keystroke, so `render({id:'q', pos})` restores
focus and caret. Any future text input needs the same.

## The interaction contract

These are not nice-to-haves; a reader who clicks something that does nothing
stops trusting the page.

- **The wordmark goes home.** `.side__brand` is an `<a href="#/overview">`.
- **Anything that looks clickable is clickable**: a row that has a detail page
  gets `class="row" data-go="…"`, a stat tile whose number *is* a list gets a
  `go` as its fifth `tiles()` field, a concept name is a `.link`.
- **Everything clickable is keyboard-operable.** Rows get `tabIndex = 0` on
  render; Enter and Space are handled by the delegated `keydown` on `#view`;
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

## Before you call it done

```bash
cd mcp && npm run build && npx vitest run          # 392+ tests, dashboard.test.ts included
node dist/cli.js dashboard --port 41799
```

1. Every section and both detail levels, at **1280, 900 and 560**, in **both
   grounds**. A bug that only shows on paper is the commonest kind.
2. No console errors; `document.documentElement.scrollWidth === clientWidth` at 560.
3. Click the thing you added, then Tab to it and press Enter.
4. Payload changes get a case in `mcp/test/dashboard.test.ts`.
5. **Docs ship in the same commit** — this is the repo contract, not a follow-up:
   `web/src/content/docs/docs/dashboard.mdx` (sections, routes, page sizes), the
   `#dashboard` block in `web/public/index.html`, and the route table in
   `user-skill/eklavya/SKILL.md` so chat can hand back `#/review` rather than the
   bare root. A new route that nothing documents is a route nobody will find.
