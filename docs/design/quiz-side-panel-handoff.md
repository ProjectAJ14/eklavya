# Quiz side panel (Claude Code mod) — design handoff

- **Base:** `main` @ `dfec4d3` (1.51.0)
- **Branch:** `feat/quiz-side-panel-mod`
- **Issue:** [#130](https://github.com/ProjectAJ14/eklavya/issues/130), including its
  "Documentation review" addendum. The issue is the product spec; this brief decides
  the parts the issue left open and corrects two assumptions it makes about the code.
- **Previous brief:** `docs/design/review-streak-handoff.md`
- **Design source:** the two concept images in the issue. They are illustrations,
  not host UI specs. No Figma. Host reference: the Claude Code mods docs linked in
  the issue (overview, create, interface, API, reference, test). Installed Claude
  Code on the design machine: **2.1.292**.

## Agent preamble

Follow the root `CLAUDE.md`, `mcp/CLAUDE.md`, `hooks/CLAUDE.md` and `skills/CLAUDE.md`;
read `web/CLAUDE.md` before the docs stage. Load `verify-docs` before opening the PR
and `eklavya-design` before choosing colours or copy for the pane (it owns the
semantic colour roles, voice and motion rules; the pane maps them to host elements,
it does not invent a palette). Tests use a temporary `EKLAVYA_HOME` / `EKLAVYA_DB`;
`loadConfig()` reads the real config, so pin it. Preserve everything earlier briefs
established. **Mod API names in this brief come from the issue's reading of the docs,
not from the installed build. Stage 0 replaces every one of them with what
`/plugin-types` reports; where they differ, the build wins and you update this
brief's names in the PR description.**

## The feedback, verbatim intent

0. (Added after review.) The panel is experimental: ship it behind a setting,
   `quiz.panel`, **off by default**. Off means no behaviour change anywhere.

1. Eklavya questions should appear in a dedicated, branded pane beside the
   transcript, not as Claude's generic `AskUserQuestion` card.
2. One question at a time; pick an answer, then press Submit (selecting never
   grades); Skip is a separate control; "Other" free text stays.
3. Feedback (right or not, with a short why) replaces the form in the same pane.
   Correctness is stated in words, not only colour.
4. Closing the pane hides a pending question; it is neither graded nor skipped;
   reopening restores it.
5. Claude must keep working while the learner reads and answers. Verify, do not assume.
6. Same question never shows in both the pane and the old card; answers are recorded
   exactly once; errors keep the draft.
7. Automatic checkpoints and `/eklavya:quiz` share one path. No pane, no mod, or an
   unsupported host: today's `AskUserQuestion` experience, unchanged.
8. Only the quiz pane. No progress strip, settings, dashboard, gate panel.

## What the investigation found

| Fact | Where | Status |
|---|---|---|
| **The model writes the question.** The planner returns slug, tier, `answer_position`, `asked_before`, framing. The stem, four options and the one-line description under each are written by the tutor model, which then calls `AskUserQuestion`. So the pane has nothing to show until something carries the model's question to the mod. | `get_session_quiz_plan.ts:58`, `:414`, `skills/tutor/references/writing-mcq.md`, `checkpoint-quiz.ts:200` | Verified. The issue's "existing quiz planning produces its content" is not true for the text. |
| **The model also grades.** `record_attempt` persists a grade the tutor chose from `references/grading.md` (MCQ: right = 4, near-miss distractor = 2, misconception distractor = 1, hesitant "Other" = 3, free typed answer = judged, uncapped). The server only caps MCQ at 4 and rejects `declined`/`dont_know` with grade ≥ 3. | `record_attempt.ts:188` (cap), `:137` (conflict), `grading.md` | Verified. A pane that records without the model needs another evaluator; see Decisions 1–2. |
| `record_attempt` has **no idempotency key.** The SQLITE_BUSY retry is safe only because grade, promotion and gate sit in one transaction. A client retry after a lost reply would insert a second attempt row and move SM-2 twice. | `record_attempt.ts:191` (transaction), `tools/index.ts:65` (retry) | Verified. The panel needs its own once-only guard. |
| The hooks only **instruct the model** (`additionalContext`); none renders UI or takes an answer. Quiz presentation lives in four prose sites: checkpoint, stop sweep, delegation line, tutor skill. | `checkpoint-quiz.ts:200`, `stop-quiz-check.ts`, `delegation-lib.ts:31`, `skills/tutor/SKILL.md:144` | Verified. Routing = changing those four plus the planner's `ask_attribution`. |
| Quiz-while-a-builder-works already exists (`while_waiting: true`), but the *main* agent is idle then, because `AskUserQuestion` blocks the model's turn. True concurrency needs a presentation call that **returns immediately**. | `delegation-lib.ts:31`, `get_session_quiz_plan.ts:139` | Verified by reading; host behaviour is Hypothesis (Stage 0). |
| Stem stored for the repeat check goes through `stripAskHeader`; `[Eklavya]` prefixes exist only on hosts without the header chip. The pane needs neither (the pane *is* the attribution). | `ask.ts`, `surface.ts`, `store.ts:638` | Verified. Keep `stripAskHeader` on every stored stem. |
| Answer position is computed by `answerPosition(slug, askedCount)` and trusted to the model. | `mcq.ts`, `get_session_quiz_plan.ts:414` | Verified. The new call can verify it server-side. |
| Plugin manifest and hooks declare no mods today. | `.claude-plugin/plugin.json`, `hooks/hooks.json` | Verified. Where a mod is declared is a Stage 0 answer. |
| The issue says "no migration should be necessary". True for learning history, **false for the pending question**: a mod hooks module has no Node/SQLite and can lose state on reload, so the pending question, its draft phase and its once-only guard must live in the existing database. | issue "Preserve learning behavior"; `mcp/CLAUDE.md` migrations | Decision 3. Adds migration `0xx_panel_questions`, forward-only, with `migrate.test.ts` updated. |
| The issue says "Bump the plugin version". Versions move only through release tooling. | root `CLAUDE.md`, `scripts/bump-version.sh` | Do not hand-edit. A `feat:` commit releases it. |

## Delivery order

One PR. After every stage, from `mcp/`:

```bash
npm run build
npm test
npm run coverage
```

100% on every metric for TypeScript. The mod file is outside c8's reach: its
coverage is the mod test suite from Stage 3, plus the host's strict validation
(Stage 0 finds the command). Stage 5 also runs `npm run build` in `web/`,
`.github/scripts/check-docs-sync.sh`, `/verify-docs`, and the tutor before/after
eval (`npm run eval -- run --limit 8 --focus project --difficulty hard`, before
and after Stage 2; attach both runs to the PR).

0. **Spike**, no product commit. Findings recorded as dated rows in
   `docs/verified-schemas.md` (this is where observed host behaviour lives).
1. `feat:` Pending-question store, once-only answer path and bridge tools.
2. `feat:` Routing: planner capability signal, tutor/hook directives, pending guards.
3. `feat:` The mod: state machine, rendering, keyboard, lifecycle, reopen.
4. `test:` Host acceptance fixtures and failure injection (can ride Stage 3's commits).
5. `docs:` Manual, landing, READMEs, contributor docs, runtime diagram.

## Stage 0 — Spike (answers the issue's "remaining prototype decisions")

Build the smallest mod that renders a hard-coded question in a `Pane`, then answer
each row below on **terminal CLI and Desktop Code tab**, writing the result into
`docs/verified-schemas.md`. Stop and tell the maintainer if a **blocker** row fails.

| # | Question | Pass looks like | If it fails |
|---|---|---|---|
| 1 | `/plugin-types` declarations: exact names and signatures for `ui.open` (`isPlaced`, `reason`, `closeOnEscape`), `ui.render`, `Button`/`Input`/`Select`, `mcp.connect`/`mcp.call`, `state`, `prompt.submit`, `model.complete` | A mod that type-checks and passes strict validation | Rewrite this brief's names; continue |
| 2 | **Blocker.** Can the mod call this plugin's MCP server and learn the server's name in this build (plugin-scoped `plugin_eklavya_eklavya` vs `eklavya`)? | `mcp.call` returns a tool result from a loaded plugin server | Stop. No transport; do not invent a local HTTP service |
| 3 | **Blocker.** How does the mod learn a question is waiting? Candidates in order of preference: (a) a post-tool event for `present_question` (Stage 1) fires in the mod with the tool name; (b) a session/idle event; (c) the mod handles `AskUserQuestion` itself | One of (a)/(b) fires within 1 s of the call, in the right session | If only (c): stop and report; it blocks the model and defeats requirement 5 |
| 4 | **Blocker.** Concurrency: with a long-running `Bash` call and a background `Agent` both active, the pane answers and shows feedback while both keep running, and neither is paused | Tool elapsed time and agent output unaffected by the pane interaction (timestamps in the note) | Stop. The issue says to make a limitation explicit before accepting |
| 5 | Placement: `isPlaced`/`reason` for <144 columns, 110 after a manual open, Desktop, and with another mod's pane open | Each reason observed and recorded | Treat unknown reasons as unplaced |
| 6 | Is a UI event handler (Submit) subject to the 10 s hook budget? Is `model.complete` allowed inside it? | Handler can await a 15 s call | Typed-answer grading moves to Decision 2's fallback |
| 7 | Can the mod queue a prompt for the idle session without awaiting (`prompt.submit`)? | One queued prompt delivered after the turn ends, nothing awaited in the handler | Use Decision 4's fallback |
| 8 | A reopen command name that does not shadow `/eklavya:quiz` | A slash command or key binding that reopens a hidden pane | Propose the closest alternative in the PR |
| 9 | Lifecycle: `session.start` on startup, `/clear`, resume, branch; plugin reload; session end teardown | The mod can read current session and project identity on each | Reconcile through the server on every sync (Stage 3) |
| 10 | Is there a host-level per-mod disable a learner can use? | Yes, documented | Mention it in troubleshooting; `quiz.panel` is the primary switch either way |
| 11 | Where a mod is declared (plugin manifest vs `hooks/hooks.json`) and whether `hooks/run.mjs`'s background repair affects it | Strict validation passes on the installed plugin | Follow what the validator accepts |

## Stage 1 — Pending-question store, once-only answers, bridge tools

### What it does

A question becomes a row. The model creates it with one call that returns at once;
the pane reads it; one answer call grades and records it, exactly once.

**New table `panel_questions`** (migration; forward-only; add its expected columns to
`mcp/test/migrate.test.ts`):

| Column | Meaning |
|---|---|
| `id` | text, random, the question's identity and the once-only key |
| `session_id`, `repo` | originating host session and project identity, from `resolveSessionId` and `levelStanding`'s repo; every later call must match both |
| `concept_id`, `tier` | as `record_attempt`'s `slug`/`difficulty` |
| `stem` | stored after `stripAskHeader`, same as attempts |
| `options` | JSON `[{id, label, note}]` in display order; ids `o1`…`o4` |
| `key` | JSON `{correct_id, grades: {o1: 2, …}}`. **Never sent to the mod.** |
| `explanation` | the model's one-line "why" shown after the answer |
| `phase` | `pending` · `unplaced` · `grading` · `answered` · `skipped` · `expired` |
| `attempt_id` | set in the **same transaction** as the attempt row; null until then |
| `result` | JSON of the feedback payload returned to the pane, so a retry returns it verbatim |
| `created_at`, `updated_at` | UTC, for expiry |

At most **one open row** (`pending`/`unplaced`/`grading`) per session; enforce with
a partial unique index. Rows older than 24 h with no answer become `expired` on the
next read (no attempt written; an unanswered question is not a decline).

**Model-facing tool `present_question`** — replaces `AskUserQuestion` only when the
session is panel-capable (Stage 2). Input: `slug`, `question` (stem only), `options`
(four, each `{label, description, grade}`; exactly one `correct: true` at grade 4;
distractors grade 2 "right shape" or 1 "built on a misconception"), `explanation`,
`difficulty`, `session_id`, `cwd`. The server:

- rejects (error envelope, nothing stored) when the correct option is not at
  `answerPosition(slug, askedCount)`, when option labels repeat, or when an open row
  exists. Placement stays deterministic and is now enforced instead of trusted.
- stores the row and returns `{question_id, status: "presented"}` immediately. The
  model's instruction says: **do not wait, do not ask anything else, carry on with
  the task.** The verdict is the pane's job.
- applies the same stem length and option limits as `record_attempt` (`LIMITS`).

**Mod-facing tools** (descriptions begin "Called only by the Eklavya panel, never by
the model"; add them to `tools/index.ts` with `LIMITS` bounds):

- `panel_sync` `{session_id, cwd, host: {version, surface, columns?}, placed?: {question_id, ok, reason?}}`
  → registers capability (a heartbeat the planner reads, TTL 90 s) and returns the
  open row **without `key`**: `{question_id, stem, options:[{id,label,note}], phase, concept_name, tier, topic?}`
  or `{none: true}`. Also marks a row `unplaced` / back to `pending` from the `placed`
  report. Idempotent; safe to call on every lifecycle event.
- `panel_answer` `{question_id, session_id, repo, kind: "choice"|"text"|"skip", option_id?, text?}`
  → grades and records, returning `{phase: "answered"|"skipped", correct, correct_label?, explanation, level_up?, explain?, attempt_id}`.
  A second call for the same `question_id` returns the stored `result`, writes nothing.
- Typed text is graded by the mod, not the server, and handed to
  `panel_answer` as `kind: "text"` with `grade`, `outcome` (`answered`|`dont_know`),
  `feedback` set by a validated grader result (Decision 2). The server re-validates:
  grade 0–5, `dont_know` ⇒ grade 0, feedback ≤ `LIMITS.feedback`.

### Grading rules the server applies (no new rubric)

| Input | Recorded |
|---|---|
| `choice` correct | `grade 4`, `format: "mcq"`, `outcome: "answered"`, `answer` = picked label |
| `choice` distractor | its stored grade (1 or 2), `format: "mcq"`, `outcome: "answered"` |
| `text` | grader's grade 0–5, **no `format`** (free recall, uncapped), outcome from grader; `answer` = text |
| `skip` | `grade 0`, `outcome: "declined"`, no `answer`, no `feedback` |

`options`, `correct`, `option_notes`, `question`, `difficulty` pass through to the
same store write as today. Grade 3 ("right but hesitant") stays reachable only
through typed text; pane choices are 4 / 2 / 1, which is what the rubric says for a
plain pick.

### The fix at the layer every caller routes through

Extract the body of `record_attempt`'s handler into one function
(`recordAttemptCore(db, args)`, same file) that both the tool and `panel_answer`
call. Do **not** copy the cap, conflict checks, promotion, gate sync or `explain`
composition. `panel_answer` runs it and the `phase`/`attempt_id`/`result` update in
**one transaction**, so a crash or a retried call cannot yield two attempts or an
answered question without its attempt.

### Closing, hiding and the other non-answers

| Event | Effect |
|---|---|
| Pane closed / Esc / focus lost | Nothing is written. Row stays `pending`. |
| Placement fails | Row `unplaced`; the mod notifies once; reopening re-tries. No `AskUserQuestion` fallback for this question. |
| Empty text / transport error / grader failure | Nothing written; draft kept; retry offered. |
| Session cleared, project changed, question superseded | `panel_answer` with a mismatched `session_id`/`repo` returns `{error: "stale_question"}`; the mod drops the draft and syncs. |

### Tests (write the failing one first)

- Migration: table exists with the columns above; partial unique index rejects a second open row.
- Idempotency: `panel_answer` twice for one question → one attempt row, same result, SM-2 advanced once. Also under a simulated lock retry.
- Atomicity: force a throw after the attempt insert → no attempt row, phase still `pending`.
- Key secrecy: `panel_sync` output never contains `key`, `correct_id`, `grades` or the explanation before an answer.
- Placement: wrong answer position, duplicate labels, open row present → errors and nothing stored.
- Grade table above, including MCQ cap (a `text` answer is not capped; a `choice` never exceeds 4), `declined` + feedback rejected, `dont_know` ≥ 3 rejected.
- Stale: wrong session/repo, cleared session, expired row.
- Fingerprint: a stem with an `[Eklavya]` prefix is stored stripped; `hasAskedQuestion` sees it.
- Memory/learning separation: `present_question` writes no attempt; only `panel_answer` does; a pending row never changes mastery.
- Two sessions and a linked worktree each see only their own row.

## Stage 2 — Routing (one path for checkpoint and `/eklavya:quiz`)

**The setting (new in this stage, first commit of it).** `quiz.panel`: boolean,
default `false`, user and project scope like the other `quiz.*` keys. It is the only
switch that turns the panel on; the mod being installed does nothing by itself.
Follow `mcp/CLAUDE.md`'s new-key list exactly: type and comment in `config.ts`
(`QuizConfig`, `DEFAULT_CONFIG.quiz`, coercion next to `only_on_changes`), a
`'quiz.panel': bool` row in `config-path.ts`, the `quiz` object in `set_config`'s
schema and description (`tools/config_tools.ts`), a `SETTINGS` registry row in
`dashboard.ts` (group "Questions", label "Quiz side panel (experimental)", help says
it needs a supported Claude Code build and what off means), written through
`applySetting` so CLI and dashboard share one path. Update the dashboard page's
`fieldProblem` only if the key needs a new rule (a boolean does not). `dashboard.test.ts`
fails without the registry row; `config.test.ts` and `config-path` tests get the
default and the scope checks.

**Off means inert.** With `quiz.panel` false: `panel_sync` returns `{disabled: true}`
without registering a heartbeat or reading a row; the mod renders and opens nothing;
`present_question` rejects with `panel_disabled`; the plan says `presentation: "tool"`.
The learner sees today's `AskUserQuestion` flow and no notification, banner or log
line mentioning the panel.

**Capability.** With the setting on, the planner reads the `panel_sync` heartbeat for this session and adds
one field to the plan: `presentation: "panel" | "tool"`. `ask_attribution` is returned
only for `"tool"`. Default and any doubt (no heartbeat, stale, `reason` unplaced on the
last sync, subagent, Cowork) = `"tool"`. A mod being loaded is not enough; the
heartbeat must come from a host surface the Stage 0 table says accepts answers.

**Four prose sites change together** (they must agree; the planner field is the single
source):

| Site | Change |
|---|---|
| `checkpoint-quiz.ts:200` | Step 2 reads: ask with `present_question` when the plan says `presentation: "panel"`, else `AskUserQuestion`. Steps 3–5 become panel-aware: with the panel, **no `record_attempt`, no verdict, resume at once** (the pane records and says it). Exit silently (no output) when an open `panel_questions` row exists for the session. |
| `stop-quiz-check.ts` | An open row counts as the outstanding question: do not block the stop to ask another; the sweep line says one question is waiting in the pane. |
| `delegation-lib.ts:31` | "While it builds" line: `present_question` instead of ask-then-grade; the lead may keep working. |
| `skills/tutor/SKILL.md`, `references/writing-mcq.md`, `skills/quiz/SKILL.md` | New "Asking in the panel" section: same six parts, same distractor rules, the `description` becomes `option.description`, plus the per-option grade and the explanation line. One sentence on the fallback. |

**Budget and enforcement unchanged.** A presented question counts against
`max_questions_per_task` when it is answered (as attempts do today); the open-row
guard prevents a second one meanwhile. Enforced gates: the gate reads attempts, which
the pane writes through the same core, so nothing about commit blocking changes. An
open unanswered question does not clear the gate and is not a decline.

**`explain_on_wrong` and `level_up`** used to be told to the *model* in
`record_attempt`'s reply. With the pane the model never sees that reply. Do this:
the pane shows `level_up` as one line in the feedback ("You've cleared easy on
`<project>`."), and on a miss with `explain_on_wrong` it triggers the explainer by the
Stage 0 row 7 route (queued prompt carrying the existing `explainInstruction` text).
If row 7 fails, the feedback shows "Ask Claude to write an explainer for attempt
`<id>`" and the server keeps the instruction available through `panel_sync` on the
next call — never lost, never auto-run from a handler that waits.

**Eval (CLAUDE.md requires it for tutor changes):** run the question eval before
this stage and after it; plans and question quality must match. Report unfavourable
deltas too.

### Tests

- Setting: default `false`; settable at user and project scope through `eklavya config` and `POST /api/settings`; project overrides user; `set_config` accepts it; invalid values rejected the same way as the other booleans.
- Off is inert: with `quiz.panel` false, `panel_sync` registers nothing, `present_question` errors, the plan says `"tool"`, and hook output is byte-identical to `main` for the same fixtures.
- Planner: `presentation` is `"panel"` only with the setting on and a fresh heartbeat; every other state `"tool"`; `ask_attribution` absent for `"panel"`.
- Checkpoint/stop hooks: output text per `presentation`; silent with an open row; Stop does not block for a second question.
- A plan/directive snapshot proves all four sites name the same tool for each value.
- Skill/reference text assertions already used by `hooks.test.ts` extended for the new section.

## Stage 3 — The mod

Location, registration and module layout come from Stage 0 rows 1 and 11. Rules
that hold regardless:

- Static relative imports only; the sole bare import is `claude-code`. No dynamic
  import, no Node, no timers, no `hooks/run.mjs`. Literal event names; explicit
  mods API calls (no aliasing `$`, no passing it to helpers).
- **Render only our pane.** Filter `ui.render` to our `Pane`, check the request id,
  call `next(e)` for every other pane. Never touch permission prompts or other
  questions.
- Fail open: any handler error leaves the host's behaviour untouched and the question
  `pending` for the next sync.
- All persistence and grading logic stays in the server; the mod holds only the
  draft answer (in `$.state`, namespaced `eklavya.quiz.<session_id>`).

### State machine

| State | Shown | Controls | Next |
|---|---|---|---|
| none | pane closed (or one muted line "No question right now" if the learner opened it) | — | sync finds a row → loading |
| loading | "Loading your question…" | — | row → awaiting; error → error |
| awaiting | topic label, stem, up to 4 options each with its note, "Other — explain in your own words" | Select option (draft only), **Submit answer** (disabled until a draft), **Skip question** | Submit → grading; Skip → skipped |
| grading | "Checking your answer…" | all disabled | result → feedback; failure → error |
| feedback | "Correct" or "Needs another look", the right option when missed, the explanation, `level_up` line if any | **Done**; **Next** only for an explicitly requested round with another question | Done → none |
| skipped | "Skipped. We won't ask this one again." | Done | none |
| error | what failed, in words; draft kept | **Retry**, Close | retry reconciles first (`panel_sync`): if the row is already `answered`, show its stored result instead of resubmitting |
| hidden | nothing | reopen command | restores awaiting or feedback from `panel_sync` |
| unplaced | notification once: "A question is waiting. `<reopen command>` to open it." | — | opening retries `ui.open` |

Rules: feedback uses the words *Correct* / *Needs another look* plus colour; Submit
is single-flight (disabled and guarded by a local `grading` flag before the call
returns); selection never submits, including Enter on an option; typing in the prompt
or the Other input can never activate Skip; keyboard hints show only controls the host
actually provides (the concept image's "Tab Switch pane" hint is wrong — use the
host's Ctrl+X then Tab and Esc wording from the interface guide).

### Placement and focus

`closeOnEscape: true`. Automatic opens must not take typing focus. After `ui.open`,
report `placed {question_id, ok, reason}` to `panel_sync` so the server never counts
an invisible question as shown. 144 columns auto (110 after a manual open) are the
documented thresholds; read the real value from the host, do not hard-code them in
logic, only in copy if Stage 0 confirms.

### Typed answers (the one place the mod calls a model)

One `model.complete` call per typed answer, no retries beyond a single manual Retry,
input = stem, labels, the correct label, the learner's text, and the existing rubric
condensed from `skills/tutor/references/grading.md` (do not paraphrase the scale;
copy its rows). Output must parse as `{grade: 0-5, outcome: "answered"|"dont_know", feedback}` or it is discarded and the learner sees the error state. Refusal, empty output or
timeout never records anything. The call costs the learner's usage; say so in the
docs.

### Lifecycle

- `session.start`, clear, resume, branch and plugin reload each call `panel_sync` and
  trust only its answer for session/project identity before showing anything.
- Teardown removes listeners and drops the draft for a session that ended; a hidden
  pending question survives (it lives in the DB).
- Two simultaneous sessions never share state: every call carries `session_id` and
  `repo`, and the namespace includes the session id.

### Mod tests (host test harness from the testing guide)

Mount terminal **and** Desktop trees; drive controls by stable keys; fire lifecycle
events explicitly and stub every API so a skipped handler cannot pass.

- Each state in the table; Submit disabled until a draft; selection does not submit; double-click and double-Enter record once; Skip untouched by typing.
- Placement: placed, unplaced (width), resized, another mod's pane present (we render nothing for it).
- Scroll and a 560-column-equivalent narrow layout; light and dark theme tokens.
- Failure injection: MCP disconnect, `panel_answer` error after success (retry shows stored result), grader refusal, interrupted grading, stale question after `/clear`.
- Reload with a pending question and with a hidden question.
- Native layout: manual check in terminal and Desktop. **Tree tests do not prove painted UI.** Attach real screenshots to the PR and compare hierarchy (header, topic, stem, options, footer) with the concept images.

## Strings

| Where | Text |
|---|---|
| Header | `Eklavya` · `Powered by Claude` · Close |
| Topic label | `<concept name> · <tier label>` (tier labels from `TIER` in `dashboard.html`, not re-typed) |
| Buttons | `Submit answer` · `Skip question` · `Next question` · `Done` · `Retry` |
| Other | `Other — explain in your own words` |
| Grading | `Checking your answer…` |
| Result | `Correct` · `Needs another look` · `The answer was: <label>` |
| Skipped | `Skipped. We won't ask this one again.` |
| Level | `You've cleared <level> on <project>.` |
| Empty | `No question right now` |
| Unplaced notice | `A question is waiting. <reopen command> to open it.` |
| Errors | `We couldn't reach Eklavya. Your answer is saved here — Retry.` · `This question belongs to another session and was closed.` |

Never in the stem or any visible control: branding, the dials, option grades, the key.

## Data and migrations

One migration (`panel_questions`, indexes). No change to `attempts`. One config key,
`quiz.panel`, default `false` (no config migration: absent means false). No change to learning history, fingerprints
or SRS.

## Tests the gate expects

- Runtime: migration, idempotency, atomicity, secrecy, placement checks, grade table, stale/expiry, isolation (`mcp/test/`, new `panel.test.ts`; extend `migrate.test.ts`, `hooks.test.ts`, planner tests).
- Hooks and planner: presentation field, silent-when-open, Stop behaviour, directive agreement.
- Mod: the Stage 3 list, run by the host's supported test tooling plus strict validation of the **distributed** package, not only the source tree.
- Coverage: `npm run coverage` 100% on TypeScript.
- Existing quiz, grading, planning, fingerprint, skip and gate suites unchanged and green.

## Acceptance

Run in a scratch project with a temporary `EKLAVYA_HOME`, on terminal CLI 2.1.287+
and Desktop Code tab 2.1.286+, with the plugin installed from the worktree.

0. `eklavya config get quiz.panel` prints `false` on a clean home. Items 1–10 and 12–15 below run with it set to `true`.
1. Start a task that logs a concept. A branded pane opens beside the transcript (or the "question waiting" notice appears if narrow). Typing in the prompt keeps working.
2. While a long `Bash` runs and a background agent works, answer in the pane. Both keep running; the pane shows feedback; timestamps show no pause.
3. Click an option, do nothing: nothing is recorded. Submit: "Checking your answer…", then Correct or Needs another look with the why. Dashboard shows exactly one new attempt.
4. Double-click Submit and press Enter twice: still one attempt.
5. Choose Other, type an explanation: graded, recorded without MCQ cap (grade 5 is reachable), no `format`.
6. Skip: recorded as a decline (grade 0, `declined`); the concept is not offered again. Type "skip" into the prompt: nothing happens.
7. Close the pane with Esc mid-question, reopen: same question, draft kept. Nothing was graded or skipped.
8. Kill the Eklavya server mid-grading: error with Retry, draft intact; restart, Retry: one attempt.
9. `/clear`, then answer a leftover pane: "belongs to another session", no attempt.
10. `/eklavya:quiz caching`: same pane, round of up to `max_questions_per_task`, Next advances, Done closes. A named topic does not change the standing focus.
11. Fresh install, setting untouched (`quiz.panel` false): questions arrive as today's `AskUserQuestion` card and nothing about the panel appears. `eklavya config set quiz.panel true` (and the dashboard toggle) turns it on for the next question; setting it back to false, or disabling the mod, returns to the card, once.
12. A miss with `explain_on_wrong` on: feedback appears, an explainer page opens in the background, work is not paused.
13. Enforced gate: pane answers clear it as the card did; an unanswered pane question does not.
14. Two Claude sessions in two projects: each shows only its own question.
15. Terminal: Tab, Enter and Esc as documented; visible focus; light and dark; a 100-column and a 160-column terminal.

## Docs to update in the same PR

- Manual `dials` and `configuration`: the `quiz.panel` row (default off, experimental, scopes, what off means); Settings page of the manual's dashboard section if it lists toggles. Landing `#dials` only if it lists `quiz.*` keys; do not advertise the panel as generally available.
- Manual: `commands` (`/eklavya:quiz`, reopen command), `first-session` and `how-it-works` (where the question appears, one-question flow, non-blocking), `installation-options` (supported hosts, **exact tested versions**, unsupported surfaces: VS Code chat, SDK/print, cloud, Desktop WSL), `troubleshooting` (pane not showing, unplaced notice, how to disable), `your-data` (the `panel_questions` row and its 24 h expiry), `faq` (typed answers use your model usage), `grading-engine` (pane grades come from the same rubric, who evaluates what). `web/CLAUDE.md` rows updated where sources change; sidebar only if a page is added.
- Landing `web/public/index.html`: one sentence where the quiz is described. Do not advertise anything Stage 0 did not verify.
- `README.md` and `mcp/README.md` (new tools listed; mark `panel_*` as mod-only).
- `hooks/CLAUDE.md` (a mod is not a command hook; fail-open applies to it), `mcp/CLAUDE.md` (tool and table rows), `skills/CLAUDE.md` (presentation rule), `docs/verified-schemas.md` (Stage 0 rows), `docs/subagent-policy.md` and `docs/parallel-tutoring.md` (parent-only; non-blocking quiz while a builder works).
- `docs/eklavya-runtime.architecture.json`, then regenerate `docs/eklavya-runtime.html` as the root `CLAUDE.md` describes (panel flow: model → `present_question` → DB → mod → `panel_answer` → DB).
- `.github/PULL_REQUEST_TEMPLATE.md` filled, with the live acceptance transcript (items above), tutor eval before/after, and real screenshots.

## Decisions taken for the user (change here if wrong)

1. **MCQ answers are graded by the server from grades the asking model wrote with the question.** Why: the model already holds the key and the distractor shape when it writes the question; the pane then needs no model call, no latency, no cost, and the grade is deterministic. Cost: one extra authoring burden on the tutor (a grade per distractor) and 3 ("hesitant right") is unreachable by a plain pick. Rejected: re-grading with `model.complete` (usage, no history, can contradict the question's own key); asking the main agent (it is busy, which is the point of the feature).
2. **Typed "Other" answers are graded by one bounded `model.complete` in the mod, with the existing rubric.** Why: free text needs judgement and the rubric already exists. Cost: usage per typed answer, and a grader without conversation history (it gets stem, labels, key and text). Fallback if Stage 0 row 6 fails: store the text as `grading` and let the next sync-handled idle prompt grade it; slower, never lost.
3. **The pending question lives in a new table, not in mod state or memory.** Why: mods have no SQLite, reload loses state, and idempotency needs a transactional home with the attempt. Cost: one migration, which the issue hoped to avoid.
4. **Missed-answer explainer and level-up are surfaced by the pane, not by the model's tool reply.** Why: the model no longer sees `record_attempt`'s reply. Cost: depends on Stage 0 row 7; the fallback is a visible "Ask Claude to explain" line.
5. **One owner per question, decided when it is asked, never changed afterwards.** A panel question that cannot be placed stays pending; it is not re-asked as a card. Cost: a learner on a too-narrow terminal sees a notice and must open it; the alternative is a duplicate.
6. **`quiz.panel`, boolean, default off, with a dashboard Settings row.** The maintainer asked for it because the panel is experimental. Why a boolean: it matches the other `quiz.*` switches and has no third state worth naming. Why a registry row rather than CLI-only: both config interfaces stay in step (root `CLAUDE.md`), and the toggle is the natural place to read the "experimental" label. Cost: touches config, CLI path table, `set_config`, dashboard registry, two manual pages. The heartbeat still gates the actual routing, so on-but-unsupported hosts quietly keep the card.
7. **Skip is per question and a decline.** It matches the existing `/eklavya:skip` meaning for one concept (never offered again), not the session-wide silence. "I don't know" has no button; a typed "I don't know" is graded `dont_know` and taught. Cost: no one-click "teach me".
8. **Open rows expire after 24 h as `expired`, not as declines.** An unanswered question is not evidence either way. Cost: a stale question may be asked again later.
9. **Version bump is left to release tooling.** The issue asks for a manual bump; `scripts/bump-version.sh` and conventional commits own it.
10. **No fallback from the pane to the card mid-flight.** An in-flight grading is reconciled through `panel_sync`/`panel_answer` first, so a failed transport can never become a second record.
11. **Concept-image details not copied:** the "After submitting" inset (feedback replaces the form), the Tab hint (wrong for the host), any progress or streak element (out of scope).
