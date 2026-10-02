# Memory use in whole sessions (2026-10-02, issue #83)

Does a saved fact that is in neither the prompt nor the repository change what a
real Claude Code session builds? Does memory that is not about the task leave it
alone? And does the session find and call the memory tools by itself?

Harness: `eval/memory-use-harness.mjs`. Raw per-trial scores:
`2026-10-02-memory-use.json`, where `final`, `baseline` and `guidance-v1` are
the groups below. Version 2 of the guidance was overwritten by the final re-run;
only the aggregates quoted under "Guidance" remain for it.

## Setup

- **Builds.** Final: `97fcc32` on branch `work-on-github-issue-83-receipt-propagat`
  (plugin version string 1.44.1). Baseline: `origin/main` at `5255b7f` (1.44.1).
  Each build was a snapshot, loaded as the only `--plugin-dir`.
- **Host and model.** Claude Code 2.1.287, its default model (`claude-opus-5-5`),
  `--setting-sources project,local`, claude.ai connectors off.
- **Per trial.** A fresh synthetic repository (`eval/fixtures/memory-use/project`)
  and a fresh `EKLAVYA_HOME` whose database was seeded before the session.
  Questions, updates, telemetry and the dashboard were off.
- **Task.** The same prompt in every task arm: add `exportCsv(rows)` with tests,
  "follow this project's conventions for exports", and name the delimiter used.
- **The fact.** CSV exports use `;` because the finance importer rejects commas.
  It appears in no prompt and no file. Success is read from the code:
  `exportCsv([{a:1,b:2}])` is run and its header delimiter recorded, and
  `npm test` is run. It is not read from what the answer says.

| Arm | Memory | What the database holds |
|---|---|---|
| `relevant` | on | The decision, the superseded comma decision it replaced, 12 newer unrelated entries |
| `off` | off | The same as `relevant` |
| `irrelevant` | on | An unrelated decision and the 12 entries |
| `titleonly` | on | The decision, worded vaguely ("Finance team importer quirk") so prompt recall does not match it (cosine 0.340, under the 0.35 gate): the session sees one timeline title |
| `searchonly` | on | The same decision, a month old behind 60 newer entries: it is in neither the session-start block nor prompt recall |
| `discover` | on | As `relevant`; the session is asked to call `memory_search` |

## Results

Trials are valid when the session ended without error and loaded only Eklavya
besides the host's built-ins; every trial was valid. `;` = trials whose code used
the remembered delimiter.

| Build / arm | n | `;` | Tests pass | Any memory call | Decision in a recall block | In full | Stale entry shown | Read linked to a receipt | Recall tokens | Seconds | Input tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|
| final / relevant | 5 | 5 | 5 | 0 | 5 | 5 | 0 | – | 1,341 | 14 | 58,642 |
| final / off | 5 | 0 | 5 | 0 | 0 | 0 | 0 | – | 0 | 16 | 55,614 |
| final / irrelevant | 5 | 0 | 5 | 1 | – | – | – | 0 | 1,172 | 17 | 66,975 |
| final / titleonly | 5 | 5 | 5 | 5 | 5 (title) | 0 | – | 5 | 1,171 | 17 | 81,211 |
| final / searchonly | 5 | 5 | 5 | 5 | 0 | 0 | – | 3 | 2,533 | 24 | 138,795 |
| final / discover | 5 | – | – | 5 | 5 | 5 | 0 | 0 | 1,285 | 7 | 58,478 |
| baseline / relevant | 3 | 3 | 3 | 0 | 3 | 3 | **3** | – | 1,274 | 14 | 58,412 |
| baseline / off | 5 | 0 | 5 | 0 | 0 | 0 | 0 | – | 0 | 21 | 55,740 |
| baseline / irrelevant | 5 | 0 | 5 | 0 | – | – | – | – | 1,077 | 15 | 58,201 |
| baseline / titleonly | 5 | 5 | 5 | 5 | 5 (title) | 0 | – | not logged | 1,078 | 19 | 81,076 |
| baseline / searchonly | 5 | 5 | 5 | 5 | 0 | 0 | – | not logged | 2,440 | 24 | 146,685 |
| baseline / discover | 3 | – | – | 3 | 3 | 3 | **3** | not logged | 1,218 | 7 | 58,346 |

"Recall tokens" estimates every `<eklavya-memory>` block the hooks added
(four characters per token). "Input tokens" includes cache reads. Seconds is the
host's `duration_ms`.

## What this shows

- **The saved fact changed the code.** With the decision in memory, 25 of 25
  final task sessions wrote `;` (relevant, titleonly, searchonly). With memory
  off, 0 of 5 did, and 0 of 5 with only irrelevant memory. Tests passed in every
  task trial. This is correct application of a fact absent from the prompt and
  the repository, not only a citation.
- **Irrelevant memory caused no false claims.** Every irrelevant-arm answer said
  the project sets no delimiter and used the RFC 4180 comma.
- **The tools are discoverable and callable in a fresh session.** All four read
  tools were listed at start in every trial. They arrive deferred: every session
  that called one used ToolSearch first, then called it successfully (8 of 8
  discover trials across both builds).
- **The model fetches when the index points at something relevant.** With only
  a title, 10 of 10 sessions across both builds called `memory_get` and quoted
  the decision, which only its narrative contains. With nothing shown, 10 of 10 searched and then read it. The audit's
  "zero memory calls" observation is therefore not an inability to use the
  tools. In those transcripts the automatic context may have been enough, or the
  listed titles may not have looked relevant. This eval does not establish which.
- **The receipt link works live.** In the final build, 5 of 5 title-only fetches
  were logged with the receipt of the block that listed the title. The baseline
  has no read log and could not link them.
- **Stale memory: the baseline showed the superseded entry.** Its session-start
  timeline listed the replaced comma decision in 6 of 6 trials that seeded it.
  The final build listed it in 0 of 10. The model still chose `;` in every
  baseline trial, because the correction was also present.

## Guidance: what was tried and what shipped

The guidance the issue proposed was measured in three versions:

1. **Long trigger, receipt call and a search fallback** ("Nothing relevant
   here? Search with memory_search for the component, file or decision"), 3
   trials per arm. Every task arm matched the baseline. The irrelevant arm
   searched in 0 of 3 sessions. The blocks cost about 200 more estimated tokens
   than the baseline's.
2. **Shortened, with a blunter fallback** ("None listed: memory_search the
   component, file or decision"), 5 trials per arm. Fetch and search rates
   matched the baseline, which was at ceiling. The irrelevant arm searched in 3
   of 5 sessions with nothing to find, against 0 of 5 on the baseline. That cost
   about 26,000 more input tokens per session with no change to the answer.
3. **Shipped: the short trigger and the receipt-linked `memory_get` call, no
   fallback.** The timeline keeps its existing "look further back with
   memory_search". The irrelevant arm searched in 1 of 5 sessions, about 9,000
   more input tokens on average. Every other arm was unchanged. With 3–5 trials,
   0 of 3 and 1 of 5 cannot be told apart.

So this release's guidance is justified by receipt linkage and by not adding
noise, not by a measured gain in fetch rate. On this task the model already
fetched at ceiling without it.

## Targets for later runs, from this baseline

Re-run this harness when recall, guidance or the memory tools change. A
candidate should keep:

- task success with the fact reachable (`relevant`, `titleonly`, `searchonly`)
  at 100%, and the `off` and `irrelevant` arms at 0% `;`, with no answer citing
  a convention that does not exist;
- stale entries shown at 0;
- memory calls in the `irrelevant` arm no higher than the baseline's 0 of 5,
  allowing one session in five for noise;
- recall tokens within about 300 of the baseline per arm, and median seconds
  within 20%.

## Limits

- **One task, one model, one host version, 3–5 trials per arm.** The fixture is
  small and the fact is a single rule; a decision buried in a large codebase may
  behave differently.
- **Wording was chosen to steer recall.** The `titleonly` and `searchonly`
  wordings were picked so that automatic recall would miss them. This tests the
  fetch path, not how often real entries land in that state.
- **Linked reads are what the model passed, not verified provenance.** In 3 of
  5 `searchonly` trials the `memory_get` named the receipt of a block that did
  not list the entry, because the model found it by search.
- **Prompts mention the project's conventions.** A prompt that does not hint at
  history may fetch less.

What would disprove "memory changes the outcome": `relevant` producing `;` at
the same rate as `off`. What would disprove "irrelevant memory is harmless": the
`irrelevant` arm producing `;`, or answers citing a convention that does not
exist.
