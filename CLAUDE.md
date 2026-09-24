# Working on Eklavya

Eklavya teaches the concepts behind agent-written code and keeps local project
memory. This is the contributor contract for agents working in this repository.
Read the nearest nested `CLAUDE.md` before editing `mcp/`, `hooks/`, `cli/`,
`skills/` or `web/`.

## Repository map

| Path | Responsibility |
|---|---|
| `mcp/src/` | MCP tools, config, SQLite, scheduling, memory, dashboard and the `eklavya` CLI (`cli.ts`) |
| `mcp/src/hooks/` | Hook implementations and shared helpers; registration lives in `hooks/hooks.json` |
| `mcp/src/migrations/`, `mcp/test/` | Forward-only migrations and runtime tests |
| `hooks/run.mjs` | Cross-platform launcher and background repair of an older runtime |
| `skills/` | Slash commands and the tutor entry point with on-demand references |
| `user-skill/` | Chat and artifact skills installed to `~/.claude/skills/`; never move them into `skills/` or they register twice |
| `agents/` | Tutor and background explainer |
| `cli/`, `scripts/` | POSIX git gate, its installer, release version bump |
| `web/` | Landing page and user manual; Astro build deployed to Firebase |
| `docs/` | Contributor references and generated runtime architecture |
| `eval/` | Question, extraction, history, retrieval and performance evaluation; dated results are historical evidence |
| `CONTRIBUTING.md` | Setup, verification, acceptance checks and releases |
| `.claude/skills/` | Repository design and dashboard contracts |

## Documentation is part of every feature

A behavior change is complete only when its documentation ships in the same PR.
Check the manual, landing page and both READMEs against the diff; edit each surface
whose claims changed. If a surface needs no edit, state why in the PR. Do not add
duplicate reference material just to touch a file.

Read the source before documenting names, defaults, limits, paths or output.
`mcp/src/config.ts` owns configuration; each other claim belongs to the module
that implements it. Existing prose and recalled memory are not evidence.

| Change | Documentation to review |
|---|---|
| Install, repair, updates, removal or host support | Manual `installing`, `installation-options`, `updates`, `troubleshooting`; root and package README |
| Dials, defaults, scopes or config keys | Manual `dials`, `configuration`; affected command skills; landing `#dials` |
| Slash commands, CLI or MCP tools | Manual `commands`, `cli`, `memory`; `mcp/README.md`; relevant skills |
| Hook timing, question planning or grading | Manual `first-session`, `how-it-works`, `grading-engine`, `levels-and-tiers`; hook and tutor guidance |
| Commit gating | Manual `commit-gate`; `cli/CLAUDE.md`; setup skill and contributor acceptance checks |
| Memory, providers, privacy or storage | Manual `memory`, `your-data`, `migrating`, `configuration`, `faq` |
| Packs, seeds or concept graph | Manual `packs`; command reference and relevant skills; recount any published totals |
| Dashboard or explainer pages | Manual `dashboard`, `commands`, `configuration`; artifact skill and explainer agent |
| Delegation or host hook contracts | `docs/parallel-tutoring.md`, `docs/subagent-policy.md`, `docs/verified-schemas.md` |

`web/CLAUDE.md` maps every manual page to its exact sources. Add its row and a
sidebar entry whenever adding a page. Update affected diagrams in the same PR;
their labels and branches are claims about the code too.

Keep the README a short introduction and install link. Put ordered tasks in
guides, complete fields and flags in references, and implementation detail in
contributor docs. Use descriptive headings, concrete examples and short sections.
A diagram should clarify sequence or responsibility, have a text explanation,
work on a narrow screen and remain readable in both themes. Document shipped,
verified capabilities; do not imply that a standalone MCP client has Claude
Code's hook-driven learning loop.

## Required checks

1. Run the checks appropriate to the change in `CONTRIBUTING.md`. Isolate tests
   from real learner state with temporary paths or explicit config.
2. Build `web/` when docs or site content changes. Its SEO audit checks built
   links, anchors and assets; inspect changed layouts at 1280, 900 and 560px in
   both themes.
3. Verify commands, config examples and output against their implementation.
   Search for renamed terms across the full repository, excluding dated results.
4. Fill `.github/PULL_REQUEST_TEMPLATE.md`. Behavior changes require the live
   acceptance transcript; tutor changes also require before/after eval evidence.
5. Report any check not run or claim not verified. Never describe a planned
   check as completed.

## Runtime and design invariants

- Hooks fail open and exit 0 on every failure path. They must also have bounded
  stdin reads and avoid waiting for inference.
- Memory and quizzes have independent switches. Memory evidence cannot change
  mastery; only an assessed answer can.
- Migrations are forward-only; update the schema expectations in
  `mcp/test/migrate.test.ts` with each migration.
- Never commit learner databases or anything from `~/.eklavya/`.
- Conventional commits drive releases: `feat:` and `fix:` release; `docs:` and
  `chore:` do not. Keep package/plugin versions aligned through release tooling.
- Before editing the site, read `.claude/skills/eklavya-design/SKILL.md`; before
  editing the dashboard, also read `.claude/skills/eklavya-dashboard/SKILL.md`.
  Use semantic color roles from `web/public/tokens.css`, keyboard-operable
  controls and shareable dashboard filters. Preserve the hero terminal and arrow
  animation's geometry, timing and behavior.

## Generated runtime diagram

Edit `docs/eklavya-runtime.architecture.json`, never the generated HTML. Set
`meta.repository.revision` to the commit whose code supplied the evidence, then
run the installed archify skill (adjust the skill path if installed elsewhere):

```bash
cd ~/.claude/skills/archify
node bin/archify.mjs deliver architecture <repo>/docs/eklavya-runtime.architecture.json \
  <repo>/docs/eklavya-runtime.html --quality showcase --repo-root <repo> --json
node bin/archify.mjs visual-check <repo>/docs/eklavya-runtime.html --json
```

Require all delivery checks with no errors/warnings and every visual viewport
passing. Remove generated PNG/JSON inspection sidecars; they are evidence, not
deliverables. The website copies this artifact during its build. Small manual
flows use `DocFlow.astro`; they do not require regenerating the architecture.

## Communicating with the maintainer

These preferences apply to chat, not to documents or code comments.

- Lead with the answer in plain English. Group topics under headings, use short
  bullets, keep each topic within ten lines, and omit investigation narration.
- Close with `What I need from you:` followed by actions or `Nothing`. Name
  unfinished work and skipped checks explicitly.
- Explain what something does before its implementation. Use a concrete example
  for abstract ideas; keep gotchas visible. Corrections are one line, first.
- When presenting options, recommend one and give its reason and cost. If a
  short-term patch differs from the proper fix, explain both, recommend today's
  action, and say whether the remaining work needs an issue.
- Make each decision understandable in place. Do not use issue numbers or
  references to earlier options as substitutes for explaining the fact.
- For bug explanations before implementation: issue, solution, user impact,
  concrete example, changes needed, recommendation. Once agreed, implement.

Verify before concluding: inspect the specific population, use a measurement
window long enough for the behavior, read callers before claiming a guard is
missing, and inspect the whole diff. A sample cannot prove absence. Check whether
a defect is your own uncommitted change. Falsify your explanation where possible;
if evidence is incomplete, say what would settle it.
