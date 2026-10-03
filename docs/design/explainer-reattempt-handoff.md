# Explainer reattempt ("Correct your answer") — design handoff

- **Base:** `main` @ `4aeba6e` (branch `feat/explainer-reattempt`)
- **Previous briefs:** none; this is the first `docs/design/` handoff.
- **Design source:** this brief; visual rules from `.claude/skills/eklavya-design/SKILL.md`
  and `.claude/skills/eklavya-dashboard/SKILL.md`. No Figma.

## Agent preamble

Follow the root `CLAUDE.md` and `mcp/CLAUDE.md` before editing anything; read
`mcp/src/hooks/CLAUDE.md` only if you touch a hook (this brief does not need
one), and `web/CLAUDE.md` before the docs stage. Load `eklavya-dashboard` and
`eklavya-design` before any UI work, and `verify-docs` before opening the PR.
Tests run against a temporary `EKLAVYA_HOME` / `EKLAVYA_DB`, never the real
learner database.

## The feedback, verbatim intent

1. A missed or skipped question produces an explainer page. After reading it the
   learner knows the answer, but their stats still say "wrong". Let them answer
   again from the same page.
2. At the end of the explainer, a **Correct your answer** button opens a modal
   that blurs everything behind it and shows the question with selectable
   options, the same shape as the in-session question.
3. Right pick: the explainer is marked done (green). Wrong pick: an inline
   message, "Still incorrect. Please correct your answer.", and they try again.
4. Closing the page before correcting triggers a browser-level "leave?" prompt,
   with the note that it can be done later from the dashboard.
5. A correction changes the stats; the original miss is fixed in what the
   learner sees.
6. Only explainers that came from a missed question get this.
7. Every try is recorded: wrong on try 1, wrong on try 2, right on try 3.
8. The option explanation line shown under each option in the in-session
   question (AskUserQuestion's `description`) is missing from the explainer.
   Show it there too.
9. The dashboard starts writing, not only reading. Build the write path so the
   next write feature reuses it instead of re-implementing it.

## What the investigation found (read before designing anything)

| Fact | Where | Consequence |
|---|---|---|
| The right answer is **never stored**. `record_attempt` stores `answer`, `options` (labels only) and `grade`; the tutor hands the right answer to the explainer from its own context. | `mcp/src/tools/record_attempt.ts` input schema; `recordAttemptRow` `mcp/src/store.ts:108` | The server cannot grade a reattempt today. Store `correct` and the option notes at record time. |
| Option descriptions (`description` per AskUserQuestion option, required by `skills/tutor/references/writing-mcq.md` step 4) are **dropped** at record time. | `record_attempt.ts` `options: string[]` | Item 8 needs them persisted, or neither the page nor the modal can show them. |
| The explain block carries no attempt id. | `explain` object in `record_attempt.ts` handler | The page cannot be linked to the attempt it corrects. |
| `eklavya artifacts open` opens the **file path** (`file://`), not the dashboard. | `artifactsCommand` `mcp/src/cli.ts:1056` → `openInBrowser(file)` | A `file://` page has no route to the database. The reattempt must run on the dashboard origin. |
| Served artifacts are **sandboxed** (opaque origin) on purpose: agent-written HTML must not read or write the API. | `ARTIFACT_CSP` `mcp/src/dashboard.ts:1329` | The reattempt UI cannot live inside the agent's HTML. It must be dashboard-owned code around it. |
| `send()` always spreads `SECURITY_HEADERS`, which include `x-frame-options: DENY`; `ARTIFACT_CSP` has `frame-ancestors 'none'`. | `send` `mcp/src/dashboard.ts:1366`, `SECURITY_HEADERS`, `ARTIFACT_CSP` | The dashboard cannot frame an artifact today. Both must allow `'self'` for `/artifacts/` only. |
| There is exactly one write route, `POST /api/settings`, with its guard (loopback Origin, JSON, per-start token, 256 KiB cap) inlined in `postSettings`. The 405 text says "Only /api/settings accepts a write". | `startDashboard` `mcp/src/dashboard.ts:1419-1500` | Item 9: lift the guard into one function and a route table. |
| The page's only write is `saveSetting`, with the token read and `fetch` inlined. | `mcp/src/assets/dashboard.html:2737` | Item 9: one `postJson` helper, used by Settings and the reattempt. |
| A browser's `beforeunload` prompt **cannot show custom text** (Chrome, Firefox and Safari all show their own generic "Leave site?"), and Chrome shows it only after the user has interacted with the page. | Platform behaviour | Item 4's wording goes in the page next to the button, not in the prompt. |
| A passing row after a miss changes three things the learner did not earn by recall: the session gate (`countAnswered` `store.ts:290`), level progress (`levelCounts` `store.ts:859`), and the owed/retry pool (`OWED_SQL` `store.ts:665`). | `store.ts` | A correction row must be excluded from all three, or reading the page clears a commit gate or buys a promotion. |

## Delivery order

One PR, one or more commits per stage, conventional commits (`feat:` for
stages 1-5, `docs:` for stage 6). After every stage run, from `mcp/`:

```bash
npm run build
npm test
npm run coverage
```

All must pass at 100% coverage. Stage 6 also runs `npm run build` in `web/`
(includes the SEO audit) and `/verify-docs`.

1. Storage: migration 019 and the store functions.
2. `record_attempt` captures the right answer and option notes, returns `attempt_id`.
3. Reusable write path on the server and the page; settings moved onto it.
4. Reattempt endpoints.
5. Dashboard UI: explainer viewer, modal, gallery state, `artifacts open` routing; explainer template and agent.
6. Docs.

## Stage 1 — Storage (migration 019)

`mcp/src/migrations/019_attempt_corrections.sql`. Comment it in the house style
(why each column exists, what NULL means).

```sql
ALTER TABLE attempts ADD COLUMN correct TEXT;        -- the right option's label; NULL = not recorded (all rows before 019)
ALTER TABLE attempts ADD COLUMN option_notes TEXT;   -- JSON array parallel to `options`; the one-clause description per option
ALTER TABLE attempts ADD COLUMN retry_of INTEGER REFERENCES attempts(id); -- set only on a correction row

CREATE TABLE IF NOT EXISTS attempt_retries (
  id         INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),  -- the original missed attempt
  picked     TEXT NOT NULL,
  correct    INTEGER NOT NULL CHECK (correct IN (0,1)),
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempt_retries_attempt ON attempt_retries(attempt_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_retry_of ON attempts(retry_of) WHERE retry_of IS NOT NULL;
```

Rules:

- **Every try** goes in `attempt_retries` (item 7). Try number = row order per `attempt_id`.
- **Only the right try** also writes an `attempts` row through `gradeConcept`, with
  `retry_of = <original id>`, `grade = 3` (`PASSING_GRADE`), `format = 'mcq'`,
  `outcome = 'answered'`, the original's `question`, `options`, `option_notes`,
  `correct`, `difficulty`, `repo`, `level` and `session_id`. Mastery moves by SM-2 as for any pass.
- Wrong tries do **not** call `gradeConcept`: the original miss already cost the
  grade; charging each extra click would punish reading the page.
- The unique index makes "corrected twice" impossible at the database layer.
- The original row is never updated. History stays what happened.

Exclusions (add `AND retry_of IS NULL` / `a.retry_of IS NULL`):

| Query | Location | Why |
|---|---|---|
| `countAnswered` | `store.ts:280-296` | A page read must not clear a commit gate. |
| `levelCounts` | `store.ts:853-866` | A page read must not buy a level promotion. |
| `OWED_SQL` | `store.ts:665` | Keep the missed concept in the review backlog; SM-2 still brings it back for real recall. |
| `hasAskedQuestion` recent-question scan | `store.ts:~450` | No change needed: the correction repeats the same stem, which is already recorded. Leave it; note why in a comment. |

New store functions in `store.ts` (pure DB, explicit `now`):

- `correctionTarget(db, attemptId)` → `{ id, concept, question, options, option_notes, correct, tries, corrected_at } | null`; null when the row does not exist.
- `recordRetry(db, attemptId, picked, now)` → `{ correct: boolean, tries: number, corrected: boolean }` in one transaction. Throws typed errors: `not_found`, `not_correctable` (`correct` or `options` NULL, or `retry_of` itself set), `already_corrected`, `not_an_option` (`picked` not in `options`, exact string match).

Tests: `mcp/test/migrate.test.ts` (`LATEST_SCHEMA_VERSION = 19`, new table and
columns); a new `mcp/test/corrections.test.ts`: wrong → right writes 2 retries
and 1 attempt row with `retry_of`; a second right is `already_corrected`;
`countAnswered`, `levelCounts` and `OWED_SQL` ignore the correction row (write
the failing test first for each); legacy row (NULL `correct`) is `not_correctable`.

## Stage 2 — `record_attempt` captures the answer key

`mcp/src/tools/record_attempt.ts`:

| Input | Schema | Rule |
|---|---|---|
| `correct` | `z.string().max(LIMITS.option).optional()` | For mcq: the right option's label exactly as offered. |
| `option_notes` | `z.array(z.string().max(LIMITS.option)).max(LIMITS.options).optional()` | The `description` under each option, same order as `options`. |

- If `correct` is given and not in `options`: store NULL and return
  `correct_mismatch: "<one line telling the tutor to pass the label verbatim>"`.
  Never reject the attempt (the answer is real; losing it is the worse trade).
- If `option_notes.length !== options.length`: store NULL, return `option_notes_mismatch`.
- Return `attempt_id` always (the id of the row just written). `recordAttemptRow`
  returns `lastInsertRowid`; `gradeConcept` passes it through.
- `explain` gains `attempt_id`, `correct`, `option_notes`. `explainInstruction`
  adds: pass `--attempt <attempt_id>` to `eklavya artifacts new`, and copy each
  option's note under it.
- Update the tool `description` and `skills/tutor/references/writing-mcq.md`
  "Recording it": pass `correct` and `option_notes` with every mcq.

Tests: `correct`/`option_notes` stored; mismatches stored as NULL with the
warning; `attempt_id` returned; `explain` carries the three new fields.

## Stage 3 — One write path (item 9)

**Server, `mcp/src/dashboard.ts`.** Lift the body of `postSettings` into:

```ts
type WriteHandler = (db: DB, body: unknown) => { status: number; body: Record<string, unknown> };
const WRITES: Record<string, { handler: WriteHandler; maxBytes: number }> = {
  '/api/settings': { handler: updateSetting, maxBytes: MAX_SETTINGS_BODY },
};
function acceptWrite(req, res, route): void // loopback Origin, JSON, token, size cap, parse, then route.handler
```

- Same four checks, same status codes and messages as today (403 / 415 / 403 / 413 / 400).
- Routing: `const w = WRITES[url.pathname]; if (w && req.method === 'POST') return acceptWrite(req, res, w);`
- The 405 text becomes `This route is read-only. Writes: <list WRITES keys>.` and
  `allow` includes `POST` for any `WRITES` key.
- Update the file header and the `mcp/CLAUDE.md` "Memory and local pages"
  paragraph: the dashboard is read-only except the routes in `WRITES`, all
  through `acceptWrite`.
- Path parameters: none. Every write carries its target in the JSON body, so the
  table stays an exact-match map.

**Page, `mcp/src/assets/dashboard.html`.** One helper near `saveSetting`:

```js
/** Every write the page makes. Rejects with the server's own error text. */
function postJson(path, body) { /* token from meta[name=eklavya-token], fetch POST, parse, throw Error(d.error) on !ok */ }
```

`saveSetting` calls it; no other `fetch(... method: 'POST')` remains in the page.

Tests (`dashboard.test.ts`): existing settings write tests pass unchanged
(proves no behaviour change); a table-driven test runs the four guard failures
against **every** `WRITES` route, so a new route inherits the coverage.

## Stage 4 — Reattempt endpoints

| Route | Method | Body / query | Returns |
|---|---|---|---|
| `/api/attempts/correction?id=<attempt id>` | GET | — | `{ id, concept, question, options, option_notes, tries, corrected_at }`. **No `correct`**: the server grades. 404 unknown, 409 `not_correctable`. |
| `/api/attempts/retry` | POST (`WRITES`) | `{ attempt_id: number, picked: string }` | 200 `{ correct, tries, corrected }`; 400 `not_an_option`/bad body; 404; 409 `already_corrected`/`not_correctable`. |

- Handler `retryAttempt(db, body)` validates types, then calls `recordRetry` with `new Date()`.
- `/api/state` artifacts rows gain `attempt: number | null` and
  `correction: 'open' | 'done' | null` (null = not correctable: no attempt meta,
  legacy row, or plain artifact). One query keyed on the attempt ids found, not one per row.

Tests: both routes, each status; `correct` never appears in the GET body; a
retry through the HTTP server lands one `attempt_retries` row.

## Stage 5 — UI

### 5a. Link the page to its attempt

- `eklavya artifacts new ... --attempt <id>` (positive integer, else fail with
  usage). `createArtifact` writes `<meta name="eklavya:attempt" content="<id>">`
  (new `{{ATTEMPT}}` placeholder in `artifact-template.html`, empty when absent).
  `listArtifacts` reads it into `ArtifactRow.attempt: number | null`.
- `eklavya artifacts open <path|id>`: if the page has an `eklavya:attempt`, run
  `ensureDashboard()` (`dashboard-daemon.ts:156`); on `running|started|replaced`
  open `http://127.0.0.1:<dashboardPort()>/#/artifacts/view/<encoded id>`,
  otherwise fall back to the file as today. Print whichever was opened. Pages
  without the meta keep opening the file (unchanged).

### 5b. Allow framing, only for artifacts

`/artifacts/` responses: `ARTIFACT_CSP` uses `frame-ancestors 'self'` and the
response overrides `x-frame-options: SAMEORIGIN`. Everything else keeps `DENY`.
The sandbox directive stays. The `<iframe>` also carries
`sandbox="allow-scripts allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox"`
(no `allow-same-origin`, ever). Test: header values on `/artifacts/x` vs `/`.

### 5c. Explainer viewer page — `#/artifacts/view/<id>`

New page in the `artifacts` workflow registry (`dashboard.html:2844`), not in
the sidebar groups (it is reached by link). Layout, top to bottom:

1. The standard dashboard chrome (top bar), so "later from the dashboard" is one click away.
2. `<iframe>` of `/artifacts/<id>`, full content width, no border, height from
   the page's own `postMessage` (below). Fallback when no message arrives within
   1500 ms: `height: 80vh`, iframe scrolls internally.
3. **Correction bar**, directly after the iframe, only when `correction` is not null:

| State | Content |
|---|---|
| `open` | Primary button **Correct your answer**. Under it, `--dim` text: "Not now? Correct it later from Dashboard → Artifacts." |
| `done` | `--spot` check icon + "Corrected on try N" + date. No button. |

The iframe height message: `artifact-template.html` gets a 6-line script that
posts `{ type: 'eklavya:height', h: document.documentElement.scrollHeight }` to
`parent` on load and on `ResizeObserver` changes. The parent accepts it only when
`e.source === iframe.contentWindow` and `type` matches, clamps `h` to
`[200, 20000]`. Explainers written before this change send nothing and get the fallback.

### 5d. The modal

Native `<dialog>` opened with `showModal()` (focus trap, `Esc`, top layer for free).

- `::backdrop`: `backdrop-filter: blur(6px)` plus `color-mix(in srgb, var(--ink) 40%, transparent)`.
- Width `min(560px, 100vw - 32px)`; square corners; hairline border `var(--line-2)`; no shadow.
- Content: eyebrow "Correct your answer", the stem (same type scale as the
  artifact's question `<h2>` section), then one `<button>` per option as a
  radio-style row: label on line 1, its `option_notes` entry on line 2 in
  `--dim` at the small size — the same two-line shape as AskUserQuestion.
- **Option order is shuffled** each time the modal opens. The page above shows
  the right answer at its original letter; shuffling makes the learner read the
  text instead of remembering a position. The server grades by label.
- Pick → disable all options, `postJson('/api/attempts/retry', …)`:
  - **Right**: picked row turns `--spot` / `--spot-soft` with label "Right answer";
    a line "Corrected. Your stats now count this as answered." ; one **Close**
    button gets focus. Closing re-renders the bar in `done`.
  - **Wrong**: picked row gets `--error` border, label "Not this one", stays
    disabled for the rest of this modal session; other options re-enable.
    Inline message in the modal footer, `role="status"`:
    **"Still incorrect. Please correct your answer."** It stays until the next pick.
  - **Error** (network, 409): message in the same slot, `--warning`, the server's text.
- Motion: 180 ms opacity + 8 px translate-y on open, ease-out, no overshoot;
  `prefers-reduced-motion` → none.
- Keyboard: arrow keys move between options, Enter/Space picks, Esc closes
  (counts as "not now").

### 5e. Leaving before correcting

While `correction === 'open'`, add a `beforeunload` listener that calls
`preventDefault()`; remove it the moment the retry returns `corrected`. Browsers
show their own generic prompt (custom text is not possible), so the user's
sentence lives in the bar's note from 5c. No prompt for `done`, legacy or plain artifacts.

### 5f. Gallery and stats

- `artifactCard` (`dashboard.html:2473`): explainers with `correction` link to
  `#/artifacts/view/<id>` instead of the raw `/artifacts/<id>`, and show a tag:
  `To correct` (`--warning`) or `Corrected` (`--spot`). New chip
  `To correct` next to `Explainers` in the filters; it lives in the hash like the others.
- Daily answers chart (`dashboard.ts:750-762`): a missed or `dont_know`
  attempt whose correction exists counts as a new `corrected` segment, not
  `missed`/`skipped`; correction rows themselves are not counted (no double
  count). Segment colour `var(--spot-soft)` with `var(--spot)` hairline,
  legend "Corrected". Update the `aria-label`.
- Concept table counts (`dashboard.ts:784-789`) exclude `retry_of` rows from
  `attempts` and `passed`, and add `corrected` (count of correction rows).

### 5g. Explainer content consistency (item 8)

- `agents/explainer.md` "The question": under each option, its note as
  `<span class="note">…</span>`; pass `--attempt <id>` in step 3 when handed one.
- `artifact-template.html`: `ol.options li .note { display:block; color:var(--dim); font-size:var(--small size used by the template); margin-top:2px }`.
- `user-skill/eklavya-artifacts/SKILL.md` line ~82: document `.note`.
- `skills/tutor/SKILL.md` explain paragraph: hand the explainer the attempt id
  and option notes.

Tests: `artifacts.test.ts` (`--attempt` meta written and read, bad value
refused); `cli.test.ts` (`open` routes to the dashboard URL when the meta is
present and the daemon answers, falls back to the file otherwise);
`dashboard-browser.test.ts`: open the viewer, wrong pick shows the message and
disables that option, right pick shows Corrected, bar flips to `done`, the
gallery tag flips, `beforeunload` is armed only while `open`.

## Strings

| Where | String |
|---|---|
| Bar button | Correct your answer |
| Bar note | Not now? Correct it later from Dashboard → Artifacts. |
| Bar done | Corrected on try {n} · {date} |
| Modal eyebrow | Correct your answer |
| Wrong pick message | Still incorrect. Please correct your answer. |
| Wrong option tag | Not this one |
| Right option tag | Right answer |
| Success line | Corrected. Your stats now count this as answered. |
| Gallery tags / chip | To correct · Corrected |
| Chart legend | Corrected |

## Data and migrations

- Adds migration 019: `attempts.correct`, `attempts.option_notes`,
  `attempts.retry_of`, table `attempt_retries`, two indexes.
- Adds artifact meta `eklavya:attempt`.
- Adds routes `GET /api/attempts/correction`, `POST /api/attempts/retry`;
  `/api/state` artifact rows gain `attempt`, `correction`.
- No config key. (A dial to switch corrections off is not requested; skip it.)
- Usage ping: no new field (if `telemetry.ts` counts attempts by grade, check that
  correction rows do not inflate it; exclude `retry_of` rows if they would).

## Tests the gate expects

- Migration: version 19, new columns and table (`migrate.test.ts`).
- Store: retry bookkeeping, unique correction, gate/level/owed exclusions (`corrections.test.ts`).
- Tool: `correct`, `option_notes`, mismatches, `attempt_id`, explain fields (`record_attempt` tests).
- Write path: guard failures for every `WRITES` route; settings unchanged (`dashboard.test.ts`).
- Endpoints: each status, no answer leak (`dashboard.test.ts`).
- Framing headers per route (`dashboard.test.ts`).
- CLI: `--attempt`, `open` routing and fallback (`cli.test.ts`, `artifacts.test.ts`).
- Browser: modal flow, bar states, gallery tag, `beforeunload` (`dashboard-browser.test.ts`).
- `npm run coverage` at 100% on every metric.

## Acceptance

Run against a temp home: `EKLAVYA_HOME=$(mktemp -d)`, then the live loop in
`CONTRIBUTING.md` "Live learning-loop acceptance".

1. Miss an mcq in a session with `explain_on_wrong` on. The explainer opens at
   `http://127.0.0.1:<port>/#/artifacts/view/…`, not `file://`.
2. Each option on the page shows its one-line note under the label.
3. The page scrolls as one document; the **Correct your answer** bar sits after the content.
4. Click it: the background blurs, the options appear in a different order with their notes.
5. Pick a wrong one: "Still incorrect. Please correct your answer." appears; that option is disabled.
6. Pick the right one: Corrected; Close; the bar reads "Corrected on try 2".
7. `sqlite3 "$EKLAVYA_HOME/eklavya.db" "select attempt_id, picked, correct from attempt_retries"` shows two rows; `attempts` has one new row with `retry_of` set and grade 3.
8. Dashboard → Artifacts shows the page tagged Corrected; the daily chart shows a Corrected segment for that day.
9. With an enforced gate open, the correction does not change `get_gate_status`.
10. Miss another question, open its explainer, interact, close the tab: the browser's leave prompt appears. After correcting, closing shows no prompt.
11. An explainer written before this change opens as before, with no bar.
12. Check the viewer and modal at 1280, 900 and 560 px in both themes.

## Docs to update in the same PR

- Manual `dashboard` (viewer, correction bar, To correct chip, Corrected chart segment), `commands` and `cli` (`artifacts new --attempt`, `open` now uses the dashboard), `grading-engine` (correction grade 3, excluded from gate and level, kept in the review backlog), `how-it-works` (missed question → explainer → correction), `your-data` (`attempt_retries`, new columns).
- Landing page: one source-backed sentence where explainers are described.
- `README.md` and `mcp/README.md`: `record_attempt` new fields and `attempt_id`; the dashboard now has writes.
- `mcp/CLAUDE.md` read-only paragraph (stage 3); `agents/explainer.md`, `skills/tutor/SKILL.md`, `skills/tutor/references/writing-mcq.md`, `user-skill/eklavya-artifacts/SKILL.md`.
- Any diagram showing the explainer flow (check `web/` for `DocFlow` usages that mention the explainer).

## Decisions taken for the user (change here if wrong)

1. **A correction is a pass at grade 3 and moves mastery, but does not count toward the commit gate, level promotion or clearing the review backlog.** Cost: the level accuracy bar still includes the original miss. Reason: picking the right option right after reading it is recognition, not recall; counting it toward gates and promotions lets anyone clear a gate by reading the page. The review backlog still re-asks the concept later, which is the real fix.
2. **The original wrong row is kept; the dashboard shows it as "Corrected" instead of "Missed".** Cost: raw SQL counts still see the miss. Reason: rewriting history would make level counts drift from their evidence (the reason `levelCounts` derives from rows).
3. **Wrong tries are logged but do not lower the grade again.** Cost: brute-forcing four options is free. Reason: the page already shows the answer; punishing extra clicks only discourages reading.
4. **The reattempt runs in a dashboard viewer that frames the sandboxed page; the agent's HTML never gets write access.** Rejected: injecting the widget into the artifact (agent HTML could forge writes); `postMessage` from the artifact to a parent writer (same forgery risk); keeping `file://` (no route to the database).
5. **The leave prompt is the browser's generic one; our sentence is shown in the bar.** Browsers do not allow custom text. Chrome also skips the prompt if the page was never interacted with.
6. **Option order is shuffled in the modal.** Cost: differs from the order on the page. Reason: otherwise the answer is "the letter marked green above".
7. **Skipped (`dont_know`) questions are correctable; declined ones never produce an explainer, so they are not.** Matches `missed` in `record_attempt.ts`.
8. **Explainers made before this change get no bar** (no stored right answer). Cost: old misses stay uncorrectable. Backfilling a right answer nobody recorded would be guessing.
9. **No setting to turn corrections off.** Add one only if someone asks.
10. **Write API = one guarded `acceptWrite` + an exact-match `WRITES` table on the server, one `postJson` on the page.** No generic REST layer, no path parameters; the next write is one table row and one handler.
