# Component recipes

The landing page's shared components, as implemented in `web/public/styles.css`.
Reuse these classes on the site; on another surface (dashboard, artifacts) copy the
recipe onto that surface's role tokens rather than inventing a variant. Every value
below names a token from `web/public/tokens.css`.

## Button — `.btn`

Square, verb-first. Inter 700 15px, padding 12px 22px, `border-radius: 0`,
transitions 160ms on `--ease`.

| Variant | Fill / text | Hover | Use |
|---|---|---|---|
| `.btn--brand` | `--spot` / `--spot-ink` | unchanged | The one primary action in a band |
| `.btn--ghost` | none / `--ink`, 1px `--line-2` border | `--panel` fill | The secondary action beside it |
| `.btn--white` | `--panel` / `--ink`, 14px, 9px 16px | `--mass` fill | A quiet action inside a card or docs block |

`<a>` for navigation, `<button>` for actions; an optional trailing Lucide arrow at 16px.

## Eyebrow and section heading — `.eyebrow`, `.h2`

Eyebrow: mono 11px, uppercase, `--tracking-caps-wide`, `--spot`. Heading: Archivo 900,
`--display-2`, `--leading-display`, `--tracking-display`. At most one word in `<em>`,
which turns `--spot` and stays upright.

## Chip and inline code — `.chip`, `.code-inline`

Chip: mono 12px, `--spot` text on `--spot-soft`, 1px `--spot` border, 3px 10px, square.
It holds machine names verbatim (concept slugs, tiers). Inline code: mono 13px, `--dim`
on `--mass`, 1px 5px, square.

## Card — `.card`, `.icon-tile`

`--panel`, 1px `--line` border, 28px padding, square, no shadow, no coloured side
border. Head in Archivo 800 18px, `--tracking-snug`; body 14.5px/1.6 `--dim`. Icon tile:
44px square, `--spot-soft` fill, `--spot` Lucide icon at 22px. Lay out three across
with a 24px gap.

## Command table — `.cmd-table`, `.cmd-row`

`--panel` block with a 1px `--line` border; rows split by `--line` hairlines, 16px 22px
padding, a 220px key column. Key: mono 13.5px `--spot`, verbatim command or config key.
Description: 14px `--dim`, one line starting with a verb. Stack below 560px.

## Dial — `.dial`

A config dial card: `--panel`, 1px `--line`, 24px padding. Head: the key in mono 15px 600
`--spot`, the plain question in 14px 700 `--ink`. Each option (`.dial__opt`) is split by
a `--line` hairline; the default option alone is a `--spot-soft` block with a `--spot`
border and a `.dial__pill` ("Default", 10px 700 uppercase, `--spot`).

## Ground toggle — `.ground`

Two always-visible, labelled `<button>`s in a 1px `--line-2` frame: mono 11px uppercase,
`--faint`; `aria-pressed="true"` inverts to `--ink` fill with `--bg` text. Clicking sets
`data-mode` on `<html>`; ink is the default and the OS setting is ignored.

## Steps — `.steps`

A numbered vertical sequence on a 2px `--mass` spine. Numbers are 40px mono discs
(`border-radius: 50%`), `--spot-soft` fill and `--spot` border; the final or current step
takes `.steps__n--solid` (`--spot` fill, `--spot-ink` text). Heads Archivo 800 19px;
bodies 15px `--dim`. Three to five steps, each starting with a verb.

## Not components

The hero terminal (`.term*`) and the arrow flight (`.shot*`) are showpieces with their
own geometry, timing and palette. Recolour them onto tokens if needed; do not rebuild
them from these recipes.
