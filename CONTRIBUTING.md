# Contributing to Eklavya

Everything a contributor needs. If you are here to *use* Eklavya rather than work
on it, the manual is at **[eklavya-run.web.app/docs](https://eklavya-run.web.app/docs/)**.

The site itself has its own contract in [`web/CLAUDE.md`](web/CLAUDE.md), and the
repo-wide conventions are in [`CLAUDE.md`](CLAUDE.md). Read those before changing
behaviour: a branch that changes what Eklavya does and touches no documentation is
an incomplete branch.

## Manual test scripts

Automated coverage is `cd mcp && npm test` — 16 files under `mcp/test/`. (No count here on purpose: it drifts every feature branch and nothing asserts it.) These are the by-hand checks behind each phase's acceptance demo.

<details>
<summary><b>Phase 0 — scaffold</b></summary>

```bash
cd mcp && npm install && npm run build
node dist/cli.js doctor
sqlite3 ~/.eklavya/knowledge.db '.tables'
```
Expect all ten tables (`EXPECTED_TABLES` in `mcp/test/migrate.test.ts` is the list) and 87 concepts across four domains.
</details>

<details>
<summary><b>Phase 1 — the teaching loop</b></summary>

1. `claude --plugin-dir /path/to/eklavya`
2. Ask it to build a small Express endpoint with JWT auth.
3. `/eklavya:quiz` — questions should name *your* files and decisions, not textbook definitions.
4. Answer one well. Check it landed:
   ```bash
   sqlite3 ~/.eklavya/knowledge.db 'select c.slug, m.score, m.next_review from mastery m join concepts c on c.id=m.concept_id'
   ```
5. Answer the same concept well a second time, then `/eklavya:quiz` again — it must not come back.
6. `/eklavya:progress` should show it as known.
</details>

<details>
<summary><b>Phase 2 — the ambient loop</b></summary>

1. In a fresh session, ask for a small feature and let it finish. A quiz should arrive with no command from you.
2. Say **skip**. It should accept it and stop — *and must not ask again for the same work*. This is the failure mode to watch for.
3. Quit and restart Claude Code. The first line should be your learner profile.
4. `eklavya config set quiet true` → restart → no banner.
</details>

<details>
<summary><b>Phase 3 — the commit gate</b></summary>

```bash
cd /some/test/repo
eklavya config set mode enforced --repo
/path/to/eklavya/scripts/install-git-hook.sh
```

1. In Claude Code, have it build something, then ask it to commit → the commit is denied with an explanation.
2. From a bare terminal: `git commit -m x` → blocked with the same reasoning.
3. `/eklavya:quiz`, answer properly, `/eklavya:gate` shows passed.
4. Both commit paths now succeed.
5. In a repo *without* `.eklavya.json`, nothing is gated. Confirm it.
6. `scripts/install-git-hook.sh --uninstall` restores any hook you had before.
</details>

<details>
<summary><b>Phase 4 — parallel tutoring</b></summary>

Follow [`docs/parallel-tutoring.md`](docs/parallel-tutoring.md): two panes sharing `EKLAVYA_SESSION_ID`, one building and one teaching. Answering in the teaching pane should release the gate holding the building pane's commit.
</details>

## Development

```bash
cd mcp
npm install          # approve the better-sqlite3 install script if npm asks
npm test             # builds, then unit + hook + gate + concurrency + stdio integration tests
npm run test:watch
claude plugin validate ..
```

The same suite runs in CI on every pull request and every push to a branch
other than `main` ([`.github/workflows/test.yml`](.github/workflows/test.yml)).
`main` is not tested twice: Release installs and tests before it publishes, so
a push there is already covered.

Layout:

```
.claude-plugin/     plugin + marketplace manifests
.mcp.json           registers the eklavya MCP server
skills/             tutor pedagogy, and the seven /eklavya:* commands
user-skill/         the chat skill, installed to ~/.claude/skills/ rather than shipped in the plugin
agents/             the eklavya-tutor subagent
hooks/              hooks.json + run.mjs, the one cross-platform entry point
cli/, scripts/      the editor-agnostic commit gate, plus the release version bump
mcp/                MCP server: knowledge graph, SM-2, gates, CLI, installer, hook logic
docs/               verified schemas, parallel tutoring, the runtime architecture
prd/                the spec and its per-phase delivery tracker
web/                the landing page and the manual — see web/CLAUDE.md
eval/               the question-quality eval — see eval/README.md
```

Plugin, hook and MCP schemas drift. What this is built against is pinned with a date in [`docs/verified-schemas.md`](docs/verified-schemas.md) — re-verify before changing any manifest:

- https://code.claude.com/docs/en/plugins · [reference](https://code.claude.com/docs/en/plugins-reference) · [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp

## The eval

`mcp/test/` tests the machinery. It does not test the product, which is a
question — so a change that makes every question worse passes all 447 of them.
`eval/` is where that gets measured.

```bash
npm run eval -- run --limit 8 --focus project --difficulty hard
npm run eval -- score eval/results/<run>     # free, no model calls
```

Four stages: `plan` drives the real `get_session_quiz_plan` against a throwaway
home, `generate` gives a model the shipped tutor skill and asks for one
question, `score` runs deterministic checks, `judge` asks a model the three
things counting cannot answer. `score` is free and reproducible; `generate` and
`judge` cost one model call per question, which is why **none of this runs in
CI** and why it is not part of `npm test`.

Read [`eval/README.md`](eval/README.md) before quoting a number from it. It
states the method, what is deterministic versus judged, and what would disprove
the whole thing — including that the generator and judge are currently the same
model family, and that the fixtures are this repo's own code and therefore an
upper bound.

Results go in `eval/results/` as one dated Markdown file per run; the raw JSON
each run writes is gitignored scratch. A result file that does not say what
would make it wrong is not finished.

**A change to the pedagogy in `skills/tutor/` is the change this exists for.**
Run it before and after.

## Releasing

Releases are automatic. Push a [Conventional Commit](https://www.conventionalcommits.org/) to `main` and semantic-release decides the version, writes the changelog, tags, creates the GitHub Release, and publishes to npm with provenance.

| Commit prefix | Effect |
|---|---|
| `fix:` | patch — 0.1.0 → 0.1.1 |
| `feat:` | minor — 0.1.0 → 0.2.0 |
| `feat!:` or a `BREAKING CHANGE:` footer | major |
| `docs:` `test:` `chore:` `build:` `ci:` `refactor:` | no release |

Nothing to run by hand. The workflow installs, runs all tests, and only then releases — and the suite asserts that the two places carrying a version agree: `.claude-plugin/plugin.json` and `mcp/package.json`. `hooks/run.mjs` reads the version out of the plugin manifest at runtime rather than carrying a third copy, which is one fewer thing a release can forget. `scripts/bump-version.sh` keeps the two in step and semantic-release calls it for you.

The Claude Code plugin has no separate publish step: the marketplace serves the plugin straight from this repository, so the same push ships it. The npm package carries the same plugin tree inside it (`mcp/dist/plugin/`, assembled by `mcp/scripts/copy-assets.mjs`), which is what lets `npx eklavya install` set everything up without a git clone — and what keeps the two install routes from drifting apart.

The package is published as **`eklavya`**, and ships one binary of the same name — the MCP server is `eklavya serve` rather than a second `eklavya-mcp` executable.

Up to 1.7.0 the package was called `eklavya-mcp`. That name still exists on npm so that already-installed plugins, which pin it by exact version, keep resolving; it is deprecated rather than removed, and must never be unpublished.

Repository secret required: `NPM_TOKEN` (an npm **Automation** token). `GITHUB_TOKEN` is provided by Actions.
