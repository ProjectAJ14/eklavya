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
concept, so the dashboard links it to that concept. When the page is for a
missed question and you were handed its `attempt_id`, also add
`--attempt <attempt_id>`: when the right option was recorded, the page shows a
**Correct your answer** bar in the dashboard's viewer.

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
footer alone: they carry the Eklavya favicon, share tags and link home. Add no
script for the dashboard's viewer (height reports, scrolling, theme messages):
the dashboard adds its own to every page it frames.

**Write for the person reading it.** Plain English first: what the thing *does*
before what it is called. One idea per section under an `<h2>`. A concrete
example — a timeline, a snippet with the broken and the fixed line — beats a
paragraph of definition. Name the gotcha at the end, in plain terms.

**Draw whenever an idea has moving parts.** A sequence, a branch, a
before/after, a hierarchy or a number worth comparing is a diagram that has not
been drawn yet; two or three in a medium page is normal.

**Pick the diagram from the idea, not from habit.** Every page so far has been
one left-to-right row of boxes. Choose the type that matches the shape of the
thing, and when a page has two or three diagrams, make them different types.

| The idea | Draw | Colour it by |
|---|---|---|
| Ordered steps, a pipeline | **Step flow** | actor or phase |
| Who calls whom, over time | **Sequence** (lifelines, numbered messages) | one colour per participant |
| A choice, a retry, a guard | **Decision** (diamonds, yes/no edges) | the outcome: `.svg-ok` / `.svg-bad` |
| Several actors or layers share a job | **Swimlane** | one lane per actor |
| Parts and boundaries | **Layered architecture** (nested zones) | the layer or trust boundary |
| States and transitions | **State machine** | the kind of state; terminal state in `-spot` |
| Before vs after, broken vs fixed | **Split panel** | `.svg-bad` left, `.svg-ok` right, only for a real fault and its fix |
| Quantities, costs, counts | **Bars** (`.svg-bar-N`, value printed on each) | the series |
| Parent and child, nesting | **Tree** | depth or kind |
| Time and overlap | **Timeline strip** (one row per actor, bars on an axis) | the actor |
| A cycle that feeds itself | **Loop** (nodes on a ring, arrows clockwise) | the phase |
| Two measures, four verdicts | **Quadrant** (2×2 with labelled corners) | the quadrant |
| Narrowing or ranking | **Funnel / pyramid** (stacked bars, count on each) | the stage |
| Tables and their links | **Schema / ER** (box per table, key columns, lines with 1 / n) | the owner of the data |
| Many things against many | **Matrix / heatmap** (grid, one tint per cell, value printed) | the value band |
| What overlaps, what is only in one | **Venn** (two or three circles, `fill-opacity` via `-soft`) | the set |

**Before drawing, decide in one line**: the type, the one thing the reader should
take away, and what you will leave out. Deleting a box usually improves a
diagram more than adding one. Avoid:

- a generic row of identical rounded boxes when a lane, layer or axis would
  show the structure;
- decoration with no meaning (icons, gradients, extra arrows, a legend for one colour);
- a colour used on everything: colour the groups, and let `-spot` mark the one
  thing that matters;
- a diagram of a list (use a table) or of a single shape (use a sentence);
- invented detail: every label is a real name from the code or the question.

Layout: snap coordinates, widths and gaps to multiples of 4 so edges line up;
keep 16px between a shape and its text; one idea per diagram, at most about
eight nodes. Give every `<svg>` a `<title>` and a one-sentence `<desc>` as its
first children, as well as `role="img"` and `aria-label`.

Draw them as **inline SVG** inside `<figure>`, with a `<figcaption>` that
states the takeaway, not the title. Never a raster image, ASCII boxes or a
Mermaid script: inline SVG themes and prints, the others do not. The first
`<figure>` diagram is the page's thumbnail in the dashboard's Artifacts
gallery, so put the one that explains the page first.

SVG classes (all role colours, so both grounds work):

- Neutral: `.svg-box`, `.svg-line`, `.svg-label`, `.svg-small`, `.svg-muted`,
  `.svg-chip`, `.svg-axis`, `.svg-lane`, `.svg-life` (lifeline), `.svg-dash`
  (add to a line for "optional" or "reply"), `.svg-head` (arrowhead).
- **Categories 1–5**: `.svg-box-N` (tinted fill, coloured edge), `.svg-line-N`,
  `.svg-bar-N`, `.svg-text-N` (coloured heading), `.svg-head-N` (arrowhead).
  Colour means *a group*: assign 1 to the first actor, 2 to the second, and keep
  it for the whole page. Use at most four categories in one diagram, and put
  the group's name in text on or beside every coloured shape, so the diagram
  still reads in print and without colour. A legend is a row of small
  `.svg-box-N` squares with a `.svg-small` label.
- State: `.svg-ok` (fixed, allowed), `.svg-bad` (broken, rejected),
  `.svg-box-spot` / `.svg-line-spot` (the one node or edge the page is about).

Arrowheads: put one `<defs>` in the diagram,
`<marker id="a1" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="svg-head" d="M0 0L8 4L0 8z"/></marker>`,
and set `marker-end="url(#a1)"` on a line. Marker ids are shared by the whole
page, so use `a1`, `a2`, `a3`, … across diagrams, never the same id twice. Give every
`<svg>` a `viewBox`, `role="img"` and an `aria-label`; keep text at least 11px
at the viewBox size and keep the width at 640 so it fits a phone.

Skeletons (copy, then change the words and the numbers):

```html
<!-- Sequence: lifelines, one colour per participant -->
<svg viewBox="0 0 640 220" role="img" aria-label="Browser asks the API, which asks the database">
  <defs><marker id="a1" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="svg-head" d="M0 0L8 4L0 8z"/></marker></defs>
  <rect class="svg-box-1" x="40" y="10" width="120" height="34"/><text class="svg-text-1" x="100" y="32" text-anchor="middle">Browser</text>
  <rect class="svg-box-2" x="260" y="10" width="120" height="34"/><text class="svg-text-2" x="320" y="32" text-anchor="middle">API</text>
  <rect class="svg-box-3" x="480" y="10" width="120" height="34"/><text class="svg-text-3" x="540" y="32" text-anchor="middle">Database</text>
  <line class="svg-life" x1="100" y1="44" x2="100" y2="210"/><line class="svg-life" x1="320" y1="44" x2="320" y2="210"/><line class="svg-life" x1="540" y1="44" x2="540" y2="210"/>
  <line class="svg-line-1" x1="100" y1="86" x2="316" y2="86" marker-end="url(#a1)"/><text class="svg-small" x="110" y="78">1 GET /orders</text>
  <line class="svg-line-2" x1="320" y1="126" x2="536" y2="126" marker-end="url(#a1)"/><text class="svg-small" x="330" y="118">2 SELECT</text>
  <line class="svg-line-3 svg-dash" x1="536" y1="166" x2="324" y2="166" marker-end="url(#a1)"/><text class="svg-small" x="360" y="158">3 rows</text>
</svg>

<!-- Swimlane: a band per actor, steps inside it -->
<svg viewBox="0 0 640 200" role="img" aria-label="The client validates, the server saves">
  <defs><marker id="a2" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="svg-head-1" d="M0 0L8 4L0 8z"/></marker></defs>
  <rect class="svg-lane" x="0" y="0" width="640" height="90"/><text class="svg-text-1" x="12" y="20">Client</text>
  <rect class="svg-lane" x="0" y="100" width="640" height="90"/><text class="svg-text-2" x="12" y="120">Server</text>
  <rect class="svg-box-1" x="110" y="30" width="140" height="44"/><text class="svg-label" x="180" y="57" text-anchor="middle">Validate form</text>
  <rect class="svg-box-2" x="330" y="130" width="140" height="44"/><text class="svg-label" x="400" y="157" text-anchor="middle">Save order</text>
  <path class="svg-line-1" d="M250 52H290V152H326" marker-end="url(#a2)"/>
</svg>

<!-- Decision: diamond, outcomes coloured by result -->
<svg viewBox="0 0 640 180" role="img" aria-label="If the token is expired, refresh it, otherwise send the request">
  <polygon class="svg-box-spot" points="120,20 200,70 120,120 40,70"/><text class="svg-label" x="120" y="74" text-anchor="middle">Expired?</text>
  <line class="svg-line-spot" x1="200" y1="70" x2="330" y2="70"/><text class="svg-small" x="250" y="60">yes</text>
  <rect class="svg-box-2" x="330" y="48" width="150" height="44"/><text class="svg-label" x="405" y="75" text-anchor="middle">Refresh token</text>
  <line class="svg-line" x1="120" y1="120" x2="120" y2="150"/><text class="svg-small" x="130" y="140">no</text>
  <rect class="svg-ok" x="40" y="150" width="160" height="26"/><text class="svg-label" x="120" y="168" text-anchor="middle">Send request</text>
</svg>

<!-- State machine: rounded states, labelled edges -->
<svg viewBox="0 0 640 140" role="img" aria-label="An order goes from draft to paid to shipped">
  <defs><marker id="a3" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path class="svg-head" d="M0 0L8 4L0 8z"/></marker></defs>
  <rect class="svg-box-1" x="20" y="50" width="130" height="40"/><text class="svg-text-1" x="85" y="75" text-anchor="middle">draft</text>
  <rect class="svg-box-2" x="260" y="50" width="130" height="40"/><text class="svg-text-2" x="325" y="75" text-anchor="middle">paid</text>
  <rect class="svg-box-spot" x="490" y="50" width="130" height="40"/><text class="svg-label" x="555" y="75" text-anchor="middle">shipped</text>
  <line class="svg-line" x1="150" y1="70" x2="258" y2="70" marker-end="url(#a3)"/><text class="svg-small" x="170" y="62">pay()</text>
  <line class="svg-line" x1="390" y1="70" x2="488" y2="70" marker-end="url(#a3)"/><text class="svg-small" x="408" y="62">ship()</text>
</svg>

<!-- Bars: value printed on every bar -->
<svg viewBox="0 0 640 150" role="img" aria-label="Query time before 840 ms, after 60 ms">
  <line class="svg-axis" x1="110" y1="10" x2="110" y2="130"/>
  <text class="svg-small" x="10" y="42">before</text><rect class="svg-bar-2" x="110" y="26" width="440" height="24"/><text class="svg-label" x="558" y="43">840 ms</text>
  <text class="svg-small" x="10" y="92">after</text><rect class="svg-bar-1" x="110" y="76" width="34" height="24"/><text class="svg-label" x="152" y="93">60 ms</text>
</svg>
```

Whatever the type, it shows the real mechanism of *this*
page, with the real names from the code, not a generic boxes-and-arrows
picture. Check it at phone width (labels not clipped, nothing overlapping).

**Stay on the design system.** Components already in the template: `.eyebrow`,
`.lede`, `.card`, `.grid`, `.chip` (`.warn`, `.bad`), `.stat` (`.k`, `.v`,
`.d`), `.callout`, `td.num`, and `ol.options` with `li.picked` / `li.right`
for restating a missed question; put the one-line note shown under an option
in the question in `<span class="note">…</span>` inside its `<li>`. Code goes in `<pre><code>`, escaped, with
`data-lang="css"` (or `ts`, `sql`, …) on the `<pre>` for its label; the template
colours comments, keywords, strings and numbers itself, so never hand-colour it.
Reuse these before adding CSS. Any CSS you add
follows Eklavya's rules:

- **Colour names a role**, never a raw hex, `rgba()` or `--vd-*` step. Grounds
  `--bg`, `--panel` (cards, code blocks), `--mass` (wells, inline code), `--code-bg`; text
  `--ink`, `--dim` (body), `--faint` (captions, labels); hairlines `--line`,
  `--line-2`; accent `--spot`, `--spot-soft` (tints), `--spot-ink` (text on a
  `--spot` fill); state `--warning`, `--error`. `--faint-2` is for disabled
  marks only, never readable text.
- **One accent for the page**, verdigris `--spot`, spent a handful of times: the
  node that matters, a key number, a link. **Diagrams may also use the five
  category roles** `--viz-1` … `--viz-5` (teal, amber, blue, violet, rose) and
  their `-soft` tints, through the `.svg-*-N` classes only. A colour names a
  group and always carries a word. `--warning` and `--error` mean a real
  warning or mistake: use `.svg-bad` for a fault, never a category colour.
  No other hues, and no category colour outside a diagram.
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

It prints what it opened: the page's address in the dashboard's viewer, where
it opens as a tab (when the background dashboard is on), or else the file. Report
the path in one line. Do not mention links, publishing or sharing.

`eklavya artifacts list` shows every page, newest first (`--here` for this
project, `--json` for the ids); `eklavya dashboard` then **Artifacts** is the
searchable view.

## Common mistakes

| Mistake | Fix |
|---|---|
| Writing the file into the project repository | Artifacts live under `~/.eklavya/artifacts/`, always — `new` puts them there |
| A wall of prose describing a sequence | That is a step diagram. Draw it |
| Every diagram is a grey row of boxes | Pick the type from the table; colour by actor or layer |
| A colour with no label, or the same marker id in two diagrams | Name the group in text; `a1`, `a2`, … once each |
| Raw hex, rounded cards, drop shadows | Role tokens, square chrome, hairlines |
| `html2pdf` or `jspdf` from a CDN | The PDF button is `window.print()` plus the print stylesheet |
| A PDF page two-thirds empty | A `break-inside: avoid` on a block taller than a page |
| White band on top and bottom of the PDF | The print dialog's *Headers and footers* setting; CSS cannot reach it |
