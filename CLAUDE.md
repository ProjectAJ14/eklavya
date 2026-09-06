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
| `user-skill/` | the one skill installed to `~/.claude/skills/`, not shipped in the plugin — it drives the CLI from plain chat. Must never be under `skills/`, or it registers twice |
| `agents/` | the tutor subagent |
| `cli/` | the `eklavya` binary: config, export-rules, diagnostics |
| `prd/` | the spec and one file per delivered phase |
| `CONTRIBUTING.md` | development setup, the manual test scripts, the release process |
| `web/` | the site: the landing page (`public/`) and the manual (Astro Starlight, `src/content/docs/docs/`), deployed to Firebase Hosting. See `web/CLAUDE.md` |
| `assets/` | README artwork |

## The site is part of the feature

`web/` is user-facing documentation, not decoration. **Any change to what
Eklavya does or how it is configured is not finished until the landing page, the
manual and `README.md` all say the same thing.** A feature branch that changes
behaviour and touches no documentation is an incomplete branch, and the docs are
not a follow-up ticket — they ship in the same commit as the code.

That applies to:

- a new or renamed config key, or a changed default
- a new value for `mode`, `focus` or `cadence` — or a fifth dial
- a new, renamed or removed slash command, or a change to what `user-skill/` can do
- a change to the quiz loop: when questions arrive, what shape they take, how
  they are graded, what the gate requires
- a change to where data is stored or what leaves the machine

The page went stale exactly this way once: it shipped describing `mode` alone,
then `focus` and `cadence` landed and the page kept promising two dials and
five commands. Treat it like a test that has to be updated with the code.

Concretely, when you change behaviour, check these against the diff:

| Landing page section (`web/public/index.html`) | Must match |
|---|---|
| hero terminal script | the real loop for the default config |
| `#how` steps and tier ladder | the actual sequence and tier meanings |
| `#dials` | `Mode`, `Focus`, `Cadence`, `Difficulty` in `mcp/src/config.ts`, defaults included |
| `#commands` | the user-invocable skills under `skills/`, plus `user-skill/` |
| data card, install/CTA blocks | `paths.ts`, the setup skill's requirements |

The manual (`web/src/content/docs/docs/`) carries the heaviest duty of all: it
spells out every command's arguments, every config key with its default, every
CLI subcommand, the tier and level bands, and the gate's arithmetic. It goes
stale faster than the landing page because it says more. `web/CLAUDE.md` has the
per-page source-of-truth map and the writing conventions — read it before
editing anything under `web/`.

`README.md` is deliberately short: a pitch, the one install command, and links
into the manual. Resist re-adding reference material to it — a second copy of the
dials or the config keys is a second thing to keep in step, and it is the copy
nobody remembers to update. Everything a contributor needs lives in
`CONTRIBUTING.md`. Where any of them disagree with the code, `mcp/src/config.ts`
is the source of truth.

Do not advertise unshipped work. `prd/` describes phases that are specified but
not implemented (question formats beyond multiple choice, for one) — those stay
out of `web/` until the code exists.

## Editing the site

Two halves on one ground: the landing page is hand-written HTML in
`web/public/`, and the manual is Astro Starlight in `web/src/content/docs/docs/`.
`npm run build` from `web/` produces `dist/`, which is what Firebase serves.

`web/public/tokens.css` holds the design tokens as two layers — a scale, then
two grounds (`ink` and `paper`) that redefine the same role names. Components
name a role (`--ink`, `--dim`, `--line`, `--spot`), never a scale step or a raw
hex; doing otherwise pins a component to one ground and breaks the theme toggle.
`.claude/skills/eklavya-design/SKILL.md` is the visual language: verdigris on
warm ink or warm paper, Archivo and Inter and JetBrains Mono, square chrome,
hairline rules, bow-and-arrow motifs, no emoji.

Preview with `npm run build && npm run preview` from `web/`, and check 1280, 900
and 560px **in both grounds** — a bug that only shows on paper is the commonest
kind. `web/CLAUDE.md` has the full pre-commit checklist.

## Conventions

- Conventional commits; semantic-release publishes from `main`. `feat:` and
  `fix:` cut a release, `docs:` and `chore:` do not — site and README work is
  `docs:`.
- Migrations are forward-only. Adding one means bumping the schema constants in
  `mcp/test/migrate.test.ts` in the same change.
- Hooks must never break a session: every failure path exits 0.
- Never commit a learner's `knowledge.db` or anything under `~/.eklavya/`.
