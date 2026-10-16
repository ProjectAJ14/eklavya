# Feedback page redesign — design handoff

- **Base:** `main` @ `c71ce05` (1.71.2)
- **Branch:** `claude/feedback-dashboard-redesign-918270` (this worktree). One PR.
- **Scope:** two parts in one PR.
  - **Part A:** the Feedback dashboard item (`#/feedback/dashboard` and `#/feedback/item/<id>`). History and the empty states are unchanged.
  - **Part B:** the review model states each of the four areas on purpose. Today it lists only gaps, so the coverage strip could not tell "covered" from "not flagged".
- **Design source:** the approved HTML mockup reviewed with the maintainer on 16 Oct 2026. No Figma. This file is the source of truth; where it and the mockup differ, this file wins.
- **Previous brief:** `docs/design/feedback-workflow-handoff.md` (the one-item rule, the badge, `via`, the "Found a problem" card).

## Agent preamble

Follow the root `CLAUDE.md`, `mcp/CLAUDE.md` and `web/CLAUDE.md`. Load `eklavya-dashboard` and `eklavya-design` before touching `mcp/src/assets/dashboard.html`, and `verify-docs` before opening the PR. Tests use a temporary `EKLAVYA_HOME` / `EKLAVYA_DB` and `EKLAVYA_DASHBOARD_PORT`. The dashboard makes no outbound request. This is a `feat(feedback):` change: it ships with the manual's `dashboard` and `how-it-works` pages updated in the same PR. Part B changes the review wording, so it needs before and after evidence from `eval/gepa/feedback/` (see Part B).

## Why

Today the item is one long card. It shows the metadata first, then the two prompts, then three flat text sections, then Tips as a dash list. Acknowledge sits at the bottom with no context. The comparison of prompts works. Everything else has no hierarchy:

1. **No verdict.** You read the whole card before you learn what the review concluded.
2. **"What it left out" is hard to scan.** The area name is a 12px mono label in a 120px column, and the "You said later" evidence looks like a caption.
3. **Tips are a dash list,** so they read as an afterthought, not as the thing to take away.
4. **The mascot is missing** from every section, so the page has no emotional cues. The design system defines states for review, success, warning and tip.
5. **Acknowledge is at the bottom of a long card.** The only action on the page is the hardest thing to find. "Where you said it" takes the top of the card, ahead of the content.

## The new page in one picture

Desktop (> 900px): a story column on the left and a sticky decision rail on the right.

```
┌ Feedback ───────────────────────────────────────────────────────────────┐
│ 1 waiting · 8 acknowledged · How this works                             │
├───────────────────────────────────────────────┬─────────────────────────┤
│ ① VERDICT  [mascot:review 88]                 │ WHERE YOU SAID IT       │
│   REVIEW OF ONE PROMPT · 5 OCT                │ Project / Session /     │
│   The agent had to guess the outcome,         │ Sent / About            │
│   the context and the check.                  ├─────────────────────────┤
│   [Outcome ✗][Context ✗][Scope —][Check ✗]    │ [face:info] Done        │
├───────────────────────┬───────────────────────┤ reading?                │
│ ② YOUR PROMPT         │ A BETTER PROMPT [Copy]│ The next review waits…  │
│ (dim)                 │ (ink, [placeholders]  │ [✓ Acknowledge]         │
│                       │  highlighted, clamped)│ Delete this feedback    │
│                       │ Show the whole prompt │ 1 waiting · 8 in history│
├───────────────────────┴───────────────────────┤        (sticky)         │
│ ③ [face:success] WHAT WORKED  one sentence    │                         │
│ ④ [face:warning] What it left out             │                         │
│    [tile] Outcome  what done looks like       │                         │
│           missing…                            │                         │
│           YOU, LATER  "evidence quote"        │                         │
│ ⑤ [face:tip] Next time                        │                         │
│    [01 tip] [02 tip] [03 tip]                 │                         │
│ ⑥ [face:info] Found a problem with Eklavya?…  │                         │
└───────────────────────────────────────────────┴─────────────────────────┘
```

The reading order follows how people take in feedback: the conclusion first, then the evidence (the two prompts), then what went well, then what to fix, then what to do next time. The single action stays in view the whole time.

## Layout

| Region | Desktop > 900px | 561–900px | ≤ 560px |
|---|---|---|---|
| `.fb` (new grid) | `grid-template-columns: minmax(0,1fr) 300px; gap: var(--space-6); align-items: start` | one column | one column |
| Story column `.fb__story` | `display:grid; gap: var(--space-6)` | same | same |
| Rail `.fb__rail` | `position: sticky; top: var(--space-6)` | static, **after** the story | static, after the story |
| Decision card `.fb__decide` | in the rail | hidden; the action bar replaces it | hidden; the action bar replaces it |
| Action bar `.fb__bar` | hidden | `position: fixed; bottom: 0` over the full width, with a `--spot` top hairline | the same, with the sentence hidden and the button full width |
| Compare `.fb__grid` | two columns | two columns | one column |
| Coverage strip | four columns | four columns | 2 × 2 |
| Tips | three columns ≥ 1100px, one row per tip below 1100px | one row per tip | one card per tip |
| `main` bottom padding | unchanged | `120px` so the bar never covers the last section | same |

On narrow screens the rail moves below the story, not above it, because the verdict has to come first. `.fb__decide` must not be `display:none` while the bar shows. See *Two Acknowledge buttons* under Accessibility.

## Design tokens

Use only role tokens. One new role is needed:

| Token | Ink | Paper | Use |
|---|---|---|---|
| **`--warning-soft` (new)** | `color-mix(in srgb, var(--warning) 14%, transparent)` | `color-mix(in srgb, var(--warning) 10%, transparent)` | Gap tile background. Add it to **both** ground blocks of `web/public/tokens.css`, next to `--spot-soft` |
| `--warning` | | | Gap icons, "Left out" status, the 2px underline of a missing area |
| `--spot` / `--spot-soft` | | | "A better prompt" label, placeholder highlight, tip numerals, the "What worked" left rule, the decision card border, Acknowledge fill |
| `--panel` / `--bg` / `--mass` | | | Cards / the better-prompt side and coverage cells / the evidence quote well |
| `--ink` / `--dim` / `--faint` | | | Primary text / your prompt and body notes / micro-labels and captions |
| `--line` / `--line-2` | | | Hairlines between gaps / card frames |
| `--font-disp` 800 | | | Verdict headline (`--text-xl`), section titles and "Done reading?" (`--text-md`), tip numerals (900, `--text-2xl`) |
| `--font-mono` 10.5px caps | | | Every micro-label (`.fb__h`, unchanged) |
| `--space-*` | | | Card padding `--space-6`; rail cards `--space-5`; gap rows `--space-5` × `--space-6` |
| `--ease`, `--duration-base` | | | The only motion: the clamp expanding (see Motion) |

Everything stays square, with hairlines and no shadows. Icons are inline Lucide paths at stroke 2 through the existing `svg()` helper (`dashboard.html:4535`). Add these keys to `ICONS`:

| Area | Lucide icon | Paths |
|---|---|---|
| `outcome` | `target` | `<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>` |
| `context` | `file` | `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>` |
| `scope` | `scan` | `<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/>` |
| `check` | `circle-check` | `<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>` |
| copy | `copy` (square) | `<rect width="14" height="14" x="8" y="8"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>` |
| ack | `check` | `<path d="M20 6 9 17l-5-5"/>` |

## Mascot: one emotion per section

Use the shared `<eklavya-mascot>` with **states** from `web/public/brand/mascot/mascot.js`, never raw expressions. Every mascot is decorative (no `label`), and the adjoining heading carries the meaning.

| Where | `state` → expression | `variant` / `size` | Why this emotion |
|---|---|---|---|
| Verdict card | `review` → focused | `body` / 88 | It has read your prompt carefully |
| What worked | `success` → happy | `face` / 40 | Praise first |
| What it left out | `warning` → worried | `face` / 40 | Concern, not blame |
| Next time | `tip` → wink | `face` / 40 | An offered habit |
| Done reading? (rail) | `info` → neutral | `face` / 32 | A calm prompt to act |
| Found a problem (footer) | `info` → neutral | `face` / 28 | Information |
| Verdict, **no gaps** | `complete` → celebrate | `body` / 88 | Nothing to guess |

Under 560px the verdict mascot is hidden so the headline gets the width. The face mascots stay.

## Components

All markup is built in `drawFbItem(it)` (`dashboard.html`, near line 4320). Every value comes from the `/api/feedback` item: `prompt`, `better`, `review.worked`, `review.gaps[] {area, missing, evidence?}`, `review.areas` (**new, Part B**), `tips[]`, `context`, `acknowledged_at`, `id`. `review.areas` lives inside the existing `review` JSON column, so there is no migration and no new state-payload field.

### ① Verdict `.fb__verdict` (new)

- **Micro-label:** `Review of one prompt · <date>`, with the date from `fmtDate(it.context.prompted_at)`. Drop `· <date>` when it is missing.
- **Headline** `<h2>`: derived from the gap areas in `AREA_ORDER = ['outcome','context','scope','check']`, never from model text:
  - 0 gaps: "Nothing here left the agent guessing."
  - 1 gap: "The agent had to guess the {a}."
  - 2 gaps: "The agent had to guess the {a} and the {b}."
  - 3 or 4 gaps: "The agent had to guess the {a}, the {b} and the {c}." (Oxford-free list, matching the house style.)
  - Area words are lower case: outcome, context, scope, check. The list follows the gap order the review gave (costliest first), not `AREA_ORDER`.
- **Sub-line:** "Of the prompts in that session, this one cost the most rework." Show it only when there is at least one gap.
- **Coverage strip** `.fb__cover`: four cells in `AREA_ORDER`, as `role="list"` / `role="listitem"`. Each cell has the area icon, the area name (`FB.areas`) and a status read from `review.areas[area]` (Part B):

  | `review.areas[a]` | Class | Status word | Colour (icon, word, 2px bottom inset) |
  |---|---|---|---|
  | `left_out` | `is-miss` | **Left out** | `--warning` |
  | `clear` | `is-ok` | **Clear** | `--spot` |
  | `not_needed` | `is-na` | **Not needed** | `--faint`, no inset |
  | missing (an item from rubric 2 or older) | `is-na` if the area is not in `gaps`, else `is-miss` | **Not flagged** / **Left out** | `--faint` / `--warning` |

  - Add `FB.status = { left_out: 'Left out', clear: 'Clear', not_needed: 'Not needed', unknown: 'Not flagged' }`.
  - The status is always a word, never colour alone. **No counts, scores or "n of 4" anywhere.** `REVIEW_SYSTEM` forbids numbers in the review, and the page says "There are no scores".
  - Tooltip-free: the meaning of each area is in the gap rows' hints and in "How this works".
- **Legacy item** (no `review.worked`, the migration-029 case): omit the headline, sub-line and strip. Show only the label and the mascot in `info` state with "An older review: the prompt, the rewrite and the tips are below."

### ② Compare `.fb__grid` (restyled; keep the class)

- One bordered block, two `<section>`s with a `--line-2` divider. "Your prompt" sits on `--panel` in `--dim` text. "A better prompt" sits on `--bg` in `--ink` text, with its label in `--spot`.
- Keep `.fb__quote` on your prompt's text element and `.cmd--block code` on the better prompt's text (the tests read both). The left border of `.fb__quote` goes away inside the compare.
- **Copy** moves into the better side's header row (right-aligned ghost button with the copy icon). It keeps `data-copy data-focus="copy:better"` and copies the plain `it.better`, without the highlight markup.
- **Placeholders:** wrap each `/\[[^\]\n]{2,200}\]/g` match in `it.better` in `<mark class="fb__ph">`, styled `background: var(--spot-soft); color: inherit; padding: 0 2px`. **Escape first, then wrap.** Run the regex over the `esc()` output (brackets survive escaping). Under the text add the caption "Highlighted: details only you know. Fill them in before you reuse it." Show it only when at least one match exists. Reason: `REVIEW_SYSTEM` writes a square-bracket placeholder wherever the developer never gave a detail.
- **Clamp:** when `it.better` is over 600 characters, clamp the text to `max-height: 15.5em` with a 4em fade into `--bg`. Add a text button "Show the whole prompt" (`aria-expanded`, `aria-controls` → the text's id) that toggles to "Show less". At or under 600 characters, show it all with no button.

### ③ What worked `.fb__worked` (restyled)

A single row: `--panel`, `--line-2` frame, **2px `--spot` left rule**, face mascot, the micro-label "What worked" in `--spot`, then `it.review.worked`. Omit it for a legacy item.

### ④ What it left out `.fb__ds` (restyled; keep the class and `li`)

- Section header `.fb__sh`: mascot (`warning` face 40), `<h3>` "What it left out", and the caption "What the agent had to guess, costliest first".
- One `<li>` per gap in an `<ol>`: a 44px square tile (`--warning-soft` background, `--warning` 20px icon), then:
  - the area name in 600 weight, followed by a `<small>` mono `--faint` hint: outcome "what done looks like", context "files, systems, prior facts", scope "the limits", check "how the agent proves it worked";
  - `missing` in `--dim`;
  - if `evidence`: a row with the mono micro-label **"You, later"** and the quote in a `--mass` well using `<q>` (curly quotes come from CSS `quotes`). Keep the `.fb__ev` class on the row.
- **Text contract:** the existing test reads each `li`'s text. Keep its order as `<Area> <missing>` then `You said later: “<evidence>”`, using a visually hidden `<span class="sr">You said later: </span>` before the `<q>`. Mark the visible "You, later" label `aria-hidden="true"`. Update the expected strings in the test to include the hint text.
- **No gaps:** replace the list with the existing sentence "Nothing the agent had to guess." in the same section, with the mascot in `success` state.

### ⑤ Next time `.fb__tips` (restyled; keep the class and `li`)

- Header: mascot (`tip` face 40), `<h3>` "Next time", and the caption "Habits that would have saved those follow-ups". For a legacy item, the caption is "Habits for next time".
- An `<ol>` of cards (`--panel`, `--line-2`). The numeral comes from a CSS counter (`'0' counter(t)`), in Archivo 900 `--text-2xl` `--spot`. It is an ordinal, not a score. Tip text is in `--ink`.
- Do not try to pair a tip with a gap: the data has no link between them.
- 1 tip: a single card at full width. 2 tips: two columns. 3 tips: three columns (≥ 1100px).

### ⑥ Found a problem `.fb__tip` (shrunk; keep the id, the key and the dismiss behaviour)

A single row at the end of the story column, above a `--line-2` top hairline: face mascot, the sentence "Found a problem with Eklavya itself? Tell Claude", the example in `<code>` (`File feedback for Eklavya`), the clause "it shows you the issue before posting.", and the existing Dismiss button. Keep `#fb-tip`, `#fb-tip-h` (as a visually hidden `h2`), `data-fb-tip-dismiss` and `FB_TIP_KEY`.

### Rail: Where you said it `.fb__ctx` (moved; keep the class)

- Its own card at the top of the rail, with the micro-label "Where you said it". The `<dl>` becomes stacked pairs: each `dt` is a mono caps label and its `dd` sits below it.
- Merge rows to fit 300px:
  - **Project:** `pname(project)`, then the full path on its own line in mono 11px `--faint` (`.slug`). Show **Checkout** as its own row only when it differs, as today.
  - **Session:** the existing link (`data-go` → the memory session), then `· N prompts`, then a second line with `began – ended`.
  - **Sent:** `fmtWhen(prompted_at) · host`.
  - **About:** `topic`.
- The tests read `.fb__ctx` text, the `.fb__ctx a` `data-go` and the absence of an "About" `dt`. Keep all three true.
- At 561–900px the `<dl>` uses two columns. At ≤ 560px it uses one.

### Rail: Decision card `.fb__decide` (new; pending items only)

- `--panel` with a **1px `--spot` border** (the only bordered-in-accent card on the page, which marks it as the place to act).
- The `info` face mascot with the `<h3>` "Done reading?".
- `<p>`: **`FB.rulePending`, reworded:** "The next review waits until you acknowledge this one. It moves to History." This replaces the separate `.fb__rule` banner above the card and the repeated `.fb__rule--near` on a first item. The rule now always sits next to the button, so it never needs saying twice.
- `#fb-actions` lives here:
  - **Acknowledge:** `.btn`, full width, minimum 44px, check icon, `data-fb-ack`.
  - **Delete this feedback:** a text button, `--faint`, hover `--error`, `data-fb-del`. Its inline confirm (`fbAskDelete`) renders inside the same card and is unchanged.
  - `#fb-msg` stays here.
- Footer line in mono 11px: "1 waiting" left and "N in history" right (`S.feedback.acknowledged`). These are counts of items, not scores.
- **Acknowledged item** (opened from History): no decision card. The rail shows "Acknowledged <fmtDate(acknowledged_at)>" under the context card, and a "← History" back link stays in the page head as today.

### Action bar `.fb__bar` (new; ≤ 900px, pending items only)

A fixed bottom bar: `--panel`, `border-top: 1px solid var(--spot)`, `--space-3` × `--space-5` padding. It holds the sentence "The next review waits until you acknowledge this one." (hidden ≤ 560px) and an Acknowledge `.btn`. At ≤ 560px the button is full width and at least 44px tall. Delete stays only in the rail card, which sits after the story on narrow screens: deleting is rare and should not sit next to the main action. The bar is a `role="region"` with `aria-label="Acknowledge this feedback"`.

## Part B: the review states all four areas

**Why:** the review lists at most `REVIEW_LIMIT.gaps` (3) gaps and is told to name "only gaps that mattered". An area it does not name could be clear, not needed for this task, or a fourth, smaller gap. The strip needs the model to say which, on purpose.

### Output contract (`mcp/src/feedback-review.ts`)

- `REVIEW_SCHEMA.properties.review` gains a **required** `areas` object. It has exactly the four `AREA_KEYS` (all required, `additionalProperties: false`), and each value is an enum: `"clear" | "left_out" | "not_needed"`. Export `AREA_STATUS = ['clear', 'left_out', 'not_needed'] as const` and a type `AreaStatus`.
- `ReviewResult` (zod) mirrors it: `areas: z.object({ outcome: Status, context: Status, scope: Status, check: Status }).strict()`.
- `REVIEW_SYSTEM` gains one instruction, after the gap lines and before `"missing"`:
  > `"areas" says, for each of the four areas, whether the chosen prompt made it clear ("clear"), left it for the agent to guess ("left_out") or did not need it for this task ("not_needed"). Every area you name in gaps is "left_out". Words only.`
- **`parseReview` reconciles, gaps win:** any area named in `gaps` is forced to `left_out`, because a gap carries the reason and maybe a quote. An area marked `left_out` with no gap stays `left_out` (the gaps are capped at three). If `areas` disagrees with `gaps`, do not reject the review: a paid call is not thrown away for this, which matches how a bad evidence quote is handled.
- `ParsedReview.review` and `FeedbackReview` (`mcp/src/feedback.ts`) gain `areas?: Record<GapArea, AreaStatus>`. It is optional on the read type because rows from rubric 2 and older lack it.
- **Bump `FEEDBACK_RUBRIC` to 3** and update its comment: "rubric 3 adds `review.areas`; older items have none and the page says *Not flagged*". No migration, because `review` is JSON text.
- `/api/feedback` already serves `review` whole. Check that nothing strips unknown keys on the way out (`acknowledgeItem`, `feedbackContext` do not touch `review`).
- History (`/api/feedback/list`) keeps its "Left out" pills from `gaps`. Unchanged.

### Eval (required before the PR)

- `eval/gepa/feedback/sessions.json`: add `expect.clear` to each session: the areas the chosen prompt plainly states (for example, the session whose prompt names its file gets `["context"]`). Keep `expect.areas` as the planted gaps. Label all 16 sessions by hand.
- `eval/gepa/feedback/bridge.mjs` / `run.py`: report a new quality term, **areas agreement**: the share of the four areas whose status matches the labels (`left_out` ⇔ in `expect.areas`, `clear` ⇔ in `expect.clear`, anything else accepts `not_needed`). Report it **alongside** the score and give it weight 0 in this PR, so the before and after scores stay comparable. Give `valid` its normal gate: a review without `areas` fails it under the new schema. The legacy `--prompt` JSON path still scores rubric 2.
- Evidence for the PR template: run `evaluate --split test --repeats 3` for the shipped wording (rubric 2, legacy JSON) and for the new one. Paste both reports. Acceptance: the overall score drops by no more than 0.03, `valid` stays at 100%, and areas agreement is at least 0.75. If it lands below that, stop and report rather than tuning the wording blind.

### Tests

- `mcp/test/feedback-review.test.ts`: a valid `areas` is accepted; one missing a key is rejected as `malformed`; a fifth key is rejected; a gap area marked `clear` comes back `left_out`; a `left_out` area with no gap stays `left_out`; `REVIEW_SYSTEM` contains `"areas"` and still contains no digits other than its limits.
- `mcp/test/feedback-store.test.ts`: a stored rubric-3 item round-trips `areas`; `FEEDBACK_RUBRIC === 3`.
- Browser test: a rubric-3 item shows "Clear" / "Not needed" / "Left out" from `areas`; a rubric-2 item shows "Not flagged" for the unnamed areas.
- Coverage stays at 100%.

### Documentation for Part B

- `web/src/content/docs/docs/how-it-works.mdx` (prompt feedback section): the review now also says, for each area, whether the prompt made it clear, left it out or did not need it.
- `web/src/content/docs/docs/dashboard.mdx`: the four status words and "Not flagged" for older items.
- `mcp/CLAUDE.md` *Prompt feedback* row: `feedback-review.ts` owns `AREA_STATUS` and the reconcile rule.
- `eval/gepa/feedback/README.md`: the `expect.clear` label and the areas-agreement term.

## Removed

- The `.fb__rule` banner above the item (`#fb-rule`), while an item is pending. **Keep it for the empty state:** `FB.ruleEmpty` still shows above `fbEmpty`.
- `.fb__rule--near`.
- The "Tips" `h2` and the dash bullets.

## States and interactions

| Element | State | Behaviour |
|---|---|---|
| Acknowledge (rail or bar) | Hover | Keep the existing `.btn` hover rule unchanged |
| Acknowledge | Focus | `--ring` |
| Acknowledge | In flight | **Both** buttons `disabled` (pressing one must disable the other); the label stays the same |
| Acknowledge | Error | `fbFail` writes to `#fb-msg` in the rail card. On ≤ 900px, also scroll `#fb-msg` into view with `block: 'nearest'` |
| Acknowledge | Done | Unchanged `fbDone()`: redraw, focus `h1`, announce `FB.announce` |
| Copy | Click | Existing `data-copy` path; `#copy-live` announces |
| Show the whole prompt | Click | Toggle the clamp class, swap the label, update `aria-expanded`. Focus stays on the button |
| Delete | Click | Existing inline confirm inside `.fb__decide` |
| Session link | Click | Existing `data-go` |
| Coverage cell | — | Not interactive. No hover |
| Rail | Scroll | Sticky ≥ 901px. If the rail is taller than the viewport (very long topic or path), drop `sticky` (check `rail.offsetHeight > innerHeight - 48` after render and on resize) |

## Edge cases

- **Empty, off, no observer, failed:** unchanged (`fbEmpty`), with the `.fb__rule` empty sentence above it.
- **Loading:** the existing `slot()` loader ("Loading your feedback…") fills the whole `.fb` area. Do not show the rail before the item arrives.
- **No gaps:** celebrate mascot, the "Nothing here left the agent guessing." headline, the cells read from `areas` (each "Clear" or "Not needed"), the "Nothing the agent had to guess." line, tips as usual.
- **Legacy item (no `worked`):** see ① and ③.
- **Very long prompt** (yours over 1,500 characters): clamp it like the better prompt, with its own toggle and the same rule.
- **Long unbroken strings** (paths, URLs): `overflow-wrap: anywhere` on every text node in the compare, gaps and rail.
- **Missing context fields:** each rail row is omitted on its own (as today). With no context at all, hide the context card.
- **One tip, or long tips:** see ⑤. Tips are capped at `REVIEW_LIMIT.tip` characters on the server, so no truncation is needed.
- **Evidence missing:** no "You, later" row.

## Motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Better-prompt clamp | Toggle | `max-height` transition | `--duration-base` | `--ease` |
| Everything else | — | none | — | — |

Under `prefers-reduced-motion: reduce`, there is no transition. The mascots do not animate here (no `loading` variant).

## Accessibility

- **Order** (DOM equals visual on every width): `h1` → verdict `h2` → compare (Copy, Show whole prompt) → What worked → What it left out `h3` → Next time `h3` → Found a problem (Dismiss) → rail: context (session link) → Done reading? (Acknowledge, Delete). The bar comes last in the DOM.
- **Two Acknowledge buttons:** at ≤ 900px the rail card is `display:none` and only the bar's button is in the Tab order. At > 900px the bar is `display:none`. The keyboard test's "Tab reaches it" stays true at both sizes. Both buttons carry `data-fb-ack`. The page code must bind to whichever was clicked and disable both.
- Each section is a `<section aria-labelledby>` pointing at its heading. The coverage strip is a list with the label "What the prompt covered". The rail is `<aside aria-label="About this prompt">`.
- Status on the coverage strip and gaps is always a word as well as a colour. The `--warning` text and icons meet 4.5:1 on `--bg` and `--panel` in both grounds (ink #E8920C, paper #7A4B00). Verify paper against `--panel`.
- The 44px minimum applies to Acknowledge, Delete, Copy and Dismiss at ≤ 560px.
- The announcements are unchanged (`#fb-live`, `#copy-live`).

## Tests to update (`mcp/test/dashboard-feedback-browser.test.ts`)

| Test | Change |
|---|---|
| "is repeated above Acknowledge on the very first item only" | Replace it. The rule sentence appears **once** inside `.fb__decide` for every pending item, and the `.fb__rule` banner shows only in the empty state |
| "shows the prompt, a better one…" | Expected `li` text gains the area hint; `.fb__quote`, `.cmd--block code`, `.fb__tips li` count unchanged; add: `[the file]` is inside `mark.fb__ph`, and Copy copies text without `<mark>` |
| "stacks the prompts and gives full-width 44px buttons at 560px" | `[data-fb-ack]` is now the **bar** button (visible one, `:visible`); `[data-fb-del]` in the rail card still ≥ 44px and > 400px wide |
| New | Verdict headline for 0, 1 and 3 gaps; the coverage strip words from `areas` (Clear / Left out / Not needed) and "Not flagged" for a rubric-2 item; no digits inside `.fb__verdict` besides the date |
| New | At 1280px the rail is `position: sticky` and Acknowledge is in view after scrolling to the tips |
| New | At 800px exactly one `[data-fb-ack]` is visible; pressing it disables both |
| New | A legacy item shows no strip and no "What worked" |
| Existing ink/paper × widths no-outbound sweep | Must still pass |

Run `npm test` and `npm run coverage` in `mcp/` (100% is required). The known flaky "is operated from the keyboard" dashboard test can fail on its own; rerun it before treating a failure as yours.

## Documentation in the same PR

- `web/src/content/docs/docs/dashboard.mdx`: the Feedback section describes the new reading order (verdict, comparison, what worked, what it left out, next time), the coverage strip ("Left out" / "Clear" / "Not needed", "Not flagged" on older items, no scores), highlighted placeholders, and that Acknowledge stays in view.
- `mcp/README.md`: a one-line touch where the Feedback workflow is mentioned (the docs-sync check needs a README change).
- `.claude/skills/eklavya-dashboard/SKILL.md` § *Feedback: one item, one rule*: the rule sentence now lives in `.fb__decide`, and there are two `data-fb-ack` buttons with only one visible.
- `.claude/skills/eklavya-design/SKILL.md`: add `--warning-soft` to the role table.
- Build `web/` and check 1280, 900 and 560px in ink and paper.

## Acceptance

1. With an item waiting, at 1280px in ink: the verdict, the coverage strip and both prompts are visible without scrolling. Scroll to the tips: Acknowledge is still on screen.
2. The same item at 560px in paper: the verdict comes first, the context card follows the tips, and the bottom bar shows a full-width Acknowledge.
3. Press Acknowledge once. One POST, the badge clears, focus moves to `h1`, and "Acknowledged. Feedback resumes at your next session." is announced.
4. Open the item from History: no decision card, no bar, and "Acknowledged <date>" in the rail.
5. A fresh review (`eklavya feedback generate` against a scratch `EKLAVYA_HOME`) stores `review.areas` with all four keys, and the page shows its words.
6. `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|--vd-'` and `grep -n border-radius` over the new CSS return nothing new.
