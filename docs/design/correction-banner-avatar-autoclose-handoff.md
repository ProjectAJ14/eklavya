# Correction banner avatar and auto-closing modal — design handoff

- **Base:** `main` @ `768d50a`
- **Design source:** this brief plus an approved clickable mockup (real
  `tokens.css` and `mascot.js`, Ink and Paper). Visual rules come from
  `.claude/skills/eklavya-design/SKILL.md` and `.claude/skills/eklavya-dashboard/SKILL.md`.
- **Surface:** the explainer viewer's correction bar (`.fixbar`) and its modal
  (`dialog.fix`) in `mcp/src/assets/dashboard.html`.

## Agent preamble

Follow the root `CLAUDE.md` and `mcp/CLAUDE.md`. Load `eklavya-dashboard` and
`eklavya-design` before any UI work and `verify-docs` before opening the PR.
Tests use a temporary `EKLAVYA_HOME` / `EKLAVYA_DB` and `EKLAVYA_DASHBOARD_PORT`.
Keep server grading, `postJson('/api/attempts/retry')`, the leave prompt
(`armLeave`) and the wrong-answer flow exactly as they are.

## The feedback

1. Make the banner slightly taller and add the Eklavya avatar with the right emotion.
2. When the user picks the right answer, keep showing the question and answer,
   then auto-close the modal after 3 seconds.
3. The Close button shows it is closing: 3, 2, 1. The user can cancel the close.

## 1. Banner

| Property | Now | New |
|---|---|---|
| Row height (`min-height`) | 64px | 88px, open and corrected alike so nothing moves when the state flips |
| Avatar | none | `<eklavya-mascot variant="face" size="56">` at the left, `--space-4` gap to the text, left padding stays `--space-5` |
| Text | 14px lead, 13px note | Same copy. Lead becomes 15px / 600. Keep the single-line ellipsis. |
| Below 560px | note hidden | note hidden, avatar 40px, row 72px |

Avatar emotion comes from the existing `state` map in `mascot.js`; no new art.

| Bar state | `state=` | Face | Why |
|---|---|---|---|
| Open ("You missed this one.") | `warning` | worried | Matches the warning rule; concerned and encouraging, not sad |
| Corrected | `success` | happy | Matches the verdigris rule |
| Loading the question | `loading` | excited | The loader already uses it |
| Load failed | `error` | sad | Matches the other failure messages |

`paintFix` draws the avatar. The bar is redrawn on every close, so the face
follows the state with no extra code path.

## 2. Modal: auto-close after a right answer

Sequence after the server confirms `corrected`:

1. The message shows "Corrected. Your accuracy now counts this as right." with
   the happy face (current behaviour). The question and the options stay visible.
2. The Close button reads **Closing in 3…**, then 2, then 1, one tick per second.
   A fill sweeps left to right over 3s in `--spot-soft`; the border turns `--spot`.
3. A **Stay open** button appears left of Close and takes focus.
4. At 0 the dialog closes through the existing `close` handler. The bar repaints
   as corrected and the avatar turns happy.
5. Stay open cancels the timer: Close returns to plain "Close", the dialog stays.

| Element | State | Behaviour |
|---|---|---|
| Close | Counting | Label "Closing in N…" plus the fill. Clicking closes immediately. |
| Close | Idle or cancelled | Plain "Close", fill removed |
| Stay open | Counting | Visible, focused. Ghost `set__btn` style, ring on focus. |
| Stay open | Otherwise | `display:none` |

Anything that clears the timer: Stay open, closing by any route (Close, Escape),
re-opening the dialog. Escape still closes at once, with no second press.
Start the countdown only after the server confirms the right pick; a failed post
shows the existing warning and starts nothing.

## Motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Close fill | Countdown starts | `scaleX` 0 to 1, origin left | 3s | linear |
| Label | Each second | Text swap, no animation | n/a | n/a |

Under `prefers-reduced-motion`, drop the fill and keep only the number ticking.

## Accessibility

- `#fix-msg` already has `role="status"`. Announce once when the countdown
  starts: "Closing in 3 seconds. Press Stay open to cancel." Do not announce each tick.
- Focus moves to Stay open when the countdown starts. On close, focus returns to
  `#fix-open` as today.
- Stay open is the WCAG 2.2.1 escape for a timeout the user did not ask for. It
  must be keyboard-reachable and come before Close in tab order.
- Check the Close label's contrast over the fill in both Ink and Paper.

## Edge cases

- **Tab hidden mid-countdown:** pause and resume on return so the modal never
  closes unseen.
- **Narrow screens (560px):** the footer wraps: message on top, the two buttons below.
- **Long answer text:** unchanged; the dialog scrolls.

## Where to change

All in `mcp/src/assets/dashboard.html`: the `.fixbar` CSS, `paintFix`, `pickFix`,
and the `fix-close` and `close` listeners. Use `setInterval` with one
module-level handle, cleared in the `close` listener.

## Documentation

Review the manual `dashboard` page (`web/src/content/docs/docs/dashboard.mdx`
quotes "You missed this one") and the README, per the root `CLAUDE.md`. Do not
touch the landing page.

## Tests

The dashboard browser tests assert on this bar's text
(`mcp/test/dashboard-*-browser.test.ts`). Update them for the taller bar and
avatar, and add:

- a countdown test with fake timers: 3, 2, 1, then closed;
- a Stay open test: the dialog stays open and Close reads "Close";
- a corrected-bar test: the avatar state is `success`.

Check at 1280, 900 and 560px in both Ink and Paper.
