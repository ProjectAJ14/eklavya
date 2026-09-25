---
name: eklavya-artifacts
description: "Use when the user asks for an Eklavya artifact, an explainer page, a visual doc, a one-pager, a report, a diagram writeup, or to \"make this into a page\" — or asks Eklavya to explain a concept or a question they got wrong as a page. Writes a local HTML file under ~/.eklavya/artifacts/<project>/ and opens it. Not for publishing a shareable link."
---

# Eklavya artifacts

An artifact is a single self-contained HTML page on this machine, filed under
`~/.eklavya/artifacts/<project>/` and listed in the Artifacts section of
`eklavya dashboard`. It never becomes a link: nothing here publishes, uploads or
shares, and the page makes no request except for its web fonts.

**Announce at start:** "Writing this as an Eklavya artifact."

## Step 1: Find the binary

`eklavya` is usually not on `PATH`. Resolve it once:

```bash
command -v eklavya || command -v "$HOME/.eklavya/runtime/node_modules/.bin/eklavya"
```

Write the printed path into every later command — shell variables do not
survive between tool calls. On Windows it is `eklavya.cmd` in that same `.bin`
directory. If both print nothing, use `npx -y eklavya`; if that fails too,
Eklavya is not installed — say so and give `npx eklavya install`.

## Step 2: Start the page

Run it from the directory the work is about, so it is filed under that project
(a worktree files under its main checkout):

```bash
eklavya artifacts new "<Title>" --description "<one line: what this page answers>"
```

Add `--kind explainer --concept <slug>` when the page explains an Eklavya
concept, so the dashboard links it to that concept.

It prints the path of a new file, already carrying the Eklavya template: the
design tokens inlined, dark by default, the print stylesheet, the PDF and HTML
download buttons, the title, the lede and the metadata the dashboard reads.
Never write a page from scratch and never pick the path yourself — `new` is the
one place both are decided, and a page without its metadata is listed as a bare
filename.

## Step 3: Write the content

Edit the file: replace the `<!-- CONTENT … -->` comment with the page, and
adjust the lede if the description was too short. Leave the `<head>`, the
`.actions` toolbar and its script, the `.brand` header and the `.made-with`
footer alone: they carry the Eklavya favicon, share tags and link home.

**Write for the person reading it.** Plain English first: what the thing *does*
before what it is called. One idea per section under an `<h2>`. A concrete
example — a timeline, a snippet with the broken and the fixed line — beats a
paragraph of definition. Name the gotcha at the end, in plain terms.

**Draw whenever an idea has moving parts.** A sequence, a branch, a
before/after, a hierarchy or a number worth comparing is a diagram that has not
been drawn yet; two or three in a medium page is normal.

| The thing being explained | Draw |
|---|---|
| Ordered process, pipeline | Step / flow diagram |
| Decision, branch, retry | Gate or decision diagram |
| Who calls whom, over time | Sequence diagram |
| Boxes and boundaries | Architecture diagram |
| States and transitions | State diagram |
| Two options side by side | Comparison table plus a before/after pair |

Draw them as **inline SVG** inside `<figure>`, with the template's classes —
`.svg-box`, `.svg-box-spot` (the one node that matters), `.svg-line`,
`.svg-line-spot`, `.svg-label`, `.svg-small`, `.svg-muted` — and a
`<figcaption>` that states the takeaway, not the title. Never a raster image,
ASCII boxes or a Mermaid script: inline SVG themes and prints, the others do
not.

**Stay on the design system.** Components already in the template: `.eyebrow`,
`.lede`, `.card`, `.grid`, `.chip` (`.warn`, `.bad`), `.stat` (`.k`, `.v`,
`.d`), `.callout`, `td.num`. Reuse them before adding CSS. Any CSS you add
follows Eklavya's rules:

- **Colour names a role**, never a raw hex, `rgba()` or `--vd-*` step. Grounds
  `--bg`, `--panel` (cards), `--mass` (wells, inline code), `--code-bg`; text
  `--ink`, `--dim` (body), `--faint` (captions, labels); hairlines `--line`,
  `--line-2`; accent `--spot`, `--spot-soft` (tints), `--spot-ink` (text on a
  `--spot` fill); state `--warning`, `--error`. `--faint-2` is for disabled
  marks only, never readable text.
- **One accent**, verdigris `--spot`, spent a handful of times: the node that
  matters, a key number, a link. No other hues. `--warning` and `--error` mean
  a real warning or mistake, and always carry a word or mark too — never
  colour alone.
- **Square and flat.** `border-radius: 0` on every box, chip and table; circles
  only for dots. Separate with 1px hairlines, not shadows.
- **Type through the variables**: `--font-disp` (Archivo) for headings,
  `--font-body` (Inter) for text, `--font-mono` (JetBrains Mono) for code,
  commands, concept slugs and small uppercase labels. Sentence case.
- **Icons** are inline Lucide-style line SVG: `stroke="currentColor"`, width 2,
  round caps and joins. No emoji, icon fonts or filled icons.
- **Both grounds.** Every text colour reads at 4.5:1 on ink and on paper —
  check with `data-mode="paper"` on `<html>`. Motion, if any, is short
  (120–320ms on `--ease`) and switched off under `prefers-reduced-motion`.

**Keep it one file.** Everything inline. An external stylesheet, script or
image breaks the HTML download, which hands over the page itself.

Print rules the template already carries, and that new CSS must not undo:
`break-inside: avoid` only on things shorter than a page (rows, cards,
figures); never on a tall wrapper, or the PDF gets half-empty pages. No
`@page` margin — it prints a white frame round a dark page. No
`prefers-color-scheme` block: dark is the default, and `data-mode="paper"` on
`<html>` is the light ground.

## Step 4: Open it

```bash
eklavya artifacts open "<the path new printed>"
```

Report the path in one line. Do not mention links, publishing or sharing.

`eklavya artifacts list` shows every page, newest first (`--here` for this
project, `--json` for the ids); `eklavya dashboard` then **Artifacts** is the
searchable view.

## Common mistakes

| Mistake | Fix |
|---|---|
| Writing the file into the project repository | Artifacts live under `~/.eklavya/artifacts/`, always — `new` puts them there |
| A wall of prose describing a sequence | That is a step diagram. Draw it |
| Raw hex, rounded cards, drop shadows | Role tokens, square chrome, hairlines |
| `html2pdf` or `jspdf` from a CDN | The PDF button is `window.print()` plus the print stylesheet |
| A PDF page two-thirds empty | A `break-inside: avoid` on a block taller than a page |
| White band on top and bottom of the PDF | The print dialog's *Headers and footers* setting; CSS cannot reach it |
