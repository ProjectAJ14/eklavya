---
name: eklavya-design
description: Visual design system for Eklavya (the "learn while your agent works" Claude Code plugin) — landing page, manual, dashboard, explainer artifacts and any Eklavya-branded UI. Use whenever building, restyling or reviewing an Eklavya surface so colour, type, shape, motion, iconography and voice stay consistent.
---

# Eklavya design system

Eklavya looks calm, dark and engineering-grade: a warm ink ground, one verdigris
accent, square hairline chrome, and enormous tight display type set against tiny
wide-tracked mono. The Ekalavya legend (the self-taught archer) appears only as
bow, arrow and target line art — never storybook, never ornamental.

**Values live in `web/public/tokens.css`.** This file states the rules; the CSS
states the numbers. When they disagree the CSS is right and this file is stale —
fix it here. Component recipes are in `references/components.md`.

## Rules at a glance

| # | Rule | A violation looks like |
|---|---|---|
| 1 | Components name a **role** token, never a scale step or raw colour | `color: #A29C93`, `background: var(--vd-300)`, `rgba(25,150,136,.12)` |
| 2 | The chrome is **square** | `border-radius: 8px` on a button, card, chip, tile, input or table |
| 3 | **Hairlines, not shadows** | `box-shadow` on a card that does not float |
| 4 | Three families, through their variables | `font-family: system-ui` or a fourth face |
| 5 | **One accent hue**; state colours only for real state | a blue link, a red "new" badge |
| 6 | No emoji; sentence case; Lucide line icons | `🎯 Your Progress` |
| 7 | No grayscale font smoothing | `-webkit-font-smoothing: antialiased` |
| 8 | Motion on `--ease`, 120–320ms, and reduced motion honoured | a bounce, a loop that ignores `prefers-reduced-motion` |
| 9 | Visible focus, keyboard-operable controls | `outline: none` with no ring, a clickable `<div>` |
| 10 | Text ≥ 4.5:1 on its ground in **both** grounds | `--faint-2` for readable copy |
| 11 | Ink is the default and never follows the OS | a `prefers-color-scheme` switch |

## Grounds and colour

Two grounds, one accent. `data-mode` on `<html>` is `ink` (default) or `paper`,
set by a blocking inline script before styles load, and each ground redefines the
same role tokens. Custom properties inherit, so one attribute re-resolves the tree.

| Role | Ink | Paper | Use |
|---|---|---|---|
| `--bg` | #17171a | #f0ede6 | Page ground. Sections split by a `--line-2` hairline, never by a background change |
| `--panel` | #1e1e22 | #e7e3da | Cards, dials, tables, sidebar |
| `--mass` | #26262a | #ddd8cc | Wells, inline code, spines, filled-button hover |
| `--ink` | #EAE7E1 | #16150f | Primary text |
| `--dim` | #A29C93 | #57534a | Body paragraphs, secondary text |
| `--faint` | #8B857B | #635E52 | Captions, micro-labels (≥4.89:1 on every ground it sits on) |
| `--faint-2` | #565249 | #a09a8c | Disabled and placeholder **only** — fails 4.5:1 by design |
| `--line` / `--line-2` | #26262a / #33333a | #e3dfd4 / #cec8b9 | Hairline inside a block / frame edges, control borders |
| `--spot` | `--vd-300` | `--vd-700` | The accent |
| `--spot-ink` | #17171a | #ffffff | Text on a `--spot` fill |
| `--spot-soft` | spot 14% | spot 10% | Icon tiles, chips, the default dial option |
| `--warning` | #E8920C | #7A4B00 | Real warnings and the "missed" series |
| `--error` | #FF6166 | #A8201A | Real errors and wrong answers only; always pair with a word or mark |
| `--code-bg`, `--grid`, `--glow`, `--glow-low`, `--shadow-lg`, `--ring` | | | Code wells, the 72px rule grid, terminal halos, floating shadow, focus ring |

- Neither ground is neutral grey — warm ink, warm paper. Ink is the product: Eklavya
  is a terminal plugin, so an absent choice stays ink and the OS setting is ignored.
- **Verdigris** (aged bronze on a bow fitting) is the only hue. Ramp `--vd-50` …
  `--vd-900`; `--spot` picks 300 on ink (10.33:1) and 700 on paper (7.20:1). Spend
  it about six times a page: one headline word in `<em>`, the `$`, link text, the
  active nav item, the primary button. A `--vd-*` step in a component is a bug.
- A new colour need is a new role in **both** ground blocks of `tokens.css`, never
  a literal in the component.
- **Exception — the terminal.** It is a picture of a terminal, and terminals are
  dark, so it keeps one fixed palette on both grounds (`--term-*` in tokens.css,
  plus the terminal-only neutrals declared at the top of `styles.css`). The macOS
  window dots (#FF5F57, #FEBC2E, #28C840) depict another app's chrome. Nothing
  outside the terminal may use either set.
- **Exception — the mark.** `web/public/brand/mark.svg` is a white bow and arrow on a
  `#0E6E66` (`--vd-600`) square, fixed. Never recolour, round or frame it.

## Type

- **Archivo** (`--font-disp`, 600/800/900) for display; **Inter** (`--font-body`,
  400/500/600) for text; **JetBrains Mono** (`--font-mono`, 400/500/600) for code,
  slash commands, concept slugs, tier labels, terminal content and micro-labels.
  Always through the variables. Surfaces that must make no outbound request (the
  dashboard) strip the Google Fonts import and fall back to the stacks in the vars.
- Two extremes, no middle. Display: weight 900, `--tracking-display` (-0.055em),
  `--leading-display` (0.9), sized fluidly (`--display-hero`, `--display-1`,
  `--display-2`). Micro-labels: mono 10–11.5px, uppercase, 0.16–0.24em
  (`--tracking-caps`, `--tracking-caps-wide`), in `--faint` or `--spot`. They replace
  pill eyebrows. Body: 14.5px / 1.65, quiet.
- Sentence case in prose and headings; micro-labels are uppercased by CSS. No emoji.
- Never set `-webkit-font-smoothing: antialiased`: it thins light-on-dark glyphs.

## Shape, space and layout

- 4px grid: `--space-1` (4) … `--space-24` (96). Content 1140px wide with 32px side
  padding inside a 1440px ruled frame (`--max`). Sections pad 96px vertically (72px
  under 900px). Check layouts at 1280, 900 and 560px in both grounds.
- **Square chrome.** Buttons, cards, chips, dials, tables, tiles, badges, inputs and
  code blocks are `border-radius: 0`. Circles (`50%`) only for dots, step numbers and
  ripples; `--radius-pill` only for scrollbar thumbs. `--radius-term` (16px) belongs
  to the hero terminal and the arrow scene alone. `--radius-sm/md/lg` are for small
  data marks (legend swatches, chart bars), never chrome.
- **Hairlines, not shadows.** Separation is 1px `--line` or `--line-2`. `--shadow-lg`
  is for things that float (menus, popovers, dialogs).
- Backgrounds are flat, plus the 72px `--grid` rule grid on `body` and at most one
  soft `--glow` radial per band.

## Motion

- `--ease` (`cubic-bezier(.2,.6,.2,1)`) on 120 / 200 / 320ms (`--duration-fast`,
  `-base`, `-slow`); micro-interactions 140–200ms. No bounce, no spring.
- Scroll reveals: opacity 0 + translateY(18px) → visible over 0.7s, staggered
  100–400ms, fired once by an IntersectionObserver at threshold 0.15.
- Loops are keyframe-driven with percentage windows: terminal 16s, arrow flight 9s.
  The arrow launches fast and decelerates (`cubic-bezier(.3,0,.4,1)`), the bow
  recoils ~5px, the target pops 1 → 1.06 → 1, two ripple rings fade. Head forward,
  fletching back.
- `prefers-reduced-motion: reduce` collapses every animation and transition so
  content lands in its final state.

## Signature motifs

- **Nav brand:** the bow glyph (`web/src/assets/bow.svg`, 24px grid, stroke 1.8) in
  `--spot-ink` on a 30px square `--spot` tile, then "Eklavya" in Archivo 900 19px.
- **Arrow flight:** line bow → dashed trajectory → concentric target. Full strength
  in story sections; as ambient art at `--shot-op` with a slight blur.
- **Terminal window:** `--radius-term`, three muted dots, mono 13px/1.75, showing the
  real loop (prompt → work → concept log → quiz → grade) line by line with a
  blinking verdigris block cursor. Its quoted output is real product output.
- **The terminal and the arrow flight are the two showpieces and are not to be
  redesigned.** They may be recoloured onto tokens; their geometry, timing and
  behaviour stay.

## States, focus and icons

- Focus is `--ring` (2px `--bg` gap, then 2px `--spot`) via `:focus-visible`. Never
  remove it without a replacement.
- Hover moves an outlined control's colour or border to `--spot`, and steps a filled
  one (`--panel` → `--mass`). A selected segment inverts: `--ink` fill, `--bg` text.
- Every control is a real `<button>` or `<a>`; state lives in `aria-pressed` /
  `aria-current`, never colour alone.
- Icons: Lucide line icons only, inlined — stroke `currentColor`, width 2 (1.8 for
  the bow), round caps and joins; 16px in buttons, 20–22px in a 44px `--spot-soft`
  tile. No icon fonts, filled icons or emoji.

## Voice

Direct, concise, technically credible. Lead with the outcome; verbs first on buttons
("View on GitHub", "Star on GitHub"). Numbers over adjectives. Address the reader as
"you". Reference the legend factually ("he practiced before a statue of his guru —
here, the statue talks back"), never cutely. Keep the product's own words verbatim:
the tagline "Learn while your agent works — and carry project context forward.",
command names, config keys, concept slugs.

## Before you ship a surface

- `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|--vd-' <file>` outside tokens.css returns
  only the terminal block and documented exceptions.
- `grep -n 'border-radius' <file>` shows 0, 50%, or a documented exception.
- Toggle ink/paper; tab through every control; run once with reduced motion.
