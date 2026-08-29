<div align="center">

<img src="assets/eklavya.png" alt="Eklavya" width="220">

# Eklavya

**Learn while your agent works.**

*Named for Ekalavya, who mastered archery practicing before a silent statue of his guru. Here, the statue talks back.*

</div>

Eklavya turns agent generation time into learning time. While Claude Code implements your task, Eklavya teaches you the concepts behind *that exact work* — adaptive Socratic questions grounded in the diff it just wrote, mastery tracked in a local knowledge graph, and optionally a commit gate until you can show you understood it.

Everything is local. No accounts, no sync, no telemetry.

**[Read the docs](https://eklavya-run.web.app/docs)** — step-by-step install, every command, every
config key, the commit gate, and troubleshooting.

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
3. **While it's still building**, that logging call triggers a checkpoint: *one* multiple-choice question about the concept it just logged, asked there and then, while the code is still on your screen. You answer in a couple of seconds and Claude carries straight on.
4. **When the task finishes**, a `Stop` hook sweeps up whatever the checkpoints didn't get to. Answer your whole budget during the work and the end of the task is silent.
5. **You answer.** Claude grades honestly on SM-2's 0–5 scale and records it. Mastery and the next review date update.
6. **Next session** starts with a one-line profile, so Claude calibrates from your first message. Shaky concepts come back later, at a higher tier.

Tier 1 asks what a thing is. Tier 5 asks what breaks it in production. You climb as you get things right, which is how "never ask the same question twice" survives contact with a finite concept graph.

### Every project starts easy

The first questions on a codebase are the ones you can actually answer while watching an agent work — what a thing is, what the machine does with it. That is not a warm-up: a question you have no way of answering is the fastest route to turning the plugin off, and the first fortnight is where that decision gets made.

So difficulty is also a **band**, held per project and earned:

| Level | Tiers | Asks for |
|---|---|---|
| `easy` (where every project starts) | 1–2 | what a thing is; what the machine does with it |
| `medium` | 2–4 | why this choice here, and what breaks it |
| `hard` | 3–5 | judgement, failure modes, when the architecture is wrong |

A band moves up when you have **100 passing answers** in that project, at **70% accuracy or better**, spread across at least fifteen distinct concepts — endurance alone is not readiness, and one concept re-asked forty ways is not either. Declining a question costs nothing: it counts on neither side of the accuracy. Nothing ever demotes you.

It is per project because "how hard should this be" is a question about a codebase, not about you. The same developer is a different learner on their fourth Node service and their first Rust one — so a new repo starts at `easy` even if three others are on `hard`. `/eklavya:level` shows where you are and how far into the band; `difficulty` pins it if you would rather skip the runway.

### Every question says what asked it

A question arrives with a line under it naming the dials behind it:

```
Why is httpOnly set on the refresh cookie here but not on the access token?

ambient · concept · easy · tier 2 mechanism
```

Mode, focus, level, what the tier is asking for — and `· q 2/3` when more than one question is coming. Enforced mode reads `enforced (gated)`. Without it, a `concept`-focus question reads as vague and an `easy` one reads as shallow — the settings are only doing their job if you can see them working. `quiet` turns it off.

### Questions are multiple choice

You are in the middle of something. A blank prompt asking you to explain a mechanism gets skipped — not because you didn't know, but because typing a paragraph costs more than the question is worth right then, and the skip records as if you had no idea.

So every question comes as four options, through Claude Code's own question UI, under an **Eklavya** header so you can see who is asking: one right, three that a competent person could believe. Picking one is a keystroke. "Other" is always there for *I don't know* — which is a request to be taught, not a skip — or for typing a real answer if you'd rather explain.

Recognition is easier than recall, and the grading knows it: a multiple-choice answer is capped at 4 out of 5, because choosing the right option can't show you could have explained it. Two clean answers still reach mastery; it just isn't claimed on one lucky guess.

### Never the same question twice

Three separate things enforce it, because a prompt asking nicely is not enforcement:

- **Mastered concepts are not asked about.** The learner profile hands the tutor the actual list of what you know, and spaced repetition is the only thing that brings one back — harder than last time.
- **Every question you have been asked is on record**, and the quiz plan hands those exact questions back to the tutor with the tier and grade each got. A question already asked is spent: same concept, different angle. `record_attempt` flags it if one slips through.
- **A concept answered in this session is done for the session.** Getting something half-right no longer puts it straight back in the queue five minutes later.

Prerequisites are checked too. A tier-3 "why this rather than the alternative" question about a concept whose foundations you do not have yet is not a hard question, it is an unfair one, so the plan orders foundations first and says which ones are missing.

### "I don't know" is a request, not a skip

The two look identical to a grade — both are 0 on SM-2's scale, because neither is a recall success. They are opposite requests. *Skip* means leave me alone. *I don't know* means teach me, and it is the clearest such request you will ever get.

So a blank is the one answer that gets the **most** teaching, not the least: the mechanism, the real lines from the diff, what it generalises to, one takeaway. Then it is recorded and the quiz moves on — no re-asking in the same breath, because grade 0 pins the concept at the floor and it comes back tomorrow anyway, as a different question about something you have now been taught.

Eklavya records which of the two it was (`outcome: dont_know` or `declined`), so the next session can open as a follow-up to the explanation instead of asking cold. Consecutive blanks drop the tier rather than ending the quiz — blanking means the pitch was too high, not that you wanted out.

In enforced mode this distinction also decides whether the gate can be passed at all. A blank grades 0, and 0 never passes — so a session answered entirely with "I don't know" would leave the gate permanently unmet. Once every other concept is exhausted, Eklavya re-offers the ones it taught you, one tier lower and with a different question, until you can show the lesson landed. Concepts you *declined* are not re-offered: the gate holding against a decline is the gate working.

### Questions arrive during the work, not after it

The point was always to learn *while* your coding agent works. A quiz that only fires when the task is done is a tax on shipping: four questions at the exact moment you wanted to be finished, about code you stopped thinking about ten minutes ago.

So the default cadence is **interleaved**. The moment Claude logs a concept, Eklavya may come back with one question about it — one, not four — and Claude answers it with you and returns to the task in the same breath. `max_questions_per_task` becomes a budget for the whole session rather than a batch at the end, and the end-of-task quiz only asks for what's left of it.

A one-minute task gets one question, or none. A long session spreads its four across the work, each one landing next to the code that taught it.

```bash
eklavya config set cadence end   # the old behaviour: nothing until the task finishes
eklavya config set min_minutes_between_checkpoints 10   # or just space them out
```

## Modes, focus, cadence and difficulty

Eklavya has **four independent dials**. `mode` is how hard it pushes; `focus` is what it teaches; `cadence` is when it asks; `difficulty` is how hard the questions may get. They combine freely — `enforced` + `learn` is an intern who must pass a gate on a topic they chose.

| `mode` | For | Behaviour |
|---|---|---|
| `ambient` (default) | anyone learning a new stack | questions offered after tasks, always skippable, no nagging |
| `enforced` | interns, onboarding | the session quiz must pass before `git commit` — inside Claude Code *and* from a bare terminal |
| `off` | — | installed but dormant; `focus` is not read |

| `focus` | Asks about | Good for |
|---|---|---|
| `concept` (default) | the ideas behind the code, asked so the answer transfers to any codebase | learning a stack |
| `project` | the code just written — the file, the line, the decision | learning a codebase |
| `learn` | a topic you name, in prerequisite order, using your real code as the example wherever the work touches it | learning something on purpose |

| `cadence` | Asks | Good for |
|---|---|---|
| `interleaved` (default) | one question mid-task, as each concept is logged; the end-of-task quiz sweeps up the remainder | learning while the agent works |
| `end` | nothing until the task is finished | deep focus, pairing, demos |

| `difficulty` | Band | Good for |
|---|---|---|
| `auto` (default) | earned per project: `easy`, then `medium`, then `hard` | everyone |
| `easy` \| `medium` \| `hard` | pinned there; nothing promotes | an onboarding repo held gentle, or a senior skipping the runway |

```bash
eklavya config set mode enforced          # globally
eklavya config set mode enforced --repo   # this project only
eklavya config set focus project     # ask about this codebase instead
eklavya config set focus learn --topic caching
eklavya config set cadence end            # stop interrupting mid-task
eklavya config set difficulty hard        # skip the runway
eklavya config set difficulty easy --repo # keep an onboarding repo gentle for everyone
```

Or `/eklavya:mode` to see all four and change any of them, and `/eklavya:level` for the difficulty band on its own.

Repo settings beat global ones, which is how a team lead pins enforced mode on one codebase without touching anyone's machine-wide setup. That also means a repo setting `focus` overrides each contributor's personal choice there, including a `learn` topic they set for themselves — so the session banner names any setting the repo is overriding rather than letting it change silently.

`learn` focus never changes *when* Eklavya interrupts: the end-of-task quiz still fires on real work, so a declared topic can't start interrupting you about something unrelated to what you're doing. Topic study on demand is `/eklavya:learn`.

## Commands

| Command | Does |
|---|---|
| `/eklavya:quiz [topic]` | quiz now — on this session's work, or a named topic |
| `/eklavya:mode [value]` | show or change the mode, focus, cadence and difficulty dials |
| `/eklavya:learn <topic>` | a structured lesson, prerequisite-ordered, calibrated to what you know |
| `/eklavya:level [value]` | this project's difficulty band, the runway into it, or pin one |
| `/eklavya:progress` | the mastery map: domains, what's due, where you're weakest |
| `/eklavya:gate` | commit-gate status |
| `/eklavya:setup` | first run |

## Configuration

`~/.eklavya/config.json`, overridden per project by `.eklavya.json` at a repo root (see `.eklavya.json.example`):

```json
{
  "mode": "ambient",
  "focus": "concept",
  "cadence": "interleaved",
  "difficulty": "auto",
  "level_up_after": 100,
  "level_up_accuracy": 0.7,
  "pass_threshold": 0.7,
  "max_questions_per_task": 4,
  "min_minutes_between_quizzes": 20,
  "min_minutes_between_checkpoints": 4,
  "max_new_concepts_per_session": 8,
  "max_stop_blocks_per_session": 3,
  "domains_enabled": ["*"],
  "quiet": false
}
```

`difficulty` is `auto` unless you pin it; `level_up_after` and `level_up_accuracy` are what a band costs. Shorten the runway if 100 answers is too long a first act — the distinct-concept floor scales with it, so a short runway stays reachable.

`max_questions_per_task` is a **session budget**, not a batch size: mid-task checkpoints and the end-of-task sweep draw from the same allowance, so turning on `interleaved` moves questions earlier without adding any. `min_minutes_between_checkpoints` is the floor between mid-task questions — it exists so that logging eight concepts in one call cannot become eight questions in a row.

## Your data

`~/.eklavya/knowledge.db` — SQLite, WAL mode, yours. Delete the directory and Eklavya forgets you entirely.

```bash
eklavya dashboard                  # the same data as a local web page
eklavya doctor                     # is everything wired up?
eklavya db-path
sqlite3 ~/.eklavya/knowledge.db 'select domain, count(*) from concepts group by domain'
```

`eklavya dashboard` serves your progress on `127.0.0.1:41729` (`--port` to change
it): accuracy over time, per-project comparison, the concepts each session
taught with the code they came from, and the ones you skipped. Loopback only —
it reads the same local database and sends nothing anywhere.

Set `EKLAVYA_HOME` or `EKLAVYA_DB` to experiment without touching your real history.

## Learning while it builds

Interleaved cadence (above) is the built-in version: questions land mid-task, in the same session, at the seam where each concept was logged. For tutoring that runs *during* generation in a separate pane — a second session teaching while the first one builds, sharing one database — see [`docs/parallel-tutoring.md`](docs/parallel-tutoring.md).

## Manual test scripts

Automated coverage is `cd mcp && npm test` (344 tests). These are the by-hand checks behind each phase's acceptance demo.

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
