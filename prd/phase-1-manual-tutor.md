# Phase 1 — Manual tutor

**Status:** ⬜ Not started
**Depends on:** Phase 0
**Spec:** [PRD §8](PRD.md#8-mcp-server-eklavya-mcp), [§10](PRD.md#10-the-tutor-skill-skillstutorskillmd), [§5.3](PRD.md#53-slash-commands)

## Objective

Make the teaching loop real and manually invokable. All eight MCP tools implemented, SM-2 working, the tutor skill written, and the slash commands driving it. Prove the loop *feels good* before automating it.

## Scope

In: MCP tools 1–8, `srs.ts`, tutor skill, five commands.
Out: hooks (Phase 2), gates enforcement (Phase 3).

## Tasks

### 1.1 Spaced repetition (`mcp/src/srs.ts`)
- [ ] SM-2: `q >= 3` → interval 0→1→6→`interval × ease`; ease per standard formula, floor 1.3
- [ ] `q < 3` → reps reset to 0, interval back to 1d
- [ ] `score` = EMA over last 5 grades, normalized 0..1
- [ ] `known` predicate: `score >= 0.7 && reps >= 2`
- [ ] Read-time decay: −0.05 per overdue week, floor 0.3, never written back
- [ ] Pure functions, no DB access (keeps them trivially testable)

### 1.2 MCP tools
- [ ] `get_learner_profile` `{ domain? }` → mode, per-domain known/learning/unseen, weak slugs, due list, suggested_tier
- [ ] `log_session_concepts` `{ session_id, concepts[] }` → upsert unknown slugs as `source='llm'`, insert `session_concepts`
- [ ] `get_session_quiz_plan` `{ session_id, max=4 }` → selection order (a) session-unknown, (b) session-due, (c) global-due same domain
- [ ] `record_attempt` `{ session_id, slug, question, answer, grade, difficulty, feedback }` → attempt + SM-2 update + gate counters; returns `{ new_score, next_review, gate }`
- [ ] `get_gate_status` `{ session_id }` → `{ mode, required, answered, passed, pass_threshold }`
- [ ] `upsert_concepts` `{ concepts[], edges? }` → slug validation, fuzzy dedupe, per-session new-concept cap
- [ ] `get_concept_graph` `{ domain, include_mastery? }` → nodes + edges, prerequisite-ordered
- [ ] `get_config` / `set_config` → `~/.eklavya/config.json` merged with repo `.eklavya.json` (repo wins)
- [ ] All responses compact JSON; enforce a size budget so they don't bloat context

### 1.3 Config layer
- [ ] `mcp/src/config.ts` — defaults per PRD §11, global + repo merge, written atomically
- [ ] Repo config discovery: walk up from `cwd` to find `.eklavya.json`

### 1.4 Tutor skill
- [ ] `skills/tutor/SKILL.md` — the nine required behaviors from PRD §10
- [ ] Per-tier question rubric with worked examples (tier-1 definitions … tier-5 failure modes)
- [ ] Grading rubric that demands justification, to resist grade inflation

### 1.5 Slash commands
- [ ] `commands/setup.md` — create DB, seed, check `jq`/`sqlite3`, choose mode, install git hook (hook install stubbed until Phase 3)
- [ ] `commands/quiz.md` — `[topic]` optional; session concepts by default
- [ ] `commands/learn.md` — `<topic>`, prerequisite-ordered, profile-calibrated
- [ ] `commands/progress.md` — mastery map, due counts, weakest areas, metrics from PRD §16
- [ ] `commands/gate.md` — session gate status

### 1.6 Tests
- [ ] SM-2 transitions for every grade path 0–5, across first/second/nth repetition
- [ ] Ease-factor floor at 1.3
- [ ] Decay math incl. floor at 0.3 and "not written back"
- [ ] Quiz-plan selection priority ordering, and the `max` cap
- [ ] Config merge precedence (repo over global over defaults)
- [ ] Integration: spawn server against temp DB, run log → plan → record → profile sequence

## Acceptance criteria (demo)

- [ ] Ask Claude Code to build a small Express auth endpoint
- [ ] `/eklavya:quiz` returns diff-grounded questions (references real files/decisions)
- [ ] Answering updates `next_review` and `score` in the DB
- [ ] Re-running `/eklavya:quiz` does not repeat already-known concepts
- [ ] `/eklavya:progress` renders a sensible mastery map
- [ ] `npm test` green

## Notes / decisions
