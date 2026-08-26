# Eklavya

**Learn while your agent works.**

Eklavya turns agent generation time into learning time. While Claude Code implements your task, Eklavya teaches you the concepts behind *that exact work* — adaptive Socratic questions grounded in the diff it just wrote, mastery tracked in a local knowledge graph, and optionally a commit gate until you can show you understood it.

> Named for Ekalavya, who mastered archery practicing before a silent statue of his guru. Here, the statue talks back.

Everything is local. No accounts, no sync, no telemetry.

---

## Why

Coding agents create a comprehension gap. You ship code you didn't write and couldn't debug. The moment that code is being generated is the highest-leverage teaching moment there is: the concepts are concrete, the code is right in front of you, and your hands are free.

So Eklavya asks you about it — once per task, never the same question twice, and harder each time you get it right.

## Install

### Claude Code

```bash
/plugin marketplace add ProjectAJ14/eklavya
/plugin install eklavya@eklavya
/eklavya:setup
```

Or run it straight from a checkout while developing:

```bash
git clone <this repo> eklavya
cd eklavya/mcp && npm install && npm run build
claude --plugin-dir /path/to/eklavya
```

### Prerequisites

| Requirement | Why |
|---|---|
| Node 18+ | the MCP server; `better-sqlite3` builds a native binding |
| `sqlite3` on `PATH` | hook scripts read the knowledge database directly, with no MCP round trip |
| `jq` on `PATH` | hook scripts parse hook input JSON |

`/eklavya:setup` checks all three. Without `jq` or `sqlite3` the hooks quietly do nothing — they never break a session.

### Cursor

The knowledge graph and the commit gate are editor-agnostic by design.

```bash
# 1. Point Cursor at the MCP server (~/.cursor/mcp.json)
{
  "mcpServers": {
    "eklavya": { "command": "npx", "args": ["-y", "eklavya-mcp"] }
  }
}

# 2. Export the same pedagogy as a Cursor rules file
node /path/to/eklavya/mcp/dist/cli.js export-rules --out .cursor/rules/eklavya.md

# 3. Install the commit gate (enforced repos only)
/path/to/eklavya/scripts/install-git-hook.sh
```

The rules file is generated from `skills/tutor/SKILL.md`, so the two editors cannot drift apart. Regenerate it after upgrading.

## How it works

1. **You ask for something.** "Add JWT auth to the Express API."
2. **Claude logs what the work touches** — `jwt-structure`, `httponly-cookies`, `middleware-order-auth` — each with a line pointing at the actual code.
3. **When the task finishes**, a `Stop` hook checks the knowledge graph. Anything you haven't mastered turns into a quiz — at most once per batch of work.
4. **You answer.** Claude grades honestly on SM-2's 0–5 scale and records it. Mastery and the next review date update.
5. **Next session** starts with a one-line profile, so Claude calibrates from your first message. Shaky concepts come back later, at a higher tier.

Tier 1 asks what a thing is. Tier 5 asks what breaks it in production. You climb as you get things right, which is how "never ask the same question twice" survives contact with a finite concept graph.

### Never the same question twice

Three separate things enforce it, because a prompt asking nicely is not enforcement:

- **Mastered concepts are not asked about.** The learner profile hands the tutor the actual list of what you know, and spaced repetition is the only thing that brings one back — harder than last time.
- **Every question you have been asked is on record**, and the quiz plan hands those exact questions back to the tutor with the tier and grade each got. A question already asked is spent: same concept, different angle. `record_attempt` flags it if one slips through.
- **A concept answered in this session is done for the session.** Getting something half-right no longer puts it straight back in the queue five minutes later.

Prerequisites are checked too. A tier-3 "why this rather than the alternative" question about a concept whose foundations you do not have yet is not a hard question, it is an unfair one, so the plan orders foundations first and says which ones are missing.

## Modes

| Mode | For | Behaviour |
|---|---|---|
| `ambient` (default) | anyone learning a new stack | questions offered after tasks, always skippable, no nagging |
| `enforced` | interns, onboarding | the session quiz must pass before `git commit` — inside Claude Code *and* from a bare terminal |
| `off` | — | installed but dormant |

```bash
eklavya config set mode enforced          # globally
eklavya config set mode enforced --repo   # this project only
```

Repo settings beat global ones, which is how a team lead pins enforced mode on one codebase without touching anyone's machine-wide setup.

## Commands

| Command | Does |
|---|---|
| `/eklavya:quiz [topic]` | quiz now — on this session's work, or a named topic |
| `/eklavya:learn <topic>` | a structured lesson, prerequisite-ordered, calibrated to what you know |
| `/eklavya:progress` | the mastery map: domains, what's due, where you're weakest |
| `/eklavya:gate` | commit-gate status |
| `/eklavya:setup` | first run |

## Configuration

`~/.eklavya/config.json`, overridden per project by `.eklavya.json` at a repo root (see `.eklavya.json.example`):

```json
{
  "mode": "ambient",
  "pass_threshold": 0.7,
  "max_questions_per_task": 4,
  "min_minutes_between_quizzes": 20,
  "max_new_concepts_per_session": 8,
  "max_stop_blocks_per_session": 3,
  "domains_enabled": ["*"],
  "quiet": false
}
```

## Your data

`~/.eklavya/knowledge.db` — SQLite, WAL mode, yours. Delete the directory and Eklavya forgets you entirely.

```bash
eklavya doctor                     # is everything wired up?
eklavya db-path
sqlite3 ~/.eklavya/knowledge.db 'select domain, count(*) from concepts group by domain'
```

Set `EKLAVYA_HOME` or `EKLAVYA_DB` to experiment without touching your real history.

## Learning while it builds

The post-task quiz is the reliable version. For tutoring that runs *during* generation — a second session teaching while the first one builds, sharing one database — see [`docs/parallel-tutoring.md`](docs/parallel-tutoring.md).

## Manual test scripts

Automated coverage is `cd mcp && npm test` (215 tests). These are the by-hand checks behind each phase's acceptance demo.

<details>
<summary><b>Phase 0 — scaffold</b></summary>

```bash
cd mcp && npm install && npm run build
node dist/cli.js doctor
sqlite3 ~/.eklavya/knowledge.db '.tables'
```
Expect all seven tables and ~87 concepts across four domains.
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

Layout:

```
.claude-plugin/     plugin + marketplace manifests
.mcp.json           registers the eklavya MCP server
skills/             tutor pedagogy, and the five /eklavya:* commands
agents/             the eklavya-tutor subagent
hooks/              SessionStart, Stop, PreToolUse(Bash)
cli/, scripts/      the editor-agnostic commit gate
mcp/                MCP server: knowledge graph, SM-2, gates, CLI
docs/               verified schemas, parallel tutoring
prd/                the spec and its per-phase delivery tracker
```

Plugin, hook and MCP schemas drift. What this is built against is pinned with a date in [`docs/verified-schemas.md`](docs/verified-schemas.md) — re-verify before changing any manifest:

- https://code.claude.com/docs/en/plugins · [reference](https://code.claude.com/docs/en/plugins-reference) · [marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/mcp

## Releasing

Releases are automatic. Push a [Conventional Commit](https://www.conventionalcommits.org/) to `main` and semantic-release decides the version, writes the changelog, tags, creates the GitHub Release, and publishes to npm with provenance.

| Commit prefix | Effect |
|---|---|
| `fix:` | patch — 0.1.0 → 0.1.1 |
| `feat:` | minor — 0.1.0 → 0.2.0 |
| `feat!:` or a `BREAKING CHANGE:` footer | major |
| `docs:` `test:` `chore:` `build:` `ci:` `refactor:` | no release |

Nothing to run by hand. The workflow installs, runs all tests, and only then releases — and the suite asserts that the three places carrying a version agree: `.claude-plugin/plugin.json`, `mcp/package.json`, and `PINNED_VERSION` in `mcp/bin/eklavya-mcp.sh`, which is what an installed plugin actually downloads. `scripts/bump-version.sh` keeps them in step and semantic-release calls it for you.

The Claude Code plugin has no separate publish step: the marketplace serves the plugin straight from this repository, so the same push ships it.

Repository secret required: `NPM_TOKEN` (an npm **Automation** token). `GITHUB_TOKEN` is provided by Actions.

## License

MIT
