# Working in `mcp/`

The runtime: the MCP server, the SQLite store, the scheduling model, the hooks
and the `eklavya` binary. The root `CLAUDE.md` is the repo contract; this one is
what an agent editing code in this directory has to know before it does.

## The map

| Module | Owns | Deliberately does not |
|---|---|---|
| `src/config.ts` | the four dials, defaults, global+repo merge, `coerce()` | never touches the db |
| `src/paths.ts` | every path and env override; nothing else may join `~/.eklavya` by hand | |
| `src/srs.ts` | SM-2, mastery scoring, decay, tier selection, level bands, promotion rules | no db, no clock |
| `src/store.ts` | every query. Gates, level standing, question history, graph walks | no MCP, no config decisions beyond what it is handed |
| `src/db.ts`, `src/migrate.ts`, `src/migrations/` | `openDb()` — pragmas, then migrate, then seed; forward-only numbered SQL with the version in `meta` | |
| `src/seed.ts`, `src/seed/` | the shipped concept graphs, validated on load | never touches `mastery` — a learner's history survives every seed update |
| `src/packs.ts` | concept packs from `~/.eklavya/packs/` and `<repo>/.eklavya/packs/`, applied over the seed. Reads never throw: one bad file costs one pack, not `openDb()` | never removes anything — deleting a pack's concepts would delete the attempts pointing at them |
| `src/stdin.ts` | the bounded stdin read shared by the hooks and `eklavya statusline` — idle timer, total cap, `error` handler, `unref`, BOM strip. A hook that waits is worse than one that throws | never rejects; a caller that cannot read its input has a fallback |
| `src/session.ts`, `src/slug.ts`, `src/concurrency.ts` | session-id resolution; slug normalization and fuzzy matching; `retryOnBusy` | |
| `src/statusline.ts` | `[EKLAVYA ambient · concept · interleaved · easy]` — the dials, for `eklavya statusline` and the host's status bar | never per-question: no tier, no counter |
| `src/ask.ts`, `src/mcq.ts` | stripping a settings line back out of a recorded stem (history only — nothing composes one now); the deterministic `answerPosition` | |
| `src/server.ts` | stdio MCP wiring only. **stdout is the protocol** — diagnostics go to stderr | |
| `src/tools/*.ts` | one file per tool, registered in `tools/index.ts` | |
| `src/hooks/*.ts` | one file per hook plus `lib.ts`; `run()` swallows everything and exits 0 | |
| `src/eval/*.ts` | the offline half of the eval — `question-checks.ts` (question shape), `extraction-score.ts` (are the logged concepts right, scored with `slug.ts`'s own matcher), `history-stats.ts` (repeat rate, tier calibration) and `extract-json.ts`. Pure, like `srs.ts`. Driven by `eval/harness.mjs` at the repo root | no model, no I/O; anything needing a judge stays out |
| `src/install.ts` | `eklavya install/uninstall` — Node check, runtime, plugin payload, registry files, db | |
| `src/dashboard.ts` + `src/assets/dashboard.html` | the local page on loopback (default port 41729). Read `.claude/skills/eklavya-dashboard/SKILL.md` first | |

`src/cli.ts` is the `eklavya` binary — it builds to `dist/cli.js`, which is
`package.json`'s `bin`. The top-level `cli/` directory is **not** this: it holds
`eklavya-gate`, a POSIX script, because a git pre-commit hook must not pay Node's
startup cost. The names invite the mistake; check which one you are in.

## `config.ts` is the source of truth for the dials

Four of them: `mode` (`ambient`), `focus` (`concept`), `cadence` (`interleaved`),
`difficulty` (`auto`). Everything else — the site, the manual, the skills, the
tool descriptions — is a copy that drifts.

**`focus` defaults to `concept`, not `project`.** "Defaults to project" is the
single most-repeated drift in this repo: it was once wrong in three skills and a
tool description at the same time, and the hooks framed questions one way while
the server framed them another. Before shipping anything that touches `focus`,
`grep -rin "defaults to project"` and `grep -rniE "focus.{0,12}default"` across
`skills/`, `user-skill/`, `web/` and `mcp/src/`.

Adding or changing a config key means all of:

1. the field on `EklavyaConfig`, with the comment saying why the default is that,
2. `DEFAULT_CONFIG`,
3. a branch in `coerce()` — **an uncoerced key is silently dropped**; the file
   accepts it, `get_config` never shows it, and nothing errors,
4. the `USAGE` string in `src/cli.ts` (both the command help and the key list),
5. `set_config`'s `inputSchema` in `src/tools/config_tools.ts` — the schema is the
   only gate now; the handler builds its patch from `Object.keys(DEFAULT_CONFIG)`
   rather than a hand-listed array, so a key you add to `DEFAULT_CONFIG` and the
   schema is written without a third edit. Keep it that way: the array it replaced
   was a place a new key got accepted and then silently discarded,
6. the docs the root `CLAUDE.md` names.

## Tool descriptions are code

The model reads them; nothing else does. A wrong default or a stale rule in a
`.describe()` misbehaves silently — no test fails, the model just does the wrong
thing. Every string in `src/tools/` is behaviour: update it in the same diff as
the logic it describes.

## The two gate counters

Read `countAnswered` and `syncGate` in `store.ts` before touching either.

- `gates.answered` counts **every** concept attempted this session, review debt
  included. Quizzing on review is not free, so it shows up here.
- the passing count only counts concepts whose `session_concepts.origin` is
  `'work'`. The bar is set by the diff, so review debt must not clear it:
  otherwise `concept` focus widening to domain siblings, or `learn` focus asking
  about an unrelated topic, would pass a gate without a single question about
  today's work.

`GateStatus` therefore carries `passed_count` and `needed`
(`ceil(required * pass_threshold)`) as well as `answered`, so `/eklavya:gate` can
say what remains — `needed - passed_count` — rather than only that it is shut.
`required` never falls: `syncGate` takes `max(existing, requiredHint)`.

`required` is capped: `log_session_concepts` passes
`requiredHint: Math.min(unmastered, max_questions_per_task)`. That cap is what
makes the docs' "three of four" true — 4 questions, `pass_threshold` 0.7,
`ceil(4 * 0.7) = 3`. Change either default and the example is wrong everywhere.

## `declined` and `dont_know` are not interchangeable

`gateRetryConcepts` in `store.ts` excludes concepts whose latest outcome is
`declined`, and that exclusion is the only thing standing between a blanked
session and an unpassable commit gate. `outcome` is supplied by the model and
cross-checked against nothing, so a blank mislabelled as a decline strands the
developer while the tool reports enforcement working correctly.

Two guards, neither of which guesses at what happened. `record_attempt` returns
`outcome_conflict` when handed `declined` together with `feedback` — a decline
that was dropped immediately has nothing to explain. And the exclusion asks for
a *clean* decline: a declined row carrying feedback is not treated as one, since
the two mistakes are not symmetric. An unnecessary retry question costs a
question; a wrongly excluded concept costs the developer their commit.

A real answer history had 11 of 16 declines carrying an explanation, which is
what these exist for.

## Slug matching has three passes, and only one is fuzzy

`findFuzzyMatch` tries qualifier-stripped equality, then **plural-insensitive**
equality, then `tokenJaccard` against `FUZZY_MATCH_THRESHOLD` (0.8).

The middle one is narrow on purpose. `claude-code-hook-lifecycle` and
`claude-code-hooks-lifecycle` are one concept split by a letter and score 0.60,
so no threshold reaches them without also merging `refresh-token` into
`refresh-token-rotation` — the pair `slug.ts`'s own comment names as one that
must never merge. Being an equality test rather than a score keeps it from
touching anything else: measured against a 249-concept graph it merged exactly
two pairs.

`singular()` guards `ss`/`us`/`is` endings and a short denylist, because
singularising `https` yields `http` and would merge two different ideas. It only
prevents *new* duplicates; concepts already split in an existing graph stay
split.

## `srs.ts` is pure

No database, no clock; `now` is always a parameter. That is why the whole
scheduling model is testable without freezing time, and why `test/srs.test.ts`
and `test/level.test.ts` are plain function tests. Keep it that way — if a
function there needs a row, it belongs in `store.ts`.

## Levels reset on promotion

`levelCounts(db, repo, level, since)` takes `since = promoted_at`: answers earned
at the previous band are spent. Anything — a doc, a CLI line, a tool response —
that says "100 answers in this project" without "at this band" is wrong. The
counts are derived from `attempts`, never stored, so lowering `level_up_after`
releases learners already past it.

## The interleaved one-question cap lives in the planner

Not in the config. `src/tools/get_session_quiz_plan.ts`:

```ts
const capped = config.cadence === 'interleaved' && config.mode !== 'enforced' && !explicitTopic;
const max = args.max ?? (capped ? 1 : config.max_questions_per_task);
```

`explicitTopic` is `Boolean(args.domain || args.slugs?.length)` and is computed
*before* `learn` focus resolves `focus_topic` into a domain or slugs — so a
`learn` plan is still capped, while a developer who asked for a domain is not.
An explicit `max` bypasses the cap entirely, whatever the cadence. Enforced mode
is exempt for the same reason it ignores the cooldown: the gate needs
`ceil(required * pass_threshold)` passes, and one-at-a-time cannot deliver them.

## Return shapes are capped — callers must not assume otherwise

`get_learner_profile`: `known` is ordered by **score descending, not date**, and
sliced to `KNOWN_CAP` (30), with `known_total` carrying the real count. `weak`,
`due_for_review`, `projects`, `recent_concepts` and `skipped` are each capped at
`LIST_CAP` (8). `truncated` says whether anything was cut. `recentQuestions`
defaults to 3; `hasAskedQuestion` fingerprints only the last 20 attempts.

## Storage

Node 22+ (`engines`), because below it `better-sqlite3` has no prebuilt binary
and falls through to node-gyp. `openDb()` sets `journal_mode = WAL` (several
sessions plus the git hook share the file), `foreign_keys = ON`, and
`busy_timeout = 5000`.

`retryOnBusy` (`src/concurrency.ts`) covers what the timeout does not: two
writers upgrading to a write transaction at the same instant get `SQLITE_BUSY`
immediately rather than waiting. A busy transaction has already rolled back, so
the retry is safe for writes as well as reads — which is why `tools/index.ts`
runs **every** tool handler through it. A tool that bypasses `registerTools`
loses that, and the JSON error envelope with it.

Env overrides, all in `paths.ts`: `EKLAVYA_HOME` (state directory — how tests
avoid the real learner's data), `EKLAVYA_DB` (the file itself),
`EKLAVYA_SESSION_ID` (the session key the hooks and the server must agree on;
see `resolveSessionId`).

Migrations are forward-only. Adding one means bumping, in the same change,
`LATEST_SCHEMA_VERSION` (currently 8), the file list in the "upgrades an older
install" case, and `EXPECTED_TABLES` (currently 10) in `test/migrate.test.ts`.

The seed catalogue is **87 concepts** across four files in `src/seed/` — git 19,
node-backend 17, react 18, web-auth 33. Recount when a seed file changes, fix any
doc hardcoding the total, and bump `SEED_VERSION` so existing installs pick it up.

Packs land **after** the seed, and that ordering is load-bearing: `seedIfNeeded`
upserts every shipped concept back to its shipped name and tier, so a pack that
had merged over one is undone by a re-seed unless it lands again.

Which is why `SEED_VERSION` is folded into the pack fingerprint rather than
handled by a `force` flag from `openDb()`. A flag only re-applies for the
directory the learner happened to be in when the re-seed ran; folding the seed
version in marks **every** scope stale, so each repository re-applies its own
packs the next time it is opened. There is one fingerprint row per set of pack
directories (`packs_fingerprint:<hash of the dirs>`), not one per install — a
single global row had two repositories overwriting each other's hash on every
`openDb()`, which is a write on every CLI invocation for anyone with a repo pack
and more than one project. The write on the way out happens even when nothing
was applied: it is what records that this scope has seen this state, and
skipping it for the empty set means the next open finds no row and applies
again, for ever.

`eklavya doctor` is the one caller that applies **unconditionally**, and that is
its job: a same-size edit that preserves the mtime is invisible to the
fingerprint, and `doctor` is where someone goes when a pack is not taking
effect. A malformed pack is reported there without failing the run, because the
blanket remedy `doctor` prints is `eklavya install`, which never touches
`~/.eklavya/packs/`.

`concepts.source` says where a row came from: `seed`, `pack`, or `llm` from
`upsert_concepts`. There is no repository column, so a repo pack's override of a
shipped slug is global to that learner — `web/src/content/docs/docs/packs.mdx`
says so, and a real fix means a per-repo overlay, which is a design change.

## Running it

```
npm test              # pretest builds first — dist/ must exist
npm run build         # tsc + scripts/copy-assets.mjs
npm run dev           # tsx src/server.ts
node dist/cli.js doctor
```

The hook, CLI, install, gate, concurrency and packaging suites all exec built
files under `dist/`, so a stale or missing build fails them for reasons that look
nothing like the real cause. `npm test` handles it; bare `vitest` does not.

A behaviour change here is not finished until the manual, the landing page and
`README.md` agree with it. The root `CLAUDE.md` has the map of which page owns
what — follow it rather than guessing.
