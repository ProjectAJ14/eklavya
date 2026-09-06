---
name: eklavya-design
description: Visual design language for Eklavya (the "learn while your agent works" Claude Code plugin) — landing page, docs, and any Eklavya-branded UI. Use whenever building or restyling Eklavya web surfaces so colors, type, motion, iconography, and voice stay consistent.
---

# Eklavya design skill

Eklavya's look: calm, dark, engineering-grade — a developer tool that quietly references the Ekalavya legend (the self-taught archer) through bow / arrow / target line-art motifs. Never storybook or ornamental.

## Grounds and palette

Two grounds, one accent. `data-mode` on `<html>` is `ink` (default) or `paper`, and
each redefines the same **role** tokens in `site/tokens.css`. Components name a role
— `--ink`, `--dim`, `--faint`, `--line`, `--line-2`, `--panel`, `--mass`, `--spot`,
`--spot-ink` — and never a scale step or a raw hex. That is the whole theme
implementation: custom properties inherit, so one attribute re-resolves the tree.

- **Ink** (default): bg #17171a, panel #1e1e22, mass #26262a, text #EAE7E1, dim #A29C93, faint #77726A, lines #26262a / #33333a.
- **Paper**: bg #f0ede6, panel #e7e3da, mass #ddd8cc, text #16150f, dim #57534a, faint #8a8578, lines #e3dfd4 / #cec8b9.
- Neither ground is neutral grey — warm ink, warm paper. That is what stops paper reading as a bleached inversion of ink.
- Ink is the default and an absent choice stays ink; the ground deliberately does **not** follow the reader's OS. Eklavya is a terminal plugin and the dark ground is the product.

**Accent: verdigris** — aged bronze on a bow fitting. One hue, two values, because
no single value clears contrast on both grounds:

- Ramp: 50 #E6F7F3, 100 #C4EDE4, 200 #9BE0D2, **300 #79D5C4 (accent on ink, 10.33:1)**, 400 #3FB8A3, 500 #199688, **600 #0E6E66 (accent on paper, 5.22:1)**, 700 #0A5751, 800 #07403C, 900 #052E2B.
- Spend it perhaps six times a page: one word in the headline, the `$`, link text, the active nav item. Everything else is a neutral role.
- `--spot-soft` is the accent at 10–14% for tints; text on a `--spot` fill takes `--spot-ink`.
- No other hues. Semantic amber/red (`--warning`, `--error`) are for real warnings and errors only, and are kept off the accent so state never reads as branding.

## Type

- **Archivo** for display (600/800/900), **Inter** for body (400/500/600), **JetBrains Mono** for code, slash-commands, concept slugs, tier labels, terminal content and micro-labels.
- The system is two extremes with no middle: enormous tight display, tiny wide-tracked uppercase mono. Body text stays small and quiet — 14.5px/1.65 — and the contrast between those poles is most of what reads as designed.
- Display: weight 900, `letter-spacing: -0.055em`, `line-height: .88–.92`, sized with `clamp()` (`--display-hero`, `--display-1`, `--display-2`) so it scales with the viewport instead of sitting at a timid fixed size.
- Micro-labels: mono, 10–11.5px, uppercase, `letter-spacing: .16–.24em`, in `--faint` or `--spot`. These replace pill-shaped eyebrows.
- Sentence case in prose. No emoji.
- Do not set `-webkit-font-smoothing: antialiased`: grayscale smoothing thins light-on-dark glyphs, and ink is the default ground.

## Layout
- Content max-width 1140px, 32px side padding; sections pad 96px vertical; 4px base grid.
- Radii: controls 8px, cards 12px, terminals/large surfaces 16px, pills 999px.
- Band rhythm: alternate white / neutral-50 for product sections; reserve dark bands (neutral-900, green-900) for hero, legend/story, and final CTA.
- Backgrounds: flat, plus at most a subtle dot grid (1px dots, 26px tile, ≤7% opacity, masked to fade) and one large soft green radial glow per dark band.

## Signature motifs
- **Bow-and-arrow mark**: white line-art bow (arc + string) with an arrow through it, in a green-500 rounded-8 square.
- **Arrow-flight scene**: line bow → dashed dotted trajectory → concentric-circle target; arrow flies and hits the bullseye. Full-strength in story sections; as ambient background run it at ~15–18% opacity with a slight blur.
- **Terminal window**: its own fixed dark palette (`--term-*`) on **both** grounds — it is a picture of a terminal, and terminals are dark. Radius 16, three muted dots, mono 13px/1.75; show the real product loop (prompt → work → concept log → quiz → grade), lines appearing sequentially on an infinite loop with a blinking green block cursor.
- Icons: Lucide line icons only (stroke currentColor, 1.8–2px, round joins), 20–22px in `--spot-soft` tiles.
- **The terminal and the arrow flight are the two showpieces and are not to be redesigned.** They may be recoloured onto the ground tokens; their geometry, timing and behaviour stay.

## Motion
- Easing `cubic-bezier(.2,.6,.2,1)`; micro-interactions 140–200ms; no bounce or spring.
- Scroll reveals: opacity 0 + translateY(18px) → visible over 0.7s, staggered 100–400ms, triggered once by IntersectionObserver (threshold .15).
- Looping showpieces (terminal 16s, arrow flight 9s) are keyframe-driven with percentage windows: elements appear in sequence, hold, all reset together.
- Arrow flight recipe: launch fast and decelerate (`cubic-bezier(.3,0,.4,1)`), bow recoil ~5px on release, target pop 1→1.06→1, two expanding fading ripple rings on impact. The arrow must point one way: head forward, fletching sweeping backward.
- Always honor `prefers-reduced-motion`: collapse animations so content lands in final state.

## Voice
Direct, concise, technically credible. Lead with the outcome; verbs first on buttons ("View on GitHub", "Star on GitHub"). Numbers over adjectives. Reference the legend factually ("he practiced before a statue of his guru — here, the statue talks back"), never cutesy. Keep the product's own copy verbatim where it exists (README taglines, command names, config keys).
