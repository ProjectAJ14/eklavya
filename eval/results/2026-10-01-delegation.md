# Delegation: does a session hand its building to a background agent?

**2026-10-01** · Claude Code 2.1.286 · Opus 5.5 (the host default) at medium effort ·
`eval/delegation-harness.mjs` from this branch · **4 trials per scenario per arm**,
28 sessions per arm, three arms. All 84 counted sessions were valid: the stream
lists exactly one non-builtin plugin (the build under test), the session finished
inside the 45-minute timeout, and no result reported an error.

## Why this run exists

In issue #78, the second-file delegation nudge fired in 10 live sessions. It was
followed in 2 of them, and in none of the staged-handoff sessions. This run
measures the same choice in isolation: one plugin, a fresh Eklavya home per trial,
and a session that starts in the main checkout of a repository with a sibling
worktree.

## Arms

| Arm | Code |
|---|---|
| Baseline | `main` at `90c8323` (1.43.2) |
| Candidate | An earlier state of this branch. It differs from the final code only in `prompt-submit-nudge.ts`: the prompt line needed 100 characters rather than 25, and was also added to the host's own subagent hand-backs and task notices |
| Final | `0eff0e6`, the code in the PR |

An earlier attempt at the final arm was excluded. The account's spend limit ended
24 of its 28 sessions within about three seconds and cut the other 4 short. Since
then the harness marks a session that ended in an error result as invalid. The
final arm above is a complete rerun.

## Result

Raw counts are trials out of 4, baseline → candidate → final.

| Scenario | Expected | Background builder | One stage per builder, parent commits between | Asked while building (recorded, verdict) | Stage commits in order and checks pass |
|---|---|---|---|---|---|
| `staged` | builder | 0 → 4 → **4** | 0 → 4 → **4** | 0 → 4 → **4** (0→4→4, 0→4→4) | 4 → 4 → 4 |
| `worktree-flow` | builder | 4 → 4 → **4** | 0 → 4 → **4** | 2 → 4 → **4** (2→4→4, 2→4→4) | 4 → 4 → 4 |
| `open` | builder | 2 → 4 → **4** | n/a | 1 → 4 → **4** (1→4→4, 1→3→4) | n/a |
| `nobg` | inline, said why | 0 → 0 → 0 | n/a | n/a | 4 → 4 → 4 |
| `inline` | no builder | 0 → 0 → 0 | n/a | n/a | 4 → 4 → 4 |
| `docs` | no builder | 0 → 0 → 0 | n/a | n/a | n/a |
| `tiny` | no builder | 0 → 0 → 0 | n/a | n/a | n/a |

In two final `worktree-flow` trials the model left out `run_in_background`, and
the host ran the agents in the background anyway: the launch result reads "Async
agent launched". The scorer first counted those as foreground. It now reads the
launch result too, and so does the nudge's record of the launch. The baseline and
candidate counts did not change on rescoring.

More counts, baseline → candidate → final:

- **Brief names the worktree's absolute path and both checks:** in every trial
  with a builder: 6/6, 12/12 and 12/12.
- **Parent writes before the first builder:** 0 in every candidate and final
  trial with a builder. One baseline `open` trial made 1.
- **Who committed** (`worktree-flow`): the builder in 4/4 baseline trials, the
  parent in 4/4 candidate and 4/4 final trials.
- **Fallback said out loud** (`nobg`): 1/4 → 4/4 → 4/4. A typical line: "Agents
  can't run in the background in this setup, so I'm doing this inline."
- **`no_code_change` right after a builder started** (`worktree-flow`): 3/4 → 0/4 → 0/4.
- **Nudge fired:**
  - In `staged`, 4/4 → 0/4 → 0/4: the builder starts before any second file
    changes, and the nudge then stands down.
  - In `docs`, `tiny` and `inline`, it still fires (12/12, 11/12, 11/12). In
    every one the model correctly stayed inline.
- **Main checkout left with changes:** 0 in all 84 sessions.
- **Session length** (`staged`): about 4 to 7 minutes → 7 to 9 → 8 to 10. Four
  builders and four question rounds take longer than one inline pass.

## What the baseline showed

- **The nudge is ignored silently on a staged plan.** In `staged`, the nudge
  arrived during stage 1 in all four trials. Each session went on to build all
  four stages inline, without mentioning it. This matches the live sessions in
  the issue.
- **Contamination is not needed to reproduce it.** No other plugin or user
  setting was loaded, so hypothesis 5 in the issue is not required to explain
  the failure.
- **A session that makes its own worktree already delegates.** In
  `worktree-flow` it did so 4/4. But it handed all four stages to one agent, and
  the agent committed. Nobody reviewed or checked between stages.
- **Questions could not start while a builder ran.** In three of the four
  baseline `worktree-flow` trials, the parent called `get_session_quiz_plan` with
  `while_waiting: true` right after starting the builder and got
  `no_code_change`. The parent had changed nothing, and the builder had not
  written yet. Two of those sessions then asked nothing while the builder ran.
  The branch marks the session as building when a building agent starts, and no
  candidate or final trial got `no_code_change`.
- **The escape clause was stretched and stated.** In a pilot run on a smaller
  fixture, a staged session said "What's left is a few lines, so I'll finish it
  here myself". It then wrote a parser, a formatter and a README section. The
  fixture was enlarged afterwards, and that pilot is not counted.

## What changed from the baseline

- **Shared wording.** One contract is said in three places, built from
  `mcp/src/hooks/delegation-lib.ts`: session start, next to each task-sized
  prompt, and the second-file nudge. It names:
  - the task worktree as the agent's directory;
  - a staged plan as one stage per agent, in order, with review, checks and a
    commit before the next;
  - the inline cases, plus a one-line reason when staying inline.
- **Prompt-time line.** The line next to the prompt is the new seam. It is the
  only one that arrives before the first edit.
- **The nudge.** It reads Bash edits inside the command's own time window
  (`duration_ms`). It stands down once a building agent starts, and that launch
  counts as the session changing code.

## Caveats

- **Trial count.** Four trials per arm per scenario. The `staged` change (0/4 to
  4/4, twice) and the one-stage-at-a-time change in `worktree-flow` (0/4 to 4/4,
  twice) are large. `open` (2/4 to 4/4) is within what four trials can produce by
  chance on its own.
- **Fixture size.** The fixture is a small Node CLI. A four-stage plan here takes
  minutes, so the model's view that it is "small enough to do inline" is not
  always wrong. The live sessions in the issue were larger.
- **Answers.** The harness answers every question with its first option, so
  grading and the verdict are exercised but the learner is not realistic.
  Verdicts are counted by a word heuristic.
- **Inherited environment.** The harness ran from inside a Claude Code session,
  so every session inherited `CLAUDE_EFFORT=medium` and
  `CLAUDE_CODE_CHILD_SESSION=1`. The first matches the host default on this
  machine. The second turns off transcript saving. Both arms ran the same way.
- **What a hook cannot see.** Whether a builder finished, failed or stopped on a
  permission prompt is read from the stream here. The hooks only record the
  launch.
- **Model and date.** One model on one day. A model update can move every number.

## What would make this wrong

- A larger fixture where the candidate starts builders for `docs`, `tiny` or
  `inline`.
- Live sessions after release where the staged-plan follow-through stays near the
  2 of 10 in the issue.
