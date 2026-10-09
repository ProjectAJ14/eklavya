# Conversation eval: baseline vs simplified tutor prompt (issue #155)

Dated historical evidence. It says how two prompt versions behaved on 14 frozen
scenarios on this day, not how the shipped tutor behaves in real sessions.

## Setup

- **Harness:** `eval/conversation-harness.mjs`, scenarios in `eval/fixtures/conversation/scenarios.json` (14), scorer `mcp/src/eval/conversation-score.ts`.
- **Baseline:** the tutor files at `50d047a` (PR #158's head: contracts fixed, prompt not yet simplified).
- **Candidate:** the same files after this PR's simplification, snapshotted before one later edit (below).
- **Model and settings:** the default `claude -p` model and settings on the maintainer's subscription, identical for both sides. The model id was not pinned or recorded, which is a limitation.
- **Trials:** 3 then 5 per scenario per side (8 pooled, 112 calls each). Each trial is one call. No seeds.
- **Fixtures:** the first run's two scenario defects (`defensible-pick` used an option that was not actually defensible; `parallel-miss-handoff` demanded a `record_attempt` call the scripted result had already made) were fixed before the runs reported here. Those first-run numbers (33/42) are not used.
- **Errors:** 0 unparsed or errored replies on every run.

## Result

| | Baseline | Candidate |
|---|---:|---:|
| Clean trials, 3-trial run | 37/42 | 40/42 |
| Clean trials, 5-trial run | 64/70 | 68/70 |
| **Pooled** | **101/112 (90%)** | **108/112 (96%)** |

Scenarios that differed (pooled, clean trials of 8):

| Scenario | Baseline | Candidate | What failed |
|---|---:|---:|---|
| `parallel-miss-handoff` | 3/8 | 8/8 | Baseline often wrote "a page is on its way" with no handoff block, or tried to start an agent it does not have |
| `two-defensible-no-pick` | 5/8 | 8/8 | Baseline graded the learner wrong instead of recording `invalid` |
| `checkpoint-miss-explainer` | 5/8 | 7/8 | Reply longer than four sentences |
| `wrong-checkpoint` | 8/8 | 7/8 | Candidate once omitted the right answer's key term (the rule matches the word "origin", so this is a coarse check) |
| `silence-parallel` | 8/8 | 7/8 | Candidate once asked a question when the learner was silent |
| `blank-checkpoint` | 7/8 | 7/8 | Reply over six sentences, once each |

All other scenarios passed 8/8 on both sides.

## Reading it

- The gain is concentrated in two scenarios, both about contracts this PR series
  changed (the handoff block and `invalid`), and the prompt rewrite put those
  where the model reads them. The candidate also lost one trial on each of two
  other scenarios. With 8 trials per scenario and no seeds, a one-trial
  difference is noise; the handoff and `invalid` gaps (5 and 3 trials) are the
  only differences worth trusting, and even they come from one model.
- Fixture defects were as common as prompt defects on the first run. A failing
  scenario that fails the same on both sides is a reason to read the scenario.
- **Not shown:** that real sessions improved (every scenario is one scripted
  turn and the model is told which situation it is in), that wording quality
  held, or that the rules the scenarios do not cover held. `focus-and-level.md`
  and `writing-mcq.md` were not simplified, so nothing here tests their
  behaviour; the question-quality eval (`harness.mjs`) was not re-run for this
  change.
- A later edit restored one sentence ("A blank is not a skip.") in `grading.md`
  because a test pins that phrase; the measured candidate lacks it.

## Prompt size

| Files (whitespace tokens) | Before | After |
|---|---:|---:|
| `SKILL.md` + `grading.md` + `focus-and-level.md` + `writing-mcq.md` | 7,976 | 7,554 |
| `agents/tutor.md` | 1,172 | 969 |

A 5% cut of the core contract, not the large reduction the issue hoped for; the
saving is in `grading.md` (1,733 to 1,303, now built around one response table)
and the parallel agent.

## What would disprove this

A run on a different or pinned model where the handoff and `invalid` scenarios
fail as often on the candidate as on the baseline, or a real-session transcript
where a checkpoint still asks two questions.
