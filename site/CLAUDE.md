# Working on `site/`

Two pages, no build step, deployed as-is by `.github/workflows/pages.yml` (GitHub
Pages) and `.github/workflows/firebase.yml` (Firebase Hosting, `cleanUrls: true`).

| File | What it is |
|---|---|
| `index.html` | the landing page — the pitch. Skimmable, opinionated, short. |
| `docs.html` | the manual — served at `/docs`. Complete, literal, boring on purpose. |
| `tokens.css` | the NonStop design system, verbatim. **Do not edit.** |
| `styles.css` | landing-page components. Loaded by both pages (nav, footer, buttons, `.wrap`). |
| `docs.css` | docs-only components. Loaded by `docs.html` only. |
| `app.js` / `docs.js` | per-page behaviour. Vanilla, no dependencies. |

Link to the docs as `href="docs.html"`, never `/docs`: Firebase rewrites the
former to the clean URL, and the latter 404s on a plain static host.

## The rule that matters

**`docs.html` is a test of the source, not prose about it.** Every default,
flag, tier, threshold and command name on it was read out of the code. When you
change behaviour, update the matching section in the same commit — and read the
value out of the file below rather than copying what the page already says, or
the page compounds its own drift.

| Docs section | Source of truth |
|---|---|
| `#requirements` | `mcp/package.json` `engines`, `hooks/lib.sh` (`jq`, `sqlite3`) |
| `#install` | `README.md` install block, `.mcp.json`, `mcp/bin/eklavya-mcp.sh` |
| `#setup` | `skills/setup/SKILL.md` |
| `#first-session` | `hooks/hooks.json` and the four hook scripts |
| `#dials` | `Mode`, `Focus`, `Cadence`, `Difficulty` in `mcp/src/config.ts` |
| `#levels` | `TIER_LABEL` in `mcp/src/ask.ts`; `LEVEL_BANDS`, `LEVEL_UP_MIN_CONCEPTS`, `checkPromotion` in `mcp/src/srs.ts` |
| `#commands` | one `<article class="cmd">` per skill under `skills/` |
| `#cli` | the `USAGE` string in `mcp/src/cli.ts` |
| `#config` | `DEFAULT_CONFIG` in `mcp/src/config.ts` — every key, no omissions |
| `#gate` | `mcp/src/store.ts` (`PASSING_GRADE`, `syncGate`, `gateRetryConcepts`), `cli/eklavya-gate`, `hooks/pre-tool-gate.sh`, `scripts/install-git-hook.sh` |
| `#dashboard` | `DEFAULT_PORT` and `startDashboard` in `mcp/src/dashboard.ts` |
| `#engine` | `mcp/src/srs.ts` constants; the `get_session_quiz_plan` and `record_attempt` tool descriptions |
| `#data` | `mcp/src/paths.ts`, `mcp/src/migrations/` |

Adding a section means adding its row here and a link in the sidebar TOC.

## Writing conventions for `docs.html`

- **Audience: a developer in their first week.** No prior MCP knowledge. Explain
  the jargon the first time it appears, in one clause, then use it freely.
- **Say what happens, then why.** The why is one sentence, never a paragraph.
- Sentence case. No emoji. Second person. Present tense.
- **Numbers over adjectives.** "Four options, capped at grade 4" beats "a few
  carefully chosen options".
- **Never document unshipped work.** `prd/` describes phases that are specified
  but not built; those stay off the page until the code exists. "The code
  exists" is not enough on its own — the acceptance criterion has to be ticked.
  **Cursor is the standing example:** `eklavya export-rules` is implemented and
  tested, and the git gate is genuinely editor-agnostic, but
  `prd/phase-5-distribution.md` still has *"Clean machine: Cursor with one
  `mcpServers` entry → tools reachable, git gate enforced"* unticked, and Cursor
  gets no hooks at all — no session profile, no mid-task checkpoints, no
  end-of-task sweep, which is the entire ambient loop. Documenting it was
  promising the headline feature somewhere it does not run, so it came out of
  `docs.html`, `index.html` and `README.md`. Put it back when that box is
  ticked, and lead with what Cursor does *not* get.
- Prefer a table when every row has the same shape, a `<ol class="doc-steps">`
  when order matters, and prose when neither is true. A two-row table is prose
  pretending to be data.
- Every command block that a reader would paste must be runnable verbatim.
  Placeholders are `/path/to/eklavya` and `<topic>`, consistently.
- Do not invent Claude Code UI affordances. If a flow is not verified in
  `docs/verified-schemas.md`, the README, or a skill, describe it as the
  interactive `/plugin` menu rather than guessing a subcommand.

## Page structure

`docs.html` is one `<main class="doc">` of sibling `<section>`s, each with:

```html
<section id="config" aria-labelledby="config-h">
  <p class="doc-kicker">10 — Reference</p>
  <h2 id="config-h">Configuration</h2>
```

The kicker's number is the section's position and its label is the sidebar group
it belongs to — renumber the ones after when you insert a section. One `<h1>`
(the hero), `<h2>` per section, `<h3>` for topics, `<h4>` inside steps and
command blocks. Never skip a level.

Available components, all styled in `docs.css`: `.doc-table` inside a
`.doc-table-wrap` (the wrapper is what makes a wide table scroll instead of the
page), `.doc-steps`, `.doc-timeline`, `.doc-checks`, `.note` /
`.note--tip` / `.note--warn`, `.cmd` for a per-command block, `.tag` for an
inline pill. Reach for one of these before writing a new class.

Code blocks are `<pre><code>`; add `data-lang="Terminal"` for the label above
them. `docs.js` injects the copy button — do not add one by hand.

## CSS

- Express everything against `tokens.css` custom properties. A raw hex in
  `docs.css` or `styles.css` is a bug; the only exceptions are the dot-grid and
  glow overlays, which need alpha on a specific ground.
- `.claude/skills/eklavya-design/SKILL.md` is the visual language: emerald on
  cool slate, Manrope and JetBrains Mono, bow-and-arrow motifs, no emoji.
- Grid columns that hold code blocks need `minmax(0, 1fr)`, not `1fr` — an
  `auto` track refuses to shrink below the widest `<pre>` and pushes the whole
  page sideways.
- Honour `prefers-reduced-motion` in anything animated.

## Before you commit

```bash
python3 -m http.server 8787    # from site/
```

Check, every time:

1. **1280, 900 and 560px.** The 900 and 560 breakpoints are ours, not the
   original design's, so they break first.
2. **No horizontal page scroll** at 560. A wide table must scroll inside its
   `.doc-table-wrap`, never move the page:
   `document.documentElement.scrollWidth === document.documentElement.clientWidth`.
3. **No console errors**, and the sidebar highlight tracks as you scroll.
4. **Every anchor resolves** — the sidebar, the cross-links between sections,
   and `index.html`'s `docs.html#…` cards:

```bash
python3 - <<'EOF'
import re
h = open('docs.html').read(); i = open('index.html').read()
ids = set(re.findall(r'id="([^"]+)"', h))
print("broken:", sorted(set(re.findall(r'href="#([^"]+)"', h)) - ids))
print("from index:", sorted(set(re.findall(r'href="docs\.html#([^"]+)"', i)) - ids))
EOF
```

Site-only work is a `docs:` commit — it does not cut a release.
