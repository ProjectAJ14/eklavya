---
name: eklavya-design
description: Visual design language for Eklavya (the "learn while your agent works" Claude Code plugin) — landing page, docs, and any Eklavya-branded UI. Use whenever building or restyling Eklavya web surfaces so colors, type, motion, iconography, and voice stay consistent.
---

# Eklavya design skill

Eklavya's look: calm, dark, engineering-grade — a developer tool that quietly references the Ekalavya legend (the self-taught archer) through bow / arrow / target line-art motifs. Never storybook or ornamental.

## Palette
Emerald on cool slate. Green is the only accent; use it sparingly and it reads as brand.

- Green scale: 50 #E6F6EF, 100 #C3EAD8, 200 #8FD8B6, 300 #57C492, 400 #1FAF74, **500 #049D66 (primary)**, 600 #03875A, 700 #036D49, 800 #024E36, 900 #013827
- Neutral slate: 0 #FFFFFF, 50 #F7F9FA, 100 #EEF1F3, 200 #E0E5E9, 300 #CAD2D8, 400 #9AA6AF, 500 #6B7780, 600 #4D575F, 700 #363F45, 800 #21282D, 900 #121619
- Dark surfaces: page bands in neutral-900, story/legend bands in green-900, cards on dark in neutral-800 with neutral-700 hairlines. Light surfaces: white and neutral-50 with neutral-200 hairlines.
- On dark, body text is rgba(255,255,255,.62–.68); accents green-300/400. On light, text neutral-900 / neutral-600; accents green-500–700.
- No other hues. No warm oranges/golds (the generated mascot logo is off-palette — translate its motifs, not its colors). Semantic red/amber only for real errors/warnings.

## Type
- **Manrope** for everything (400–800). Display: 800 weight, tracking -0.02 to -0.025em. H1 ~62px/1.04, H2 40–44px/1.15, body 15–19px/1.6.
- **JetBrains Mono** for code, slash-commands, concept slugs, tier labels, terminal content, tiny index numbers (01, T1…). Mono content on dark is green-300.
- Sentence case everywhere; ALL-CAPS only for 12px/700 eyebrows with +0.08em tracking.
- No emoji.

## Layout
- Content max-width 1140px, 32px side padding; sections pad 96px vertical; 4px base grid.
- Radii: controls 8px, cards 12px, terminals/large surfaces 16px, pills 999px.
- Band rhythm: alternate white / neutral-50 for product sections; reserve dark bands (neutral-900, green-900) for hero, legend/story, and final CTA.
- Backgrounds: flat, plus at most a subtle dot grid (1px dots, 26px tile, ≤7% opacity, masked to fade) and one large soft green radial glow per dark band.

## Signature motifs
- **Bow-and-arrow mark**: white line-art bow (arc + string) with an arrow through it, in a green-500 rounded-8 square.
- **Arrow-flight scene**: line bow → dashed dotted trajectory → concentric-circle target; arrow flies and hits the bullseye. Full-strength in story sections; as ambient background run it at ~15–18% opacity with a slight blur.
- **Terminal window**: neutral-800, radius 16, three muted dots, mono 13px/1.75; show the real product loop (prompt → work → concept log → quiz → grade), lines appearing sequentially on an infinite loop with a blinking green block cursor.
- Icons: Lucide line icons only (stroke currentColor, 1.8–2px, round joins), 20–22px in tiles of green-50 (light) or rgba(4,157,102,.18) (dark).

## Motion
- Easing `cubic-bezier(.2,.6,.2,1)`; micro-interactions 140–200ms; no bounce or spring.
- Scroll reveals: opacity 0 + translateY(18px) → visible over 0.7s, staggered 100–400ms, triggered once by IntersectionObserver (threshold .15).
- Looping showpieces (terminal 16s, arrow flight 9s) are keyframe-driven with percentage windows: elements appear in sequence, hold, all reset together.
- Arrow flight recipe: launch fast and decelerate (`cubic-bezier(.3,0,.4,1)`), bow recoil ~5px on release, target pop 1→1.06→1, two expanding fading ripple rings on impact. The arrow must point one way: head forward, fletching sweeping backward.
- Always honor `prefers-reduced-motion`: collapse animations so content lands in final state.

## Voice
Direct, concise, technically credible. Lead with the outcome; verbs first on buttons ("View on GitHub", "Star on GitHub"). Numbers over adjectives. Reference the legend factually ("he practiced before a statue of his guru — here, the statue talks back"), never cutesy. Keep the product's own copy verbatim where it exists (README taglines, command names, config keys).
