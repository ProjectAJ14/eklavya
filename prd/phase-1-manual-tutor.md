# Phase 1 — Manual tutor

**Status:** ✅ Done — live-verified 2026-08-26
**Depends on:** Phase 0
**Spec:** [PRD §8](PRD.md#8-mcp-server-eklavya-mcp), [§10](PRD.md#10-the-tutor-skill-skillstutorskillmd), [§5.3](PRD.md#53-slash-commands)
**Plan reviewed:** 2026-08-26 — see [Design decisions settled in review](#design-decisions-settled-in-review)

## Objective

Make the teaching loop real and manually invokable. All MCP tools implemented, SM-2 working, the tutor skill written, and the slash commands driving it. Prove the loop *feels good* before automating it.

## Scope

In: the nine MCP tools, `srs.ts`, config layer, tutor skill, five user-invoked skills.
Out: hooks (Phase 2), gate *enforcement* (Phase 3) — though gate rows are written from Phase 1 so Phase 3 has history to enforce against.

---

## Design decisions settled in review

The original plan named the tools but left the rules inside them to be invented at implementation time. Each rule below is used by two or more tools, so inventing it twice means two subtly different answers. Settled here, once.

### G1 — Session identity (was blocking) ⚠️
**Problem.** Every tool is keyed by `session_id`, and Phase 2's hooks receive Claude Code's real `session_id` on stdin. But *the model has no way to know its own session id*, so it cannot pass a value the hooks will later agree with. Left unsolved, Phase 1 writes rows under invented ids and every Phase 2 hook query silently returns nothing.

**Decision.** `session_id` becomes **optional** on every tool, resolved server-side in this order:
1. explicit argument
2. `EKLAVYA_SESSION_ID` env var (set on the MCP subprocess if the host provides one)
3. `meta.current_session` — stamped by the Phase 2 `SessionStart` hook
4. `'default'` — a single fallback session, so Phase 1 is usable before hooks exist

Phase 2 additionally echoes the session id in the injected profile line, so the model can pass it explicitly when it matters. This is the seam between phases 1 and 2; get it wrong and Phase 2 looks broken for reasons that live here.

### G2 — What `mastery.score` actually computes
PRD §7 says "EMA over last 5 attempts, normalized to 0..1" without fixing the parameters. **Decision:** `α = 0.6` over the last 5 grades, oldest→newest, seeded with the oldest grade (so a single attempt yields `grade/5` exactly). Recency-weighted, deterministic, testable.

> Alpha started at 0.5 and a test caught it: at exactly 0.5 the weighting is symmetric, so `[0,0,5]` and `[5,5,0]` both score 0.50 — a learner who just turned the corner would look identical to one who just fell apart. 0.6 makes the most recent answer genuinely dominant.

### G3 — `tier_to_ask` (per concept, per quiz)
PRD §10.6 wants difficulty to climb as the learner succeeds, but never defines the step. **Decision:**
- never attempted → the concept's own `tier`
- last grade ≥ 4 **and** score ≥ 0.7 → previous tier + 1
- last grade ≤ 2 → previous tier − 1
- otherwise → hold at the previous tier

Clamped to 1..5. Tier is a property of the *question*, not of the concept — a tier-2 concept can be asked at tier 4 of someone who keeps nailing it.

### G4 — `suggested_tier` (per profile)
Undefined in the PRD. **Decision:** the median tier of the learner's known concepts in scope, clamped 1..5, defaulting to 1 when nothing is known yet. Used to calibrate `/eklavya:learn`, not to override G3.

### G5 — Where the quiz cooldown lives
`min_minutes_between_quizzes` (PRD §11) is enforcement logic, so it belongs in the server, not in a hook (PRD §12: hooks carry no business logic). **Decision:** `get_session_quiz_plan` returns `questions_needed: 0` with `reason: "cooldown"`. **In ambient mode only** — a cooldown must never make an enforced gate unpassable.

### G6 — Fuzzy dedupe for `upsert_concepts`
PRD §15 asks for fuzzy-matching before insert without naming a rule. **Decision:** normalize the slug, strip meaningless qualifier tokens (`basics`, `intro`, `overview`, `guide`, …), then exact-match; failing that, token-set Jaccard ≥ 0.8 over the stripped slugs, which in practice only catches a pure reordering. A match returns the existing concept so the caller learns the canonical slug. New concepts per session are capped by config (default 8).

> This started as plain Jaccard ≥ 0.8, which could not fold the case it existed for (`jwt-structure-basics` → `jwt-structure` is 0.67). Lowering the threshold to 0.65 fixed that and immediately merged **`refresh-token` with `refresh-token-rotation`**, and **`auth-middleware` with `middleware-order-auth`** — different concepts with exactly the same 2-of-3-tokens shape. A similarity score cannot tell a qualifier from a meaningful token, so the qualifier list does that job explicitly and the threshold stays strict. A test asserts that no two shipped seed concepts match each other, so a future loosening gets caught.

### G7 — Response size budgets
"Keep responses small" (PRD §8) needs numbers, since these land in the model's context. **Decision:** profile lists cap at 8 weak + 8 due; `get_concept_graph` caps at 200 nodes; every capped response carries a `truncated` flag. Target ≤ 2 KB per response.

### G8 — Gate rows start in Phase 1
`record_attempt` returns gate state (PRD §8 tool 4), so gate rows must exist before Phase 3. **Decision:** gate rows are created and maintained from Phase 1 in every mode; only *enforcement* waits for Phase 3. `required` is fixed when the gate opens, from the quiz plan size.

### G9 — Decay is applied at read time only
Per PRD §7, decay is computed in `get_learner_profile` and in quiz-plan selection, and never written back. Stated here because two separate call sites must agree.

### G10 — Prerequisite ordering for `/eklavya:learn`
**Decision:** topological sort over `prerequisite_of` edges within the domain, filtered to concepts the learner has not mastered, cycles broken by tier then slug so the order is stable.

### D4 — `skills/` instead of `commands/` (supersedes PRD §6 layout)
The current docs describe `commands/` as the legacy flat-file form and say to use `skills/` for new plugins. Both produce the same `/eklavya:<name>` invocation. **Decision:** all five commands ship as `skills/<name>/SKILL.md` with `disable-model-invocation: true` (they are user-invoked), alongside the model-invoked `skills/tutor/`. One directory, one format.

---

## Tasks

### 1.1 Spaced repetition (`mcp/src/srs.ts`)
- [x] SM-2: `q >= 3` → interval 0→1→6→`interval × ease`; ease per standard formula, floor 1.3
- [x] `q < 3` → reps reset to 0, interval back to 1d
- [x] `score` = recency-weighted EMA per **G2**
- [x] `known` predicate: `score >= 0.7 && reps >= 2`
- [x] Read-time decay: −0.05 per overdue week, floor 0.3, never written back (**G9**)
- [x] `nextTierToAsk` per **G3**
- [x] Pure functions, no DB access, no clock reads — `now` is always a parameter

### 1.2 Config layer (`mcp/src/config.ts`)
- [x] Defaults per PRD §11
- [x] Global `~/.eklavya/config.json` merged with repo `.eklavya.json`, repo winning
- [x] Repo discovery: walk up from `cwd` to the repo root
- [x] Atomic writes (temp file + rename) — the git hook may read mid-write
- [x] Unknown keys preserved, not silently dropped

### 1.3 Session resolution (`mcp/src/session.ts`)
- [x] `resolveSessionId()` implementing the **G1** precedence chain
- [x] `meta.current_session` read/write helpers for Phase 2 to call

### 1.4 MCP tools (one file per tool, `mcp/src/tools/`)
- [x] `get_learner_profile` — mode, per-domain known/learning/unseen, weak, due, `suggested_tier` (**G4**), decay applied (**G9**)
- [x] `log_session_concepts` — upsert unknown slugs as `source='llm'`, insert `session_concepts`, open the gate (**G8**)
- [x] `get_session_quiz_plan` — selection order (a) session-unknown, (b) session-due, (c) global-due same domain; `tier_to_ask` per **G3**; cooldown per **G5**
- [x] `record_attempt` — attempt + SM-2 update + gate counters; returns `{ new_score, next_review, gate }`
- [x] `get_gate_status` — `{ mode, required, answered, passed, pass_threshold }`
- [x] `upsert_concepts` — validation, fuzzy dedupe (**G6**), per-session cap
- [x] `get_concept_graph` — nodes + edges, prerequisite-ordered (**G10**), optional mastery
- [x] `get_config` / `set_config`
- [x] Every response compact JSON within the **G7** budget

### 1.5 Tutor skill
- [x] `skills/tutor/SKILL.md` — the nine required behaviors from PRD §10
- [x] Per-tier question rubric with worked examples (tier-1 definitions … tier-5 failure modes)
- [x] Grading rubric that demands justification, to resist grade inflation (PRD §15)
- [x] States the **G1** session-id convention so the model passes the right value

### 1.6 User-invoked skills (**D4**)
- [x] `skills/setup/SKILL.md` — create DB, seed, check `jq`/`sqlite3`, choose mode (git hook install stubbed until Phase 3)
- [x] `skills/quiz/SKILL.md` — `[topic]` optional; session concepts by default
- [x] `skills/learn/SKILL.md` — `<topic>`, prerequisite-ordered (**G10**), profile-calibrated
- [x] `skills/progress/SKILL.md` — mastery map, due counts, weakest areas, metrics from PRD §16
- [x] `skills/gate/SKILL.md` — session gate status

### 1.7 Tests
- [x] SM-2 transitions for every grade path 0–5, across first/second/nth repetition
- [x] Ease-factor floor at 1.3
- [x] Score EMA per **G2**, including the single-attempt case
- [x] Decay math incl. floor at 0.3 and "not written back"
- [x] `tier_to_ask` escalation, de-escalation and clamping (**G3**)
- [x] Quiz-plan selection priority ordering, the `max` cap, and cooldown behavior in both modes (**G5**)
- [x] Fuzzy dedupe matches near-slugs and refuses to merge genuinely different ones (**G6**)
- [x] Config merge precedence (repo over global over defaults) and atomic write
- [x] Session-id precedence chain (**G1**)
- [x] Gate arithmetic: skips count as answered but never as passing
- [x] Integration: spawn server against a temp DB, run log → plan → record → profile and assert no known concept is re-asked

## Acceptance criteria (demo)

- [x] Ask Claude Code to build a small Express auth endpoint
- [x] `/eklavya:quiz` returns diff-grounded questions (references real files/decisions)
- [x] Answering updates `next_review` and `score` in the DB
- [x] Re-running `/eklavya:quiz` does not repeat already-known concepts
- [x] `/eklavya:progress` renders a sensible mastery map
- [x] `npm test` green

## Notes / decisions

**2026-08-26 — implementation complete, 130 tests green.** The five acceptance boxes above are left unchecked deliberately: they describe a *live* demo inside Claude Code, which needs the plugin loaded (`claude --plugin-dir /path/to/eklavya`) and a human answering questions. What is machine-verified today is the same loop over the real stdio transport, in `mcp/test/server.integration.test.ts`: log work → quiz plan grounded in the logged context → grade twice → concept reaches known → next plan no longer offers it.

Two rules changed during implementation because a test disproved them:

- **G2 alpha 0.5 → 0.6.** At exactly 0.5 the EMA is symmetric: `[0,0,5]` and `[5,5,0]` both score 0.50, so a learner who just turned the corner looked identical to one falling apart.
- **G6 rewritten.** Plain Jaccard could not fold `jwt-structure-basics` at 0.8, and at 0.65 it merged `refresh-token` with `refresh-token-rotation` and `auth-middleware` with `middleware-order-auth` — different concepts with the same 2-of-3-token shape. Similarity alone cannot distinguish a qualifier from a meaningful token, so qualifiers are now an explicit list and the threshold stays strict. A test asserts no two shipped seed concepts match each other.

Other notes:

- **Gate rows are live from Phase 1** in every mode (G8). `required` is frozen on first log and only ever grows; `passed` counts only concepts answered at grade ≥ 3, so a skip counts as answered but never as passing.
- **`record_attempt` on an unlogged concept** still adds it to the session, so quizzing review debt counts toward the gate rather than being free.
- **`set_config` gained a `scope`** (`global` | `repo`) so `/eklavya:setup` can pin enforced mode per project — the mechanism PRD §4 describes for team leads.
- **`get_concept_graph` gained `unmastered_only`**, which is what makes `/eklavya:learn` a short lesson instead of a re-teach of everything.
- The `tutor` skill states the G1 convention plainly: **omit `session_id`** and let the server resolve it.


---

## Live verification — 2026-08-26

Run against a real Claude Code session (`claude --plugin-dir`), in a throwaway git repo with `EKLAVYA_HOME`/`EKLAVYA_DB` pointed at scratch so no real learning history was touched.

- The plugin loaded, the MCP server connected, and `get_learner_profile` returned `{"mode":"ambient","domains":[{"domain":"web-auth","known":0,"learning":0,"unseen":33}],...}`.
- Concepts logged with real code context (`set httpOnly on the refresh cookie in auth.ts`) produced a **diff-grounded** question, unprompted: *"The refresh cookie in `auth.ts` gets `httpOnly: true`, while the access token stays in JS memory. Walk me through what the browser actually does differently with that cookie…"* — tier 2, mechanism, exactly per the rubric.
- Grading was honest in both directions and justified out loud: a **5** ("Clean mechanism, plus the CSRF catch I didn't ask for") and a **4** ("only gap was not pinning `alg` at the verifier"). The anti-inflation rubric held without prompting.
- SM-2 wrote through: `httponly-cookies` → score 1.0, reps 1, `next_review` exactly one day out.

The one item not exercised live is `/eklavya:learn`, which needs an interactive session rather than `-p`.

---

## Review pass — 2026-08-26 (question quality)

A read of the whole system against PRD goal 2 — *never ask the same question twice* — found the promise resting almost entirely on the model's goodwill. Closed:

- **`attempts.question` was write-only.** Every question ever asked was persisted and never read back. `get_session_quiz_plan` now returns `asked_before` (the last three questions per concept, with the tier and grade each got), and `record_attempt` returns `repeat_question` when the text it is recording is already on file under a loose fingerprint. The skill treats an entry in `asked_before` as spent, not as something to reword.
- **A concept answered in this session came straight back.** Grade 3 leaves a concept unmastered, so it stayed in selection path (a) — the learner could be asked about it again minutes later, and in enforced mode (no cooldown) reliably was. Concepts with an attempt in the current session are now excluded, with `reason: "already_covered"` when that empties the plan. The Stop hook applies the same filter.
- **`get_learner_profile` never named what was known.** The skill says "never ask about a mastered concept"; the tool returned only per-domain counts. It now returns `known` (capped at 30) and `known_total`.
- **Concept `description` never reached the question-former.** Every seed concept carries a canonical one-line meaning, and the quiz plan was dropping it — so a tier-3 question had only a slug and a diff to work from and drifted toward whatever the code happened to contain. The plan now carries `description`.
- **No prerequisite awareness at question time.** The graph knew that `httponly-cookies` needs `cookie-attributes`; the quiz did not. Plan items now carry `prereqs_unmet`, and picks are ordered foundations-first.
- **Topic quizzes bypassed the engine entirely.** `/eklavya:quiz <topic>` and `/eklavya:learn` hand-picked concepts off `get_concept_graph`, which returns the concept's own tier and no question history — so exactly the path a developer takes when they *ask* to be quizzed had the weakest repeat protection. `get_session_quiz_plan` now takes `domain` / `slugs`, so one selection engine serves both.
- **The cooldown refused explicit requests.** `min_minutes_between_quizzes` exists to stop Eklavya nagging; it was also refusing `/eklavya:quiz`. New `ignore_cooldown`, passed by the quiz and learn skills.
- **Two cooldown clocks disagreed.** The Stop hook measured minutes since the last *block*; the quiz plan measures minutes since the last *answer*. A manual quiz followed by a finished task therefore blocked the Stop and then handed the model `questions_needed: 0` — told to teach, given nothing to teach. The hook now checks both.
- **`max_stop_blocks_per_session` was a real config key with no supported way to set it** — read by `stop-quiz-check.sh`, absent from `EklavyaConfig`, `set_config`, the CLI and the example file. Wired through all four.
