# Eklavya — Product Requirements Document (Master)

**Learn while your agent works.**

Eklavya is a Claude Code plugin that turns agent generation time into learning time. While a coding agent implements a task, Eklavya teaches the developer the concepts behind that exact work — asking adaptive, Socratic questions grounded in the code being generated, tracking mastery in a local knowledge graph, and (optionally) gating commits until the developer demonstrates understanding.

> Named for Ekalavya, who mastered archery practicing before a silent statue of his guru. Here, the statue talks back.

> **This is the frozen master spec.** Per-phase execution docs live alongside it in `prd/phase-*.md`; status tracking lives in `prd/README.md`. If the spec changes, change it here first, then reflect it in the affected phase doc.

---

## 1. Problem statement

Coding agents create a comprehension gap:

- **Interns/juniors** ship agent-generated code they don't understand. They "complete" tasks without building the mental models that make them useful reviewers, debuggers, or future architects.
- **Experienced devs learning a new stack** (e.g., a Flutter dev moving to Java/React/backend) read the generated code fluently but skip the *concepts* underneath — they never form the understanding they'd have gained writing it by hand.
- **Generation time is dead time.** While the agent works, developers context-switch to distractions instead of learning about the very thing being built.

Eklavya's bet: the moment code is being generated for you is the *highest-leverage teaching moment* — the concepts are concrete, the code is right there, and the developer's time is free.

## 2. Goals

1. Teach concepts tied to the developer's **actual current task**, not generic tutorials.
2. **Never ask the same question twice** — persist what the developer knows in a local knowledge graph and adapt difficulty accordingly.
3. Use **spaced repetition** so concepts resurface at increasing difficulty until truly mastered.
4. Support an **enforced mode** for interns: the agent will not commit until the session's quiz gate is passed.
5. Be **plug-and-play**: one plugin install command, zero manual config for the default experience.
6. Keep the core (knowledge graph + question engine) **editor-agnostic** so a Cursor integration is config-only later.

## 3. Non-goals (v1)

- No cloud sync, accounts, or telemetry. Everything is local (SQLite in `~/.eklavya/`).
- No team dashboards or manager reporting (future phase).
- No Cursor/Windsurf support in v1 (but architecture must not preclude it — see §12).
- No custom UI. Everything happens in the Claude Code chat/terminal via skills, commands, and hooks.
- Not a course platform. No curriculum authoring UI; concept graphs are seeded JSON + dynamically grown by the LLM.

## 4. Users and modes

| Persona | Mode | Behavior |
|---|---|---|
| Intern / junior | **enforced** | Post-task quiz is mandatory; `git commit` is blocked (both inside Claude Code and via plain git hook) until the session gate passes. |
| Mid-level / senior learning a new stack | **ambient** (default) | Questions offered after tasks and during long generations; answering is optional; mastery decays if ignored; `/progress` shows the map. |
| Anyone | **off** | Plugin installed but dormant (`eklavya config set mode off`). |

Mode lives in `~/.eklavya/config.json` and can be overridden per-project in `.eklavya.json` at repo root (repo config wins — this is how a team lead enforces mode for an intern's machine on a specific repo).

## 5. Product experience

### 5.1 Core loop (ambient mode)

1. Developer asks Claude Code to implement something ("add JWT auth to the Express API").
2. As Claude works, it logs the concepts the task touches (JWT structure, httpOnly cookies, session vs token auth, middleware order) via the MCP server.
3. When the task completes, a **Stop hook** checks the knowledge graph: which touched concepts does this developer *not* yet have mastered?
4. If any exist, the hook blocks the stop with a reason, causing Claude to continue the turn as a tutor: 2–4 Socratic questions, grounded in the diff it just wrote ("I set `httpOnly: true` on the refresh-token cookie — what attack does that mitigate, and why doesn't it fully solve it?").
5. Answers are graded by the LLM and recorded via `record_attempt`. Mastery scores and next-review dates update (SM-2).
6. Next session, `SessionStart` injects a one-line learner profile so Claude calibrates from message one, and previously-shaky concepts resurface at higher difficulty when their review date arrives.

### 5.2 Core loop (enforced mode)

Same as above, plus:

- The Stop-hook quiz is mandatory and has a pass threshold (default: 70% of session concepts answered at their current difficulty tier).
- A **PreToolUse hook on Bash** intercepts `git commit` and denies it while the session gate is unpassed, with a reason instructing Claude to run the quiz first.
- A **plain git `pre-commit` hook** (installed by `/eklavya:setup`) performs the same DB check, so commits from a terminal, VS Code, or Cursor are equally gated. This makes enforcement editor-agnostic on day one.
- The gate must always have a route through it. A blank grades 0 and 0 never passes, while a concept with any attempt is dropped from the session plan — so a session answered entirely with "I don't know" would leave `required` unmeetable, the planner empty, and the commit hook denying while telling the developer to run a quiz that refuses. Once ordinary candidates are exhausted and the gate is still unpassed, `get_session_quiz_plan` re-offers the concepts it taught (`reason: "gate_retry"`), one tier lower, with `asked_before` forcing a different question. Concepts whose latest attempt was `declined` are excluded: the gate holding against a decline is enforcement, not a deadlock. Ambient mode is exempt — it has no gate, and re-offering there is the nagging the cooldown prevents.

### 5.3 Slash commands

| Command | Purpose |
|---|---|
| `/eklavya:quiz [topic]` | Start a quiz now — on the current session's concepts, or a named topic/domain. |
| `/eklavya:learn <topic>` | Structured teaching session on a topic, calibrated to the learner profile (prerequisite-ordered). |
| `/eklavya:progress` | Render the mastery map: domains, concept counts by tier, streaks, concepts due for review, weakest areas. |
| `/eklavya:setup` | First-run: create DB, seed concept graphs, install the git pre-commit hook, choose mode. |
| `/eklavya:gate` | Show current session gate status (enforced mode). |

### 5.4 Parallel-tutoring UX (stretch goal, Phase 4)

The dream UX: implementation delegated to a subagent while the main conversation tutors during generation. V1 approximates this with the post-task Stop-hook quiz (simpler, reliable). Phase 4 explores: (a) a `tutor` subagent invoked alongside work, and (b) a documented two-pane workflow (e.g., tmux/Herdr): worker session in one pane, `/eklavya:learn` session in another, both sharing the same SQLite DB through the same MCP server. No code changes are needed for (b) beyond docs — that's a design constraint on the MCP server: **safe concurrent access from multiple sessions** (WAL mode).

## 6. Architecture overview

A single **Claude Code plugin** packaging four component types. The stateful, portable core is the MCP server; everything else is thin.

```
┌─────────────────────────── eklavya plugin ───────────────────────────┐
│                                                                      │
│  skills/tutor/SKILL.md      ← pedagogy: how to teach, quiz, grade    │
│  commands/*.md              ← /eklavya:quiz, :learn, :progress, ...  │
│  hooks/hooks.json           ← SessionStart, Stop, PreToolUse(Bash)   │
│  hooks/*.sh                 ← gate check, quiz trigger, profile inject│
│  mcp/                       ← eklavya-mcp server (Node + TypeScript) │
│      └── SQLite @ ~/.eklavya/knowledge.db  (WAL mode)                │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
         ▲                                        ▲
         │ MCP (stdio)                            │ direct sqlite read
   Claude Code sessions                    git pre-commit hook,
   (and later: Cursor)                     eklavya CLI
```

**Repo layout:**

```
eklavya/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   ├── quiz.md
│   ├── learn.md
│   ├── progress.md
│   ├── setup.md
│   └── gate.md
├── skills/
│   └── tutor/
│       └── SKILL.md
├── hooks/
│   ├── hooks.json
│   ├── session-start.sh
│   ├── stop-quiz-check.sh
│   └── pre-tool-gate.sh
├── mcp/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts          # MCP entry (stdio)
│       ├── db.ts              # SQLite init, migrations, WAL
│       ├── tools/             # one file per MCP tool
│       ├── srs.ts             # SM-2 spaced repetition
│       └── seed/              # starter concept graphs (JSON)
│           ├── web-auth.json
│           ├── react.json
│           ├── node-backend.json
│           └── git.json
├── cli/
│   └── eklavya-gate           # tiny script: exit 0/1 from gate status (used by git hook)
├── scripts/
│   └── install-git-hook.sh
├── README.md
└── LICENSE (MIT)
```

**Implementation note for the coding agent:** Before writing `plugin.json`, `hooks.json`, or MCP registration config, fetch and follow the *current* official docs — plugin schema and hook JSON fields have evolved:
- Plugins: https://code.claude.com/docs/en/plugins
- Hooks reference: https://code.claude.com/docs/en/hooks
- MCP in Claude Code: https://code.claude.com/docs/en/mcp

Use `${CLAUDE_PLUGIN_ROOT}` for all script and server paths inside plugin config so the plugin is location-independent.

## 7. Data model (SQLite)

Database: `~/.eklavya/knowledge.db`. Enable `PRAGMA journal_mode=WAL;` and `PRAGMA foreign_keys=ON;`. Ship migrations (numbered SQL files applied at server start; store schema version in `meta`).

```sql
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE concepts (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,       -- 'jwt-structure', 'httponly-cookies'
  name        TEXT NOT NULL,
  domain      TEXT NOT NULL,              -- 'web-auth', 'react', 'node-backend', ...
  description TEXT,
  tier        INTEGER NOT NULL DEFAULT 1, -- 1 fundamentals … 5 expert
  source      TEXT NOT NULL DEFAULT 'seed' -- 'seed' | 'llm' (dynamically created)
);

CREATE TABLE edges (
  from_concept INTEGER NOT NULL REFERENCES concepts(id),
  to_concept   INTEGER NOT NULL REFERENCES concepts(id),
  relation     TEXT NOT NULL CHECK (relation IN ('prerequisite_of','related_to','part_of')),
  PRIMARY KEY (from_concept, to_concept, relation)
);

CREATE TABLE mastery (
  concept_id   INTEGER PRIMARY KEY REFERENCES concepts(id),
  score        REAL NOT NULL DEFAULT 0,   -- 0..1
  ease         REAL NOT NULL DEFAULT 2.5, -- SM-2 ease factor
  interval_d   REAL NOT NULL DEFAULT 0,   -- current review interval, days
  reps         INTEGER NOT NULL DEFAULT 0,
  last_seen    TEXT,                      -- ISO timestamp
  next_review  TEXT                       -- ISO timestamp
);

CREATE TABLE attempts (
  id          INTEGER PRIMARY KEY,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id),
  session_id  TEXT,
  question    TEXT NOT NULL,
  answer      TEXT,
  grade       INTEGER NOT NULL,           -- 0..5 (SM-2 quality)
  difficulty  INTEGER NOT NULL,           -- tier the question was asked at
  feedback    TEXT,                       -- tutor's explanation
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE session_concepts (            -- concepts touched by a working session
  session_id  TEXT NOT NULL,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id),
  context     TEXT,                       -- e.g. 'set httpOnly on refresh cookie in auth.ts'
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, concept_id)
);

CREATE TABLE gates (
  session_id   TEXT PRIMARY KEY,
  mode         TEXT NOT NULL,             -- 'ambient' | 'enforced'
  required     INTEGER NOT NULL DEFAULT 0,-- concepts required this session
  answered     INTEGER NOT NULL DEFAULT 0,
  passed       INTEGER NOT NULL DEFAULT 0,-- boolean
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Spaced repetition (srs.ts)

Implement SM-2:
- Grade `q` ∈ 0..5 comes from the LLM tutor's assessment of the answer.
- `q >= 3`: interval 0→1d→6d→`interval × ease`; ease adjusts by the standard SM-2 formula (floor 1.3).
- `q < 3`: reps reset, interval back to 1d.
- `mastery.score` = smoothed function of recent grades (e.g., EMA over last 5 attempts, normalized to 0..1). A concept counts as **known** when `score ≥ 0.7` and `reps ≥ 2`.
- **Decay:** when computing profiles, apply a soft decay to `score` for concepts whose `next_review` is long past (e.g., −0.05 per overdue week, floor 0.3). Don't write decay back; compute at read time.

## 8. MCP server (`eklavya-mcp`)

Node 18+, TypeScript, `@modelcontextprotocol/sdk`, `better-sqlite3`, stdio transport. Registered by the plugin so it's available in every session. All tools return compact JSON; keep responses small (they land in the model's context).

### Tools

1. **`get_learner_profile`** `{ domain?: string }` →
   `{ mode, domains: [{domain, known: n, learning: n, unseen: n}], weak: [slug...], due_for_review: [{slug, tier}...], suggested_tier }`
   Called at session start and before any quiz/teaching.

2. **`log_session_concepts`** `{ session_id, concepts: [{slug, name?, domain?, tier?, context}] }` →
   Upserts unknown slugs as `source='llm'` concepts, inserts into `session_concepts`. The tutor skill instructs Claude to call this as it works (cheap, batched). Slugs it had to mint come back in `created`, and — because a bare concept has no edges and so silently defeats the `prereqs_unmet` fairness check — the response also carries `next_action` naming the `upsert_concepts` call they owe. Stated in the payload rather than only in the skill, which is model-invoked and may never load.

3. **`get_session_quiz_plan`** `{ session_id, max?: number }` →
   `{ questions_needed, concepts: [{slug, name, tier_to_ask, context, last_grade?}] }`
   Selection order: (a) session concepts not yet known, (b) session concepts due for review, (c) global due-for-review in same domain, and — enforced mode only, once (a)–(c) are empty and the gate is still unpassed — (d) concepts already taught this session, re-offered a tier lower as `reason: "gate_retry"` so the gate always has a route through it (§5.2). Caps at `max` (default 4).

4. **`record_attempt`** `{ session_id, slug, question, answer, grade, difficulty, feedback }` →
   Writes attempt, updates SM-2 state, updates gate counters. Returns `{ new_score, next_review, gate: {required, answered, passed} }`.

5. **`get_gate_status`** `{ session_id }` → `{ mode, required, answered, passed, pass_threshold }`.

6. **`upsert_concepts`** `{ concepts: [...], edges?: [...] }` — lets the tutor grow the graph (new stack, new library). Validate slugs; never duplicate.

7. **`get_concept_graph`** `{ domain, include_mastery?: bool }` — for `/eklavya:progress` and `/eklavya:learn` prerequisite ordering.

8. **`set_config`** / **`get_config`** — mode, pass threshold, max questions per session, quiet hours.

### Concurrency

Multiple Claude Code sessions (and the git hook) may hit the DB simultaneously. WAL mode + short transactions in `better-sqlite3` is sufficient. No server-side session state — everything keyed by `session_id` in the DB.

## 9. Hooks

Defined in `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` paths. Scripts are POSIX shell + `jq` + `sqlite3` (document these as prerequisites; check in `/eklavya:setup`). Verify exact JSON I/O fields against the current hooks reference before implementation.

### 9.1 `SessionStart` → `session-start.sh`

Reads learner profile summary from SQLite directly (fast; no MCP round trip) and prints 2–3 lines to stdout, which Claude Code injects as context:

```
[Eklavya] Learner profile: web-auth 12/20 known, react 4/31 known. Weak: jwt-refresh-rotation, useEffect-cleanup. Mode: ambient. Log task concepts via eklavya log_session_concepts.
```

Must complete in <200ms; on any error, print nothing and exit 0 (never break a session).

### 9.2 `Stop` → `stop-quiz-check.sh`

- Reads `session_id` from hook input JSON.
- Queries: does this session have unmastered/due concepts in `session_concepts`, and has a quiz not yet run this stop-cycle?
- If yes → output `{"decision": "block", "reason": "Eklavya: before finishing, quiz the developer on: <slugs+contexts>. Call get_session_quiz_plan, ask one question at a time, grade with record_attempt."}` — this makes Claude continue the turn as tutor.
- **Loop guard (critical):** write a marker (e.g., row in `gates` or a tmp file keyed by session + stop-count) so the hook blocks at most once per task completion; after the quiz runs (attempts recorded), subsequent Stops pass. Ambient mode: also pass if the developer declines ("skip") — the skill records a skip and the hook must not re-block.

### 9.3 `PreToolUse` (matcher: `Bash`) → `pre-tool-gate.sh`

- Parse `tool_input.command`; if it doesn't contain `git commit`, exit 0 immediately.
- If mode ≠ `enforced`, exit 0.
- Query `gates` for the session; if `passed = 1`, exit 0.
- Else deny with the current documented mechanism (JSON `permissionDecision: "deny"` with a reason, or exit 2 + stderr), message: *"Eklavya gate: complete the session quiz before committing. Run the quiz now (get_session_quiz_plan → ask → record_attempt), then retry the commit."*
- Keep it fast (<100ms typical) — it runs on every Bash call.

### 9.4 Plain git `pre-commit` hook (outside Claude Code)

`scripts/install-git-hook.sh` installs a hook that calls `cli/eklavya-gate`, which checks the most recent gate row for the repo (store repo path in `gates` — add a `repo` column) and exits non-zero with a friendly message if enforced + unpassed. This covers commits from any editor or terminal. Must not fire on repos without an `.eklavya.json` enforced config.

## 10. The tutor skill (`skills/tutor/SKILL.md`)

The pedagogy lives here as instructions to Claude. Required behaviors:

1. **Always profile first.** Call `get_learner_profile` before teaching or quizzing. Never ask about a concept marked known unless it's due for review.
2. **Log as you go.** While implementing a task, batch-call `log_session_concepts` with the concepts the work genuinely exercises (3–8 per task, with a one-line `context` pointing at the actual code).
3. **Ground every question in the diff.** Prefer "in the code I just wrote…" questions over textbook questions. Reference file/line/decision.
4. **Socratic, one at a time.** Ask one question, wait, grade, give a tight explanation (≤4 sentences for grade ≥2), then next. Never dump a 10-question wall, and never dump the remaining answers when a quiz ends early.
5. **Grade honestly on the 0–5 SM-2 scale** and call `record_attempt` for every answer, passing `outcome` (`answered` / `dont_know` / `declined`) so the two kinds of 0 stay distinguishable.
6. **Calibrate difficulty** to `tier_to_ask` from the quiz plan. If the learner nails tier-2, next occurrence asks tier-3 ("why/tradeoff/failure-mode" questions, not definitions).
7. **Teach the blanks.** "I don't know" is a request for teaching, not a decline. It earns the *longest* explanation in the quiz — mechanism, the real lines, the general rule, one takeaway — then grade 0 with `outcome: "dont_know"` and move on. Consecutive blanks drop a tier; they never end the quiz.
8. **Respect mode.** Ambient: offer, accept a decline gracefully, never nag twice. Enforced: state plainly that the commit gate requires the quiz, keep tone supportive not punitive.
9. **Grow the graph.** `log_session_concepts` creates unknown slugs bare (tier 2, domain `general`, no edges). When the response reports `created`, follow with `upsert_concepts` giving a real domain, tier and at least one prerequisite edge — `prereqs_unmet` is computed from those edges, so a bare node makes the fairness check a no-op.
10. **Never block the actual work.** Teaching happens after task completion or when explicitly invoked — not interleaved mid-implementation in v1.

Question-quality bar (include as examples in the skill): definitions are tier-1 only; tiers 2–3 ask *why this choice here*; tiers 4–5 ask *what breaks, when, and what's the alternative* ("we store the refresh token in an httpOnly cookie and the access token in memory — what specific attack combination is this defending against, and what UX cost does it create?").

## 11. Configuration

`~/.eklavya/config.json` (global) merged with `.eklavya.json` (repo root; repo wins):

```json
{
  "mode": "ambient",              // "ambient" | "enforced" | "off"
  "pass_threshold": 0.7,           // enforced mode
  "max_questions_per_task": 4,
  "min_minutes_between_quizzes": 20,
  "domains_enabled": ["*"],
  "quiet": false                   // suppress SessionStart banner
}
```

## 12. Portability (design constraints for future Cursor support)

- **All state and logic in the MCP server + SQLite.** Skills/hooks/commands must contain zero business logic beyond orchestration.
- The MCP server must run standalone via `npx eklavya-mcp` (publish scoped package, e.g. `@<org>/eklavya-mcp`), so Cursor users add one `mcpServers` entry.
- Enforcement on Cursor = the same git pre-commit hook (already editor-agnostic).
- Pedagogy on Cursor = a generated rules file (`eklavya export-rules > .cursor/rules/eklavya.md`) derived from the same SKILL.md content. Add this export as a CLI subcommand in Phase 5.

## 13. Milestones and acceptance criteria

### Phase 0 — Scaffold (repo hygiene)
- Repo structure above; TypeScript builds; migrations run; seed graphs load (`web-auth` ≥ 20 concepts with prerequisite edges, `git` ≥ 10).
- ✅ `sqlite3 ~/.eklavya/knowledge.db '.tables'` shows all tables; server responds to `tools/list` over stdio.

### Phase 1 — Manual tutor (prove the loop feels good)
- MCP tools 1–8 implemented with unit tests (vitest) on SRS math and quiz-plan selection.
- Plugin installs; `/eklavya:setup`, `/eklavya:quiz`, `/eklavya:learn`, `/eklavya:progress` work; tutor skill live.
- ✅ Demo: ask Claude Code to build a small Express auth endpoint, run `/eklavya:quiz`, get diff-grounded questions, answer, see `next_review` dates change; re-run `/eklavya:quiz` → no repeated known questions.

### Phase 2 — Automatic ambient loop
- `SessionStart` profile injection; `Stop` hook with loop guard; `log_session_concepts` called organically during work (skill-driven).
- ✅ Demo: complete a task with no manual commands → quiz offered exactly once → skip works → no re-prompt. Kill/restart session → profile line appears.

### Phase 3 — Enforced mode + gates
- `PreToolUse` Bash gate; `gates` lifecycle; git pre-commit hook + `eklavya-gate` CLI; repo-level `.eklavya.json` override.
- ✅ Demo: enforced repo — `git commit` (inside Claude Code *and* from a bare terminal) blocked with instructive message; pass quiz; both commit paths succeed. Ambient repo: no gating anywhere.

### Phase 4 — Parallel tutoring (stretch)
- `tutor` subagent definition; documented two-pane (tmux/Herdr) shared-DB workflow; concurrency test: two sessions writing attempts simultaneously without corruption.

### Phase 5 — Distribution & Cursor
- Publish MCP server to npm (scoped); plugin marketplace listing; `export-rules` CLI; README quickstarts for Claude Code and Cursor.

## 14. Testing requirements

- Unit: SM-2 transitions (all grade paths), decay math, quiz-plan selection priorities, gate pass/fail arithmetic.
- Integration: spawn MCP server, run tool sequences against a temp DB.
- Hook scripts: bats or plain-sh tests with fixture JSON on stdin; assert exit codes and JSON output; assert SessionStart never exits non-zero on a corrupt DB.
- Manual test script in `README` for each phase demo above.

## 15. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Quiz feels naggy → users disable it | Ambient default, one offer per task, `min_minutes_between_quizzes`, single-question cadence, "skip" always honored. |
| Stop-hook infinite loop | Explicit once-per-completion marker + tests (highest-severity bug class; treat as P0). |
| Hook latency on every Bash call | Early-exit on non-commit commands; direct SQLite reads; no network. |
| LLM grades too generously (gate becomes theater) | Skill demands justification-based grading rubric per tier; log feedback; threshold tunable; future: second-pass grader. |
| Concept slug sprawl from LLM upserts | Normalize slugs (kebab-case, domain-prefixed), fuzzy-match before insert, cap per-session new concepts. |
| Docs drift (plugin/hook schemas change) | Implementation must fetch current official docs (§6) before writing config; pin doc URLs in README. |

## 16. Success metrics (local, privacy-preserving)

Computed from the DB by `/eklavya:progress`:
- Concepts moved unseen → known per week; review adherence (% of due reviews attempted).
- Average grade trend per domain (learning is working if tier climbs while grades hold).
- Enforced mode: median time from gate-block → pass (should be < 5 min; if higher, quizzes are too hard or too long).

---

*Handoff note for Claude Code: implement phase by phase, in order, with the acceptance demo at the end of each phase before proceeding. Start by fetching the three doc URLs in §6 and confirming the plugin manifest, hooks JSON schema, and MCP registration format against current docs.*
