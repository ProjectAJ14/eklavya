# Streak card and start-review commands — design handoff

- **Base:** `main` @ `98136b1` (includes #116, corrections count toward accuracy and level progress)
- **Branch:** `feat/review-streak`
- **Previous brief:** `docs/design/dashboard-tips-handoff.md`
- **Design source:** the maintainer's screenshot of Wispr Flow's "49 day streak"
  card (big streak headline, "Longest streak | 49 days" on the right, a week-column
  calendar with month labels and ‹ › arrows, four green steps with a More/Less
  legend, the current streak's cells outlined), restyled to Eklavya's rules in
  `.claude/skills/eklavya-design/SKILL.md`. No Figma.

## Agent preamble

Follow the root `CLAUDE.md` and `mcp/CLAUDE.md`; read `web/CLAUDE.md` before
the docs stage. Load `eklavya-dashboard` and `eklavya-design` before any UI
work and `verify-docs` before opening the PR. Tests use a temporary
`EKLAVYA_HOME` / `EKLAVYA_DB` and `EKLAVYA_DASHBOARD_PORT`, never the real ones.
Preserve everything earlier briefs established (artifact tabs, the correction
bar, the tips engine and its `TIPS` registry). No charting library: the
heatmap stays hand-rolled SVG.

## The feedback, verbatim intent

1. Put a Wispr-style streak chart on the dashboard, visible as soon as the
   learner lands on it — not hidden.
2. "Due" leads to the review queue, which says "Run `/eklavya:quiz` in Claude
   Code". That does not tell the learner **where** to run it or **for what**;
   a bare `/eklavya:quiz` in the wrong folder does not even serve those reviews.
3. Make the next action obvious: from the queue or a due concept, the learner
   should get a ready-to-run command they can copy and paste into a terminal.
4. (Considered, not chosen this round: answering inside the dashboard, or a
   button that opens a terminal. See Decisions.)

## What the investigation found

| Fact | Where | Status |
|---|---|---|
| A streak and a year heatmap already exist. `streaks()` returns `{ current, best, days }`; `chartHeatmap()` draws week columns, picks its window from the card width (12–53 weeks), one colour at 0.3–1.0 opacity. | `dashboard.html:1008-1022`, `:1303-1339` | Verified. Reuse both. |
| The heatmap is folded at the **bottom** of Learning → Dashboard (`fold('learn:heat', 'Practice history', …)`), and the streak is only the fourth tile. | `dashboard.html:1591`, `:1632` | Verified. That is why it is not seen. |
| **Days are UTC days.** The payload groups by `date(a.ts)`; the client builds "today" with `setUTCHours(0,0,0,0)`. In India (UTC+5:30) an answer at 00:30–05:29 local lands on the previous day, so a streak can break or a cell shift. | `dashboard.ts:828`, `dashboard.html:1012`, `:1311` | Verified by reading. The dashboard runs on the learner's own machine, so SQLite's `'localtime'` is the learner's zone. |
| The payload carries 365 days (`TIMELINE_DAYS`). | `dashboard.ts:57` | Verified. Paging back is bounded by it. |
| The review queue's only instruction is "Run `/eklavya:quiz` in Claude Code to work through them". The Learning next step says the same. | `dashboard.html:1834`, `:1567` | Verified. |
| A bare `/eklavya:quiz` serves reviews only from **the project it runs in** (`reason: "project_review"`, "this project already asked"). | `get_session_quiz_plan.ts:118` (description), the session branch from `:451` | Verified. Running it in another folder misses the queue. |
| `/eklavya:quiz <slug> [<slug>…]` works **from any folder** and puts due concepts first. It plans the whole `max_questions_per_task` budget (default 4). | `skills/quiz/SKILL.md` "Topic given"; `get_session_quiz_plan.ts:429-440`; `config.ts:352` | Verified. This is the command to hand out. |
| An answer is recorded against the project of the session it is given in, and levels are per project. So the command should `cd` into the project the concept was last asked in. | `record_attempt`; manual `dashboard.mdx:220` | Verified. |
| Every concept in the payload already carries `repo` (`last_repo`, the latest attempt's project). The inventory gives each project `path` and `available` (`fs.existsSync`). | `dashboard.ts:874-876`, `:970`, `:612`; client `pid()`, `projectById()` `dashboard.html:957-964` | Verified. No new server data is needed for the command. |
| The page has no clipboard code today. `127.0.0.1` is a secure context, so `navigator.clipboard.writeText` is available. | `grep clipboard dashboard.html` → none | Verified. |
| `claude "<prompt>"` starts an interactive session with that first prompt. Whether a **slash command** as that first prompt runs as the command (not as plain text) | — | **Hypothesis.** Stage 3 starts by confirming it on the installed Claude Code; fallback below. |

## Delivery order

One PR. After every stage, from `mcp/`:

```bash
npm run build
npm test
npm run coverage
```

100% on every metric. Stage 4 also runs `npm run build` in `web/`,
`.github/scripts/check-docs-sync.sh` and `/verify-docs`.

1. `fix:` Count days in the learner's local time.
2. `feat:` The streak card at the top of Learning → Dashboard.
3. `feat:` Start-review commands on the review queue, the concept page and the next step.
4. `docs:` Manual, landing, READMEs, dashboard skill.

## Stage 1 — Local days (bug)

**Root cause (verified):** the server groups by UTC date and the client counts
"today" in UTC (table above).

**Fix, at the two layers every daily view routes through:**

- `dashboard.ts:828`: `date(a.ts)` → `date(a.ts, 'localtime')`. Leave the window
  filter `a.ts >= date('now', ?)` as is (a day of slack at the edge is harmless).
  Grep `dashboard.ts` for every other `date(` on a timestamp that feeds a day key
  and change it the same way; list them in the commit message. Known: `:1025` `count(DISTINCT date(a.ts)) AS active_days`.
- `dashboard.html`: add one `todayKey()` that returns the **local** `YYYY-MM-DD`
  (`getFullYear/getMonth/getDate`), and use it wherever "today" is derived:
  `streaks()` (`:1012`), `chartHeatmap()` end-of-week (`:1311-1312`),
  `fillDays()` default end (`:996`), `viewReview()` forecast buckets (`:1793`). Key
  arithmetic after that (`fromKey`, `+DAY_MS`) stays in UTC; it only steps keys.

**Test first** (`dashboard.test.ts`): with `TZ=Asia/Kolkata` for the process
under test, an attempt stored at `2026-10-03 19:30:00` (UTC, = 01:00 IST on
10-04) appears in `daily` under `2026-10-04`. Fails on `main`. If setting `TZ`
in-process does not reach SQLite, spawn the server with `TZ` in its env instead.
Browser test: with the page's clock fixed to 01:00 IST and an answer that local
day, `streaks().current` counts today.

## Stage 2 — Streak card

Replace the folded "Practice history" with an open card placed **right after
the tiles and the next step**, before "Answers, last 30 days". Delete the fourth
**Streak** tile (the card is the streak now); the tiles row keeps Accuracy,
Mastered, Due now. Delete the `learn:heat` fold. An old `eklavya-dash-folds`
entry for it is ignored, nothing to migrate.

### Layout

```
┌──────────────────────────────────────────────────────────────┐
│ 12 day streak                        LONGEST STREAK | 31 DAYS │
│ Answer one today to make it 13.                              │
│   ‹  Oct      Nov      Dec   …                    Sep     ›   │
│ Mon ▢ ▢ ▢ ■ ■ ▣ ▣ …                                           │
│ Wed …                                                         │
│ Fri …                                                         │
│ More ■ ■ ■ ■ Less                         ▢ Current streak    │
└──────────────────────────────────────────────────────────────┘
```

| Part | Rule |
|---|---|
| Headline | `<h2>` "`N` day streak" (`1 day streak`, never "1 days"). Size and face of the tiles' `<strong>` value. `current === 0` → "No streak yet". |
| Right label | Micro-label style of `.tile b`: "Longest streak \| `best` days". Hidden when `best === 0`. Below 560 px it wraps under the headline. |
| Sub-line | Only when today has no answer and `current > 0`: "Answer one today to make it `current + 1`." When `current === 0` and `best > 0`: "Your longest was `best` days." Nothing else. Colour `--dim`. |
| Grid | `chartHeatmap()` as today: `CELL 13`, `GAP 3`, week columns, Mon/Wed/Fri labels, month labels, window picked from width (12–53 weeks). |
| Steps | Day total `t > 0` gets step `s = min(4, ceil(4 * t / max))` over the **visible window's** max. Fill: `color-mix(in srgb, var(--spot) P%, var(--mass))` with P = 30 / 55 / 80 / 100 for s = 1..4. Empty past day `var(--mass)`; future `transparent`. Drop `fill-opacity`. |
| Current streak | Every cell in the current run gets `stroke="var(--ink)" stroke-width="1.5"` (inset by drawing the rect 0.75 px smaller each side so cells do not touch). Its `<title>` gains " · current streak". |
| Cell title | `<date> — N answers (M right)` where M = `passed + corrected`, so the calendar agrees with the Accuracy tile after #116 (today it shows `passed` only, `:1331`). Empty day: `<date> — nothing`. |
| Legend | Bottom row, left: "More", four 10 px squares at steps 4→1, "Less" (matches the screenshot's order). Right: a 10 px hollow square with the same stroke, "Current streak". `--faint`, 12 px. |
| Arrows | `<button>`s ‹ and › at the ends of the month-label row, `aria-label` "Earlier weeks" / "Later weeks". Shown only when the window holds fewer than 53 weeks. ‹ moves the window back by its own width; › forward; › disabled at the current week, ‹ disabled once the window's first day is ≥ 365 days back. Offset lives in a module variable, reset to 0 on every `render()` (a view offset, not a filter, so not in the URL). Redraw only the SVG, not the page. |
| Empty | No answers ever: headline "No streak yet", sub-line "Answer one question to start one.", the grid still draws (all `--mass`). |
| Scope | Uses `dailyInScope()`, so a selected project shows that project's streak, as the tile did. |

### Tests (`dashboard-browser.test.ts`)

- The card is the first `.card` after `.stats` on `#/learning/dashboard`; no `[data-fold="learn:heat"]`; three tiles.
- Fixture with a 3-day current run and a 5-day older run: headline "3 day streak", label "Longest streak | 5 days", exactly 3 outlined cells.
- Today empty, yesterday active: sub-line reads "make it 4".
- Steps: day totals 1 and `max` map to steps 1 and 4.
- A day with one right answer and one corrected miss: its title says "(2 right)".
- At 560 px: ‹ is enabled, clicking it changes the first month label; › is disabled before it and enabled after; both reachable by Tab and work with Enter.
- At 1280 px with the 53-week window: no arrows.
- Both grounds: the outline is visible (stroke resolves to `--ink`).

## Stage 3 — Start-review commands

### 3a. Spike first (no commit)

Run `claude "/eklavya:quiz <a-real-due-slug>"` in a project on the installed
Claude Code. Confirm the quiz starts (the plugin's quiz skill runs) rather than
the text being sent as a plain prompt. If it is sent as plain text, the model
still has the skill available; confirm it calls `get_session_quiz_plan` with
`slugs`. If neither happens, stop and tell the maintainer: the fallback is to show
`cd …` and, separately, `/eklavya:quiz …` to paste inside Claude.

### 3b. One helper, three places

One function in `dashboard.html`, `startCommand(concepts)`:

- Group the given concepts by `pid(c.repo)`. For each group take the project
  `p = projectById(id)`.
- Slugs: due concepts, most overdue first, at most 20 per command (slugs are
  already normalised kebab-case; assert `/^[a-z0-9-]+$/` and drop any other).
- Command when `p?.path && p.available`:
  - macOS/Linux: `cd '<path>' && claude "/eklavya:quiz <slugs>"`, the path in
    single quotes with `'` written as `'\''`.
  - Windows (`navigator.userAgent` contains `Windows`): `Set-Location -LiteralPath '<path>'; claude "/eklavya:quiz <slugs>"`, `'` written as `''`.
- Otherwise (no project, path gone): `claude "/eklavya:quiz <slugs>"` with the
  caption "Run it inside the project you want these answers counted in."
- Returns `[{ name, count, command, note }]`.

Render each as a `.next` block: a line "**`name`** · `count` due", the command in
a `<code>` well (`--code-bg`, mono, horizontally scrollable, never wrapping
mid-path), and a **Copy** `<button>` right of it. Copy uses
`navigator.clipboard.writeText`; the label becomes "Copied" for 1500 ms and a
visually hidden `aria-live="polite"` region says "Command copied". If the write
rejects, select the `<code>` text instead and say "Press ⌘C to copy" (`Ctrl+C`
on Windows). Under the block, one `--dim` line: "Each run asks up to your
questions-per-task limit, most overdue first. Run it again for the rest."

**Where:**

| Place | What changes |
|---|---|
| Review queue (`viewReview`, replaces the text at `:1834`) | Heading "Start your reviews", then one block per project with due concepts (one block when a project is selected). Order: most due first. |
| Concept page (`viewConcept`, after the tiles) | When `c.due`: one block, heading "This one is due", command for this slug only. Not shown for concepts that are learning but not due, mastered, or never asked. |
| Learning next step (`:1566-1569`) | Text becomes "**N concepts are due.** Open the review queue for the command to run." Drop the bare `/eklavya:quiz`, which runs in whatever folder the learner is in. |

### Tests

- Unit-style (browser, `page.evaluate`): path `/Users/a b/it's` → `cd '/Users/a b/it'\''s' && …`; Windows UA → `Set-Location -LiteralPath '…it''s'; …`; 25 due → 20 slugs; unavailable project → no `cd`, caption present; a slug with a space is dropped.
- Review queue with due in two projects: two blocks, ordered by count.
- Concept page: block present only when due.
- Copy: clicking writes the exact command (grant `clipboard-read`/`clipboard-write` in the Playwright context and read it back); a rejected write selects the text.
- Learning next step no longer contains `/eklavya:quiz`.

## Strings

| Where | Text |
|---|---|
| Streak headline | `N day streak` · `1 day streak` · `No streak yet` |
| Streak label | `Longest streak \| N days` |
| Streak sub-line | `Answer one today to make it N.` · `Your longest was N days.` · `Answer one question to start one.` |
| Legend | `More` `Less` · `Current streak` |
| Arrows | aria `Earlier weeks`, `Later weeks` |
| Review queue | `Start your reviews` · `<project> · N due` · `Copy` / `Copied` · `Run it inside the project you want these answers counted in.` · `Each run asks up to your questions-per-task limit, most overdue first. Run it again for the rest.` |
| Concept page | `This one is due` |
| Next step | `N concepts are due. Open the review queue for the command to run.` |

Removed: the Streak tile, the "Practice history" fold and its hint, "Run `/eklavya:quiz` in Claude Code to work through them."

## Data and migrations

None. No new payload fields, routes or config keys. The only server change is
the day grouping in Stage 1.

## Tests the gate expects

- Server: `daily` groups by local day (`dashboard.test.ts`).
- Browser: local "today", the streak card (placement, counts, outline, steps, arrows, empty, both grounds), the start commands (quoting, grouping, cap, fallback, copy, placement) (`dashboard-browser.test.ts`).
- `npm run coverage` at 100%.

## Acceptance

```bash
cd mcp && npm run build && node dist/cli.js dashboard --port 41799 --no-open
```

Run against the test fixture's temp home, or against a **copy** of your own
database via `EKLAVYA_DB`.

1. Open `http://127.0.0.1:41799/`. Right under the tiles: "N day streak", the longest streak on the right, the calendar open, cells of the current run outlined, More/Less and Current streak legend. No "Practice history" fold. Three tiles.
2. Hover a cell: its date, answer count, and "current streak" on outlined cells.
3. Narrow to 560 px: ‹ › appear; ‹ moves to earlier months; › stops at this week; Tab + Enter work on both.
4. With `TZ=Asia/Kolkata`, an answer given at 01:00 local counts today, not yesterday.
5. Click **Due now** → review queue: "Start your reviews", one block per project with the right count, a command that starts with `cd '<that project's path>'`.
6. Click **Copy**, paste in a terminal, run it: Claude Code opens in that project and starts asking about those concepts. Answer one; reload the dashboard: the due count drops by one.
7. Open a due concept: "This one is due" with a one-slug command. A mastered concept shows no block.
8. Select a project in the sidebar: the streak and the queue show only that project.
9. Check at 1280, 900 and 560 px in both grounds; DevTools Network shows nothing leaving `127.0.0.1`.

## Docs to update in the same PR

- Manual `dashboard` (`web/src/content/docs/docs/dashboard.mdx`): row at `:80`
  (streak card up front; the calendar is no longer folded; three tiles), row at
  `:82` (the queue gives a command per project to copy), row at `:156` (a due
  concept shows its own command), `:70` next-step wording. Add a short
  **Streak** note: what counts as an active day (any answer), local days, the outline.
- Manual `commands` (`commands.mdx` `/eklavya:quiz [topic]`): add the concept-slug
  form, that it works from any folder, and that a bare `/eklavya:quiz` reviews only
  the current project's backlog.
- Landing `web/public/index.html:731` (list item: streak calendar up front, review
  queue hands you the command) and the dashboard mock tile at `:758` (drop or
  replace the Streak tile so the mock matches three tiles).
- `README.md:42` dashboard row: one sentence on the streak card and copyable review command.
- `mcp/README.md` dashboard paragraph: one sentence, same claim.
- `.claude/skills/eklavya-dashboard/SKILL.md` "Adding a chart": `chartHeatmap`
  now has four steps, the current-streak outline and paging; day keys are local
  (`todayKey()`, `'localtime'` on the server).

## Decisions taken for the user (change here if wrong)

1. **Copy command, not answering in the dashboard.** The maintainer chose this. Rejected: answering in the dashboard via `claude -p` (10–30 s per question, loses the code context the tutor grounds questions in, a tutor change needing eval evidence); re-asking the stored question (breaks "never the same question twice", and a remembered answer is not recall); an "Open in terminal" button (the local server would launch processes, per-OS code). Open a follow-up issue for the terminal button only if copy-paste proves clunky.
2. **The command `cd`s into the concept's last project.** Answers and levels are per project, so this counts the answer where the miss happened. Cost: a concept asked in two projects goes to the latest one only.
3. **Slug form `/eklavya:quiz <slugs>`, capped at 20 per command.** It works anywhere and puts due first. Cost: each run asks `max_questions_per_task` (default 4), so a long queue needs several runs; the caption says so.
4. **Active day = any answer** (right, missed, skipped or corrected). The maintainer chose this; it is what `streaks()` counts today.
5. **Days are local, not UTC.** Fixes the IST midnight–5:30 gap. Cost: a learner who changes time zone may see one day shift.
6. **Streak tile removed, card at the top of Learning only.** Two streak displays on one screen say the same thing twice. Not added to other pages.
7. **Colour steps relative to the visible window's busiest day.** Wispr-like and simple. Cost: one huge day pales the rest; a fixed scale has no defensible thresholds yet.
8. **Arrow offset is not in the URL.** It is a view position, not a filter. Cost: a shared link opens at the current weeks.
9. **POSIX single-quoted paths; PowerShell form on Windows only.** `cmd.exe` is not covered. Cost: a `cmd.exe` user edits the `cd`.
10. **Corrected misses count as "right" in the calendar's hover text.** This matches the Accuracy tile, which counts corrections as right since #116. Cost: the calendar no longer shows first-try passes on their own; the concept page still lists corrections separately.
