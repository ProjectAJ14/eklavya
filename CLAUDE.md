# Working on Eklavya

Eklavya is a Claude Code plugin that teaches the developer the concepts behind
the code an agent just wrote. This file is the contributor contract for agents
working in this repo.

## Layout

| Path | What lives there |
|---|---|
| `mcp/src/` | the MCP server: config, store, SM-2 scheduling, quiz planning, tools — and `cli.ts`, which builds to `dist/cli.js`, the `eklavya` binary |
| `mcp/src/migrations/` | SQLite migrations, forward-only |
| `mcp/src/hooks/` | the hook logic, in TypeScript — one file per hook, plus the shared `lib.ts` |
| `mcp/test/` | the vitest suite: `cd mcp && npm test` |
| `hooks/` | `hooks.json` and `run.mjs`, the one cross-platform entry point. Five hooks: SessionStart, UserPromptSubmit (the log-directive nudge), PreToolUse (`Bash`, the commit gate), PostToolUse (the log-concepts checkpoint), Stop. Every one dispatches into `mcp/src/hooks/` |
| `skills/` | the prompt-side behaviour; each skill with `disable-model-invocation: true` is also a `/eklavya:<name>` slash command. `tutor/` is the pedagogy, split into a short `SKILL.md` and `tutor/references/*.md` the model reads on demand |
| `user-skill/` | the one skill installed to `~/.claude/skills/`, not shipped in the plugin — it drives the CLI from plain chat. Must never be under `skills/`, or it registers twice |
| `agents/` | the tutor subagent |
| `cli/`, `scripts/` | the editor-agnostic commit gate: `cli/eklavya-gate` is a POSIX script (no Node startup cost in a git hook), `scripts/install-git-hook.sh` installs it. `scripts/bump-version.sh` is the release's version bump |
| `docs/` | contributor reference, not the manual: the pinned plugin/hook/MCP schemas and parallel tutoring, both kept current by hand. `eklavya-runtime.html` is **generated** from `eklavya-runtime.architecture.json` and stamped with the revision it was built from — edit the JSON, never the HTML, then regenerate (see below) |
| `eval/` | the question-quality eval: fixtures, a four-stage harness, and dated results. Measures the product (are the questions good) rather than the machinery. Never runs in CI — two of its four stages cost a model call per question. `eval/README.md` has the method and what would disprove it |
| `prd/` | the spec and one file per phase, with `prd/README.md` as the delivery tracker |
| `CONTRIBUTING.md` | development setup, the manual test scripts, the release process |
| `web/` | the site: the landing page (`public/`) and the manual (Astro Starlight, `src/content/docs/docs/`), deployed to Firebase Hosting. See `web/CLAUDE.md` |
| `.claude/skills/` | this repo's own working skills: the visual language and the dashboard contract |
| `assets/` | README artwork |

**Five directories carry their own `CLAUDE.md`, and it is the one to read
before you edit anything inside them**: `mcp/`, `hooks/`, `cli/`, `skills/` and
`web/`. This file is the shape of the repo and the rules that cross it; those
files hold the invariants each directory enforces and the failure each one
prevents. A change that breaks one of them is a change that passes review and
breaks a learner's session a week later.

## The runtime diagram is generated

`docs/eklavya-runtime.html` is a 700KB artifact rendered from
`docs/eklavya-runtime.architecture.json` by the `archify` skill. Hand-editing the
HTML is how it silently stops matching its own spec. Change the JSON, then:

```bash
cd ~/.claude/skills/archify
node bin/archify.mjs deliver architecture <repo>/docs/eklavya-runtime.architecture.json \
  <repo>/docs/eklavya-runtime.html --quality showcase --repo-root <repo> --json
node bin/archify.mjs visual-check <repo>/docs/eklavya-runtime.html --json
```

`deliver` must report 9/9 checks with 0 errors and 0 warnings, and `visual-check`
must pass every viewport — the artifact fits 1440x900 with nothing to spare, so
a card line one word too long overflows it. `visual-check` writes PNG and JSON
sidecars next to the HTML; they are evidence, not deliverables, so delete them.

Bump `meta.repository.revision` to the commit the evidence was read at, or every
source permalink in the diagram points at the wrong code.

## The site is part of the feature

`web/` is user-facing documentation, not decoration. **Any change to what
Eklavya does or how it is configured is not finished until the landing page, the
manual and `README.md` all say the same thing.** A feature branch that changes
behaviour and touches no documentation is an incomplete branch, and the docs are
not a follow-up ticket — they ship in the same commit as the code.

That applies to:

- a new or renamed config key, or a changed default
- a new value for `mode`, `focus`, `cadence` or `difficulty` — or a fifth dial
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

## The dashboard is a third surface

`eklavya dashboard` (`mcp/src/dashboard.ts` and `mcp/src/assets/dashboard.html`)
is a web page too, on the same tokens as the site, and it has its own rules:
one JSON payload of flat rows with every view derived in the browser, a hash
router, hand-rolled SVG charts, and an interaction contract — the wordmark goes
home, anything clickable is keyboard-operable, a filter worth linking to lives
in the hash. **Read `.claude/skills/eklavya-dashboard/SKILL.md` before touching
either file.** Its manual page, `web/src/content/docs/docs/dashboard.mdx`, ships
in the same commit as the change, like every other doc here.

## Conventions

- Conventional commits; semantic-release publishes from `main`. `feat:` and
  `fix:` cut a release, `docs:` and `chore:` do not — site and README work is
  `docs:`.
- Migrations are forward-only. Adding one means bumping the schema constants in
  `mcp/test/migrate.test.ts` in the same change.
- Hooks must never break a session: every failure path exits 0.
- Never commit a learner's `knowledge.db` or anything under `~/.eklavya/`.
