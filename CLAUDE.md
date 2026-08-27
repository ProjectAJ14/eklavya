# Working on Eklavya

Eklavya is a Claude Code plugin that teaches the developer the concepts behind
the code an agent just wrote. This file is the contributor contract for agents
working in this repo.

## Layout

| Path | What lives there |
|---|---|
| `mcp/src/` | the MCP server: config, store, SM-2 scheduling, quiz planning, tools |
| `mcp/src/migrations/` | SQLite migrations, forward-only |
| `hooks/` | SessionStart, PostToolUse checkpoint, Stop quiz gate, commit gate |
| `skills/` | the prompt-side behaviour; each skill with `disable-model-invocation: true` is also a `/eklavya:<name>` slash command |
| `agents/` | the tutor subagent |
| `cli/` | the `eklavya` binary: config, export-rules, diagnostics |
| `prd/` | the spec and one file per delivered phase |
| `site/` | the landing page, deployed to GitHub Pages |
| `assets/` | README artwork |

## The landing page is part of the feature

`site/` is user-facing documentation, not decoration. **Any change to what
Eklavya does or how it is configured is not finished until `site/` says the
same thing.** That includes:

- a new or renamed config key, or a changed default
- a new value for `mode`, `focus` or `cadence` — or a fourth dial
- a new, renamed or removed slash command
- a change to the quiz loop: when questions arrive, what shape they take, how
  they are graded, what the gate requires
- a change to where data is stored or what leaves the machine

The page went stale exactly this way once: it shipped describing `mode` alone,
then `focus` and `cadence` landed and the page kept promising two dials and
five commands. Treat it like a test that has to be updated with the code.

Concretely, when you change behaviour, check these against the diff:

| Landing page section | Must match |
|---|---|
| hero terminal script | the real loop for the default config |
| `#how` steps and tier ladder | the actual sequence and tier meanings |
| `#dials` | `Mode`, `Focus`, `Cadence` in `mcp/src/config.ts`, defaults included |
| `#commands` | the user-invocable skills under `skills/` |
| data card, install/CTA blocks | `paths.ts`, the setup skill's requirements |

`README.md` and `.eklavya.json.example` carry the same duty. If the three
disagree, `mcp/src/config.ts` is the source of truth.

Do not advertise unshipped work. `prd/` describes phases that are specified but
not implemented (question formats beyond multiple choice, for one) — those stay
out of `site/` until the code exists.

## Editing the site

Plain HTML, CSS and JS in `site/`, no build step; the Pages workflow uploads the
folder as-is. `site/tokens.css` is the design system verbatim — do not edit it,
and express component styles against its custom properties rather than raw
hexes. `.claude/skills/eklavya-design/SKILL.md` is the visual language: emerald
on cool slate, Manrope and JetBrains Mono, bow-and-arrow motifs, no emoji.

Preview with `python3 -m http.server` from `site/`, and check 900px and 560px —
the original design was desktop-only and the breakpoints are ours.

## Conventions

- Conventional commits; semantic-release publishes from `main`. `feat:` and
  `fix:` cut a release, `docs:` and `chore:` do not — site and README work is
  `docs:`.
- Migrations are forward-only. Adding one means bumping the schema constants in
  `mcp/test/migrate.test.ts` in the same change.
- Hooks must never break a session: every failure path exits 0.
- Never commit a learner's `knowledge.db` or anything under `~/.eklavya/`.
