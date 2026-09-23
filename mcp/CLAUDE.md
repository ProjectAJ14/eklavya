# Working in `mcp/`

The runtime: the MCP server, the SQLite store, the scheduling model, the hooks
and the `eklavya` binary. The root `CLAUDE.md` is the repo contract; this one is
what an agent editing code in this directory has to know before it does.

## The map

| Module | Owns | Deliberately does not |
|---|---|---|
| `src/config.ts` | the dials, defaults, global+repo merge, `coerce()`, and `normalizeLegacyKeys()` — the `mode` → `quiz` alias, applied per file *before* the merge | never touches the db |
| `src/paths.ts` | every path and env override, including `projectConfigPath` — per-project settings, keyed by checkout, **outside** the repository; nothing else may join `~/.eklavya` by hand | |
| `src/srs.ts` | SM-2, mastery scoring, decay, tier selection, level bands, promotion rules | no db, no clock |
| `src/store.ts` | every query. Gates, level standing, question history, graph walks | no MCP, no config decisions beyond what it is handed |
| `src/db.ts`, `src/migrate.ts`, `src/migrations/` | `openDb()` — pragmas, then migrate, then seed; forward-only numbered SQL with the version in `meta` | |
| `src/seed.ts`, `src/seed/` | the shipped concept graphs, validated on load | never touches `mastery` — a learner's history survives every seed update |
| `src/packs.ts` | concept packs from `~/.eklavya/packs/` and `~/.eklavya/projects/<slug>/packs/`, applied over the seed. `<repo>/.eklavya/packs/` is still **read** as the pre-move home and never written. Reads never throw: one bad file costs one pack, not `openDb()` | never removes anything — deleting a pack's concepts would delete the attempts pointing at them |
| `src/stdin.ts` | the bounded stdin read shared by the hooks and `eklavya statusline` — idle timer, total cap, `error` handler, `unref`, BOM strip. A hook that waits is worse than one that throws | never rejects; a caller that cannot read its input has a fallback |
| `src/session.ts`, `src/slug.ts`, `src/concurrency.ts` | session-id resolution; slug normalization and fuzzy matching; `retryOnBusy` | |
| `src/statusline.ts` | `[EKLAVYA concept · interleaved · easy]` — the dials, for `eklavya statusline` and the host's status bar, with `enforced` prepended only when set | never per-question: no tier, no counter |
| `src/ask.ts`, `src/mcq.ts` | stripping a settings line back out of a recorded stem (history only — nothing composes one now); the deterministic `answerPosition` | |
| `src/server.ts` | stdio MCP wiring only. **stdout is the protocol** — diagnostics go to stderr | |
| `src/tools/*.ts` | one file per tool, registered in `tools/index.ts` | |
| `src/hooks/*.ts` | one file per hook plus `lib.ts`; `run()` swallows everything and exits 0 | |
| `src/eval/*.ts` | the offline half of the eval — `question-checks.ts` (question shape), `extraction-score.ts` (are the logged concepts right, scored with `slug.ts`'s own matcher), `history-stats.ts` (repeat rate, tier calibration) and `extract-json.ts`. Pure, like `srs.ts`. Driven by `eval/harness.mjs` at the repo root | no model, no I/O; anything needing a judge stays out |
| `src/install.ts` | `eklavya install/uninstall` — Node check, runtime, plugin payload, registry files, db | |
| `src/onboard.ts` | the settings walk `install` runs every time — one step per dial, an arrow-key list starting on the current value (`press` is the pure key reducer); writes only the global config, only what changed | no onboarded flag, and never asks about project scope |
| `src/claude-mem.ts` | install's Claude Mem question: detect it, place its projects from Claude Code's transcripts, uninstall its plugin, retire `~/.claude-mem` | never deletes Claude Mem's data — it is moved, and it is the rollback |
| `src/theme.ts` | the look of every terminal byte the CLI prints — the verdigris palette, glyphs, `check` rows, `spin`, `verdict`. Ported from talea's `theme.js`/`log.js`; change both together | not the status bar or session banner: the host draws those |
| `src/dashboard.ts` + `src/assets/dashboard.html` | the local page on loopback (default port 41729). Read `.claude/skills/eklavya-dashboard/SKILL.md` first | |
| `src/memory/` | the other half: `capture.ts` (the one intake), `privacy.ts` (redaction, before persistence), `spool.ts` (the degraded path), `store.ts` (every memory query), `search.ts` (keyword/semantic/hybrid), `embed.ts` (`local-hash-v1`), `summarize.ts` + `provider.ts` (the `Summarizer` port and its two implementations), `worker.ts` (leased jobs, no daemon), `reservation.ts` (the one machine-wide worker slot and the `EKLAVYA_INTERNAL_OBSERVER` marker every hook honours), `recall.ts` (what the model is handed, and the receipt that proves it), `replay.ts`, `learning.ts` (evidence → candidates), `collections.ts`, `code.ts`, `notify.ts`, `sync.ts`, `import.ts` (+ `import-worker.ts`, the same import on a worker thread so the CLI's spinner can turn), `hosts.ts`, `identity.ts`, `tokens.ts` | no MCP, no hooks; `domain`-style purity is not enforced, but nothing here reaches for a host API |
| `src/time.ts`, `src/config-path.ts` | the one clock policy both halves parse with; dotted config keys derived from `DEFAULT_CONFIG` | |

`src/cli.ts` is the `eklavya` binary — it builds to `dist/cli.js`, which is
`package.json`'s `bin`. The top-level `cli/` directory is **not** this: it holds
`eklavya-gate`, a POSIX script, because a git pre-commit hook must not pay Node's
startup cost. The names invite the mistake; check which one you are in.

## Two halves, one database, one rule between them

`memory.enabled` is not governed by `quiz`, and nothing in `src/memory/` may
touch `attempts`, `mastery` or `gates`. The one bridge is `learning_sources`:
evidence proposes a **candidate**, and only an answered question moves mastery.
An observation is not an assessment, and every test in `memory-learning.test.ts`
exists to keep it that way.

The practical consequence when editing a hook: the memory work goes **before**
the `quiz.enabled` check, and the learning work after it. `hooks/memory-lib.ts` holds
the shared helpers and every one of them swallows its own failures — capture
runs after every tool call, so a throw there is a throw on every tool call.

## `config.ts` is the source of truth for the dials

`quiz` (`{enabled: true, enforced: false}`), `focus` (`concept`), `cadence`
(`interleaved`), `difficulty` (`auto`). Everything else — the site, the manual,
the skills, the tool descriptions — is a copy that drifts.

**`quiz` replaced a `mode` dial (`ambient` | `enforced` | `off`) and the old
spelling is still read, for ever.** A config written against `mode` outlives the
rename by years — and dropping the alias would not error, it would silently
revert a pinned gate to the default. `normalizeLegacyKeys` does the
rewrite **per file, before `mergeConfigs`**; resolving it on the merged object
instead lets a global `quiz` outrank a repo `mode`, which is the repo losing a
fight it is supposed to win. `cli/eklavya-gate` duplicates the same alias in jq,
and `test/gate.test.ts` runs both parsers over one set of configs.

`quiz.enabled: false` with `quiz.enforced: true` is the one incoherent
combination the flags can express and the enum could not — a gate whose
questions are never asked. `coerceNamespaces` drops the enforcement rather than
the silence (locking somebody out of `git commit` is the worse way to be wrong),
and `eklavya doctor` reports it, because a silently-resolved contradiction is a
lead believing commits are held when they are not.

**`focus` defaults to `concept`, not `project`.** "Defaults to project" is the
single most-repeated drift in this repo: it was once wrong in three skills and a
tool description at the same time, and the hooks framed questions one way while
the server framed them another. Before shipping anything that touches `focus`,
`grep -rin "defaults to project"` and `grep -rniE "focus.{0,12}default"` across
`skills/`, `user-skill/`, `web/` and `mcp/src/`.

**No Eklavya configuration is written into a checkout, and `REPO_FORBIDDEN_KEYS`
is gone with the file that needed it.** Settings were at `<repo>/.eklavya.json`,
committed, so every clone handed Eklavya a config file written by a stranger — a
checked-in `notifications` sink of `/bin/sh` plus the Stop hook's automatic
wrap-up was arbitrary code execution on `git clone`. Four settings were
therefore global-only. Project settings now live at
`~/.eklavya/projects/<slug>/config.json` (`projectConfigPath` in `paths.ts`),
written only by the person at the machine, so nothing arrives by clone for that
path and there is nothing to refuse.

**The list came back, narrowed, and the reason is worth reading before you touch
either function.** Deleting it outright was wrong: `loadConfig` still reads
`<repo>/.eklavya.json` as a fallback until a session moves it, and
`migrateLegacyRepoConfig` then copied that file's keys into the trusted
location. So the removal reinstated the original RCE for the migration window
and made it permanent afterwards. `CLONED_FORBIDDEN` + `withoutUntrustedKeys`
now filter **only** the legacy path — on the fallback read and again on the
lift — while `~/.eklavya/projects/` stays unrestricted. A code review caught
this; the regression tests are in `config-trust.test.ts` under *a legacy file is
still a file from a stranger*.

`test/config-trust.test.ts` still exists and now asserts the replacement
invariant: a file in a checkout configures nothing, a slug collision is detected
via the `project` field rather than silently applied to the wrong repository, and
a leftover `.eklavya.json` is lifted out and deleted.

**`migrateLegacyRepoConfig` is never called from `loadConfig`.** That was the
first shape and it was wrong: `loadConfig` runs from every hook, every tool call
and the statusline on every prompt render, so a write behind it made a read
function mutate the filesystem from a dozen call sites. The test suite caught it
by scattering thirty directories through the *real* `~/.eklavya/projects/`,
because only spawned children had `EKLAVYA_HOME` pointed somewhere safe. It is
called from the SessionStart hook (**before** the `openExisting()` guard — it has
nothing to do with the database, and behind that guard it never ran on a fresh
install), `eklavya doctor`, and `eklavya config`. `loadConfig` reads the legacy
file as a fallback meanwhile, so settings never stop applying in the window
before the move.

**Nothing Eklavya writes lands in a checkout — packs included.** Packs were the
last exception and lost it: `packDirs` now writes to
`~/.eklavya/projects/<slug>/packs/` and keeps `<repo>/.eklavya/packs/` as a
read-only legacy source, ordered *between* global and project so a pack moved
out of a checkout is not outranked by the copy left behind. Nothing deletes an
in-repo pack — unlike a settings file, it is authored content somebody reviewed
— and `eklavya doctor` names any it is still loading from there.

The only path left inside a repository is `.git/hooks/pre-commit`, written by
`scripts/install-git-hook.sh` when the developer runs it. Git has nowhere else
to put a hook, and `.git/` is machine-local and never committed.

Seven namespaces now sit beside the flat dials — `quiz`, `memory`, `privacy`,
`retrieval`, `providers`, `notifications`, `sync` — and they are nested because
every config already written uses the dials flat. `config-path.ts`
derives the settable key list from `DEFAULT_CONFIG` itself, so a nested key
needs no list edit; a *nullable* one does need a line in its `NULLABLE` map,
because `null` is the one default that cannot say what type it is.

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
const capped = config.cadence === 'interleaved' && !config.quiz.enforced && !explicitTopic;
const max = args.max ?? (capped ? 1 : config.max_questions_per_task);
```

`explicitTopic` is `Boolean(args.domain || args.slugs?.length)` and is computed
*before* `learn` focus resolves `focus_topic` into a domain or slugs — so a
`learn` plan is still capped, while a developer who asked for a domain is not.
An explicit `max` bypasses the cap entirely, whatever the cadence.
`quiz.enforced` is exempt for the same reason it ignores the cooldown: the gate needs
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
`LATEST_SCHEMA_VERSION` (currently 14), the file list in the "upgrades an older
install" case, and the table list `EXPECTED_TABLES` is built from — `LEARNING_TABLES`,
`MEMORY_TABLES`, `IMPORT_TABLES` or `SYNC_TABLES` — in `test/migrate.test.ts`.

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
`openDb()`, which is a write on every CLI invocation for anyone with a project pack
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
`upsert_concepts`. There is no repository column, so a project pack's override of a
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
