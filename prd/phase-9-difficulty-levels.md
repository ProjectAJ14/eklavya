# Phase 9 — Difficulty levels, earned per project

**Status:** implemented, awaiting release
**Spec:** PRD §7 (mastery, migration 008), §11 (config), §9 (hooks)

## The problem

Eklavya already varies difficulty — `nextTierToAsk` pushes a concept from tier 1
to tier 5 as the learner gets it right, and `suggestedTier` pitches a new domain
at the median tier of what they already know. That is per-concept calibration,
and it is the right mechanism at the wrong altitude.

What it cannot express is *where this learner is, on this codebase, right now*.
Two failures follow:

1. **A cold start can open at tier 3.** `suggestedTier` takes the median of
   mastered tiers across the whole graph. Someone with a solid `web-auth` history
   who opens an unfamiliar React codebase gets judgement questions about code
   they met four minutes ago. The honest answer is "I have no idea", the honest
   response to that is to turn the plugin off, and the learning never starts.
2. **There is no felt progression.** Tier movement is invisible: it happens per
   concept, inside a plan the developer never sees. Nothing ever says *you have
   moved up*. A tool whose entire value is compounding needs a visible ratchet,
   or the first week feels identical to the tenth.

The fix is a coarse band above the tier ladder — three levels, started at the
bottom, earned by evidence, held per project.

## Levels, and why they are not tiers

| Name | What it is | Where it lives |
|---|---|---|
| **tier** | how hard *this question* is: 1 recall … 5 design | `concepts.tier`, `attempts.difficulty`, `tier_to_ask` |
| **level** | how hard *questions on this project* are allowed to get: easy / medium / hard | `project_levels.level`, `attempts.level` |

The level does not replace tier selection. It **clamps** it:

| Level | Tier band | The questions the developer actually sees |
|---|---|---|
| `easy` (start) | 1–2 | what a thing is, and what the machine does with it |
| `medium` | 2–4 | why this choice here, and what breaks it |
| `hard` | 3–5 | judgement, failure modes, when the architecture is wrong |

Two properties of that table are deliberate:

- **The bands overlap.** Promotion is not a cliff. A newly promoted learner still
  meets tier 2 questions; what changes is that tier 3 and 4 are now reachable.
- **`hard` drops the tier-1 floor.** At `hard`, a definition question is no
  longer a legitimate question about a concept the learner has been carrying for
  a hundred answers.

`easy` capping at tier 2 is the load-bearing part of the whole phase. Tier 1 and
2 are answerable by someone who was *watching* the agent work, which is exactly
the state Eklavya finds people in. That is what makes the first fortnight
answerable, and answerable is what makes it survive to week ten.

## Why per project

Because "how hard should this be" is a question about a codebase, not about a
person. A senior Node developer on their fourth service and the same person on
their first Rust repo are different learners, and one global level would have to
be wrong for one of them.

- Level state is keyed on the **git root** (`repoRoot` from `findRepoConfig`,
  already `realpath`ed so the git hook and the server agree).
- No git root — a scratch directory — falls into one shared `*` bucket rather
  than minting a row per `cwd`.
- A `git worktree` of the same repo has a different root and therefore its own
  level. Accepted for now; unifying via `git rev-parse --git-common-dir` is a
  later refinement, not a blocker.

The plugin stays installed globally and the database stays single. Only the
progression is scoped.

## The promotion rule

Promotion fires from `record_attempt`, in the same transaction as the grade, and
requires **all** of:

| Condition | Default | Why it is there |
|---|---|---|
| passing answers at this level, in this repo, since it was entered | `level_up_after: 100` | the ratchet the developer is working toward |
| accuracy over those attempts (`passed / answered`, declines excluded) | `level_up_accuracy: 0.7` | 100 answers of which 60 were wrong is not evidence of readiness |
| distinct concepts among the passes | `requiredConcepts(after)` — a third of the runway, capped at 15 | stops one concept re-asked forty ways from carrying a promotion |

"Passing" is `grade >= 3`, the same bar the commit gate uses. Declines
(`outcome: 'declined'`) count for nothing in either half of the accuracy
fraction — skipping a question must not damage a level, or the level becomes a
reason to answer carelessly rather than to skip honestly.

**No demotion.** Losing a level reads as punishment, and this phase exists to
protect engagement. A bad run is already handled a tier at a time:
`nextTierToAsk` drops the tier on any grade ≤ 2, and the band floor catches it.
The P1 refinement below adds a *stall* instead of a demotion.

### What the developer sees

One line, at the moment it happens, from the tutor:

> That's `easy` cleared on this repo — 100 answers, 78% right. Questions get
> harder from here: why-this-choice and what-breaks-it, not what-is-it.

Stated once, factually, and then straight back to the work. The `gate` skill's
"don't celebrate" rule holds.

## Where the level is read

| Surface | Change |
|---|---|
| `get_session_quiz_plan` | clamp every `tier_to_ask` into the band, including the `gate_retry` tier drop; return `level`, `level_progress`, and a `level_framing` line beside `framing` |
| `get_learner_profile` | clamp `suggested_tier` and each `due_for_review.tier_to_ask`; return the repo's level and progress |
| `record_attempt` | stamp `attempts.repo` and `attempts.level`; evaluate promotion; return `level_up` when it fired |
| `session-start.sh` | one clause on the existing profile line: `Level: easy (37/100 on this project).` |
| `checkpoint-quiz.sh`, `stop-quiz-check.sh` | no change — the planner has already clamped |

## Saying which settings asked the question

With `difficulty` there are four dials, and at the one moment they change what
the developer is looking at — a question on screen — every one of them is
invisible. That gap is not cosmetic:

- On `concept` focus, a deliberately transferable question reads as a vague one.
  The developer answers about their file, gets marked down, and concludes the
  quiz is badly written rather than that it was asking for the general rule.
- On `easy`, tier-1 and tier-2 questions read as Eklavya being shallow rather
  than as a runway they are 37 answers into. The whole engagement argument for
  levels depends on the runway being *seen*.
- On a repo that pins `difficulty`, questions stop getting harder forever and
  nothing on screen says why.

### Where it goes, and where it must not

Not the `header`. `AskUserQuestion` caps it at 12 characters and it is already
spent on `Eklavya`, which is the only thing on screen saying who is asking
(1.4.1, commit 80ada06). Trading attribution for settings would re-open the bug
that fixed: a question arriving mid-task with no name on it reads as Claude going
off-piste.

So: a **footer line on the stem**, after a blank line, in the plan's own words:

```
Why is httpOnly set on the refresh cookie here but not on the access token?

concept · easy · tier 2
```

Composed **server-side** and returned per plan item as `ask_footer`, for the same
reason `framing`, `answer_position` and `format_to_use` are: a string each
question assembles for itself is a string that drifts, and this one has to be
identical every time or it becomes decoration instead of a readout.

| Dial | In the footer? |
|---|---|
| `focus` | always — `concept`, `project`, or `learn: caching` with the topic |
| `difficulty` | always — the level, and `easy (pinned)` when config pins it |
| tier | always — `tier 2`, the one number that says how hard this specific question is |
| `mode` | only when `enforced`, as a trailing `· gated`; ambient has nothing to warn about |
| `cadence` | never. The question's *arrival* already tells them when it asks |

`quiet: true` suppresses the footer. Someone who has turned the narration off has
answered this question already.

One thing to verify before building it, per PRD §6: that `AskUserQuestion`
preserves the newline in a stem when Claude Code renders it. If it collapses,
the footer becomes a trailing ` — concept · easy · tier 2` on one line and the
fingerprint strip changes shape with it. Pin the finding in
`docs/verified-schemas.md` either way.

### The stem is still the stem

`record_attempt` takes the stem **without** the footer — the footer is presentation,
and `question` is what `questionFingerprint` hashes. A footer inside it would make
the same question look new every time the level changed, which is exactly the
failure migration 006 kept the options out of the stem to avoid.

Belt and braces, because the tutor will eventually paste the whole block:
`questionFingerprint` strips a trailing line matching the footer's own shape
(`focus · level · tier N`, optionally `· gated`) before hashing. Strict pattern,
last line only, so it can never eat a real stem.

## Config

Three new keys in `mcp/src/config.ts`, which stays the source of truth:

```jsonc
{
  // 'auto' (default) earns the level; a literal level pins it and stops progression
  "difficulty": "auto",       // auto | easy | medium | hard
  "level_up_after": 100,      // passing answers needed at the current level
  "level_up_accuracy": 0.7    // minimum accuracy over those answers
}
```

`difficulty` is a hard set, not a floor: a repo pinning `easy` is an onboarding
codebase that should stay gentle for everyone, and a senior pinning `hard`
globally has said they do not want the runway. Pinned repos still record
`attempts.level`, so history stays readable if the pin is later removed.

Repo-wins precedence is unchanged, which means a lead can pin a project's level
in `.eklavya.json` and `ResolvedConfig.overrides` will report it — the existing
machinery for "your personal setting stopped applying" already covers this.

## Data model — migration 008

```sql
ALTER TABLE attempts ADD COLUMN repo  TEXT;
ALTER TABLE attempts ADD COLUMN level TEXT
  CHECK (level IN ('easy','medium','hard'));

CREATE TABLE IF NOT EXISTS project_levels (
  repo        TEXT PRIMARY KEY,          -- git root, or '*' when there is none
  level       TEXT NOT NULL DEFAULT 'easy'
              CHECK (level IN ('easy','medium','hard')),
  promoted_at TEXT,                      -- when this level was entered; counting starts here
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_attempts_repo_level ON attempts(repo, level, ts DESC);
```

Two decisions worth stating:

- **Progress is derived, not counted.** No `passed_at_level` column. The count is
  a query over `attempts` since `promoted_at`, which means changing
  `level_up_after` applies retroactively and correctly, and a counter can never
  drift from the attempt rows that justify it. `idx_attempts_repo_level` is what
  keeps that read cheap enough for `session-start.sh`, which runs on the critical
  path of a user action.
- **Existing attempts carry NULL `repo` and NULL `level`** and are therefore
  invisible to level counting. Every learner starts at `easy` with zero progress
  on the day this ships. Back-filling `repo` is impossible (the session's cwd was
  never recorded), and inventing a level for a tier-3 answer taken before levels
  existed would hand out promotions nobody earned.

## Tasks

- [x] `008_difficulty_levels.sql`; bump `LATEST_SCHEMA_VERSION` and
      `EXPECTED_TABLES` in `mcp/test/migrate.test.ts`
- [x] `srs.ts`: `Level`, `LEVEL_BANDS`, `clampToLevel`, `shouldPromote` — all
      pure, all unit-tested with no clock and no db
- [x] `store.ts`: `projectLevel`, `levelProgress`, `promoteLevel`; `repo` and
      `level` on `recordAttemptRow`
- [x] `config.ts`: `difficulty`, `level_up_after`, `level_up_accuracy` + coercion
- [x] `get_session_quiz_plan`: clamp, plus `level` / `level_progress` /
      `level_framing` in the response
- [x] `get_session_quiz_plan`: `ask_footer` per item, suppressed under `quiet`
- [x] `questionFingerprint`: strip a trailing footer line before hashing
- [x] `record_attempt`: stamp, evaluate, return `level_up`
- [x] `get_learner_profile`: clamped `suggested_tier`, level in the payload
- [x] `config_tools.setConfig`: the three keys, with descriptions
- [x] `session-start.sh`: level clause, one query, exits 0 on any failure
- [x] `skills/tutor`: the band table, what each level may ask for, the promotion
      line, and "never ask above the band"
- [x] `skills/tutor`: render `ask_footer` as the last line of the stem, and
      record the stem without it
- [x] `skills/level` (new, `disable-model-invocation: true`) — show progress,
      change the pin on request
- [x] `skills/mode`: a fourth row, pointing at `/eklavya:level`
- [x] `skills/progress`: level and progress per project
- [x] Tests: band clamping, promotion predicate (boundaries, accuracy floor,
      anti-grind), pin disables progression, two repos progress independently,
      pre-migration NULL rows are ignored, hook line renders, `ask_footer`
      for each focus/level/mode combination, footer stripped by the fingerprint,
      footer absent under `quiet`
- [x] Docs, together and in the same change: `site/` (`#how` ladder gets the
      three bands, `#dials` becomes four, `#commands` becomes seven, hero
      terminal's question shows the footer line), `README.md`,
      `.eklavya.json.example`

## What changed while building it

- **The concept floor scales.** A flat 15 would have made `level_up_after: 5`
  unsatisfiable — fifteen distinct concepts cannot appear among five passing
  answers — so the promotion would never fire and nothing on screen would say
  why. `requiredConcepts` is now `min(15, ceil(after / 3))`, which keeps the
  anti-grind guard proportional to whatever runway is configured. Anyone
  shortening the runway is the most likely first change after watching a real
  learner, so the trap was worth removing up front.
- **`promoted_at` is written by SQLite, not by JS.** `attempts.ts` defaults to
  `datetime('now')` and progress is counted by comparing the two as strings. An
  ISO timestamp with a `T` in it sorts wrong against `2026-08-27 09:31:00`, which
  would have silently counted the previous band's answers toward the next
  promotion.
- **The hero terminal lost a duplicate.** The demo previously narrated
  `◆ eklavya · httponly-cookies · tier 2` above a question whose footer now says
  the tier itself; the narration line is `· checkpoint ·` instead.
- **One thing is still unverified**, and is written up in
  `docs/verified-schemas.md`: whether `AskUserQuestion` preserves the newline
  before the footer when Claude Code renders a stem. Nothing breaks if it does
  not — the footer reads as a trailing clause — but `stripAskFooter` anchors to a
  trailing line, so the regex changes shape if newlines are collapsed.

## Open decisions

1. **100 is a long runway.** At `max_questions_per_task: 4` it is ~25 sessions
   per level, and per-project scoping means every new repo starts that runway
   again. Options: keep 100 as specified; drop the default to 50; or make the
   first level shorter than the later ones (`easy: 40`, then 100). Recommend
   shipping 100 and watching one real repo — the pin is the escape hatch until
   then.
2. **No carry-over between projects.** A learner at `hard` on three repos still
   starts the fourth at `easy`. Correct for a genuinely unfamiliar stack, tedious
   for a fourth service in the same framework. Deliberately out of scope here; if
   it bites, the cheapest version is a shorter `level_up_after` for a repo whose
   domains the learner already has mastery in, not a global level.
3. **Formats stay MCQ.** Mapping `medium` → `fill_blank` and `hard` → `open`
   is the obvious extension and is where phase 7's unshipped formats belong, but
   nothing ships in `site/` or `README.md` about it until that code exists.

## P1 refinement — the stall

Instead of demotion: when the last 10 attempts at the current level are below
0.4 accuracy, the planner floors `tier_to_ask` at the band's low end and sets
`level_stalled: true`, and the tutor eases off — mechanism questions, more
teaching in the feedback, no judgement questions. Level is retained. Pure
function in `srs.ts`, one flag in the plan, no schema change.

## Acceptance

1. Fresh database, fresh repo: every question in the first session is tier 1 or
   2, and `get_session_quiz_plan` reports `level: "easy"`.
2. Scripted 100 passing attempts at `easy` in repo A: the 100th response carries
   `level_up: {from: "easy", to: "medium"}`, and the next plan contains a tier-3
   or tier-4 `tier_to_ask`.
3. Repo B, same database, immediately after: still `easy`, still tier ≤ 2.
4. `.eklavya.json` with `"difficulty": "hard"`: tier 3–5 from the first question,
   and no promotion row is ever written.
5. 100 attempts at 50% accuracy: no promotion, and `level_progress` says which
   condition is unmet.
6. Every question carries a footer naming the focus, the level and the tier;
   `enforced` adds `· gated`; `quiet: true` removes it; and the recorded
   `question` never contains it.
7. `site/`, `README.md` and `.eklavya.json.example` describe four dials, seven
   commands and the three levels, and match `mcp/src/config.ts` exactly.
