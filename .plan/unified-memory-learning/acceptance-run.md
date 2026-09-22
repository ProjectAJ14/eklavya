# Acceptance run, 2026-09-22

Driven headless (`claude -p … --plugin-dir`) against the real built hooks, in
scratch git repos with no `.eklavya.json`, with `EKLAVYA_HOME` pointed at a
scratch directory so nothing touched the developer's own `~/.eklavya/`.
Preconditions checked first, as `CONTRIBUTING.md` requires: `mode ambient`,
`focus concept`, `cadence interleaved`, fresh database.

## The memory half: passes, end to end, in a live session

A non-trivial change to a small `cart.js` — tiered volume discounts and tax,
exact in integer cents, with assert-based checks. The model read, wrote and ran;
its own checks passed.

What the hooks recorded, read back out of the scratch database afterwards:

| | |
|---|---|
| Evidence captured | 6 events — 1 prompt, 1 file_read, 2 file_edit, 2 tool_use |
| Batched | 1 batch, `reason: session_seam`, 6 events |
| Summarised | 1 entry, `kind: observation`, `generator: local-v1` |
| Batch provenance | `summarizer: local-v1`, `config_digest: 2e3fd7e89482` |
| Entry → evidence links | 6 of 6 |

Three of those are code written on this branch, running for the first time
outside a test: batch provenance (migration 013), the entry→evidence links (the
native counterpart of the importer fix), and the summary threshold — **no
session summary was written, correctly**, because one observation is below the
two it requires.

## The learning half: unverified, after four attempts, and not re-run to green

`CONTRIBUTING.md`: a checkpoint can only fire if the model called
`log_session_concepts`, and a run where it did not is **inconclusive** — report
it rather than re-running until one comes out green.

| run | what happened |
|---|---|
| 1 | The model called `log_session_concepts` **unprompted**. The harness denied it — `--permission-mode acceptEdits` does not cover MCP tools. My error. Invalid. |
| 2 | Tool allowed. The model did not log. |
| 3 | Three-turn session, tool allowed. Did not log. |
| 4 | Run 1's exact prompt, tool allowed, `AskUserQuestion` allowed. Did not log. |

So the mid-task question is **unverified**. Four sessions, one spontaneous log I
could not reproduce. Stopping there.

### What the diagnostics did establish

Rather than re-rolling, two mechanism tests — independent of what a model
chooses to do:

**The checkpoint fires, correctly, mid-task.** Seeding one `session_concepts`
row and handing the `PostToolUse` hook a normal payload returns exactly the
contract's system message:

```
"systemMessage": "Eklavya: quick question on what you just built"
```

with `additionalContext` instructing one question via `AskUserQuestion`, graded
with `record_attempt`, then *"Resume the task exactly where you left off. Do not
summarise, do not re-plan, do not ask a second question."* The interruption
machinery works.

**The nudge is silent by design in a short session.** `GRACE_MINUTES = 12` in
`prompt-submit-nudge.ts`: the re-injection only fires when a session has logged
nothing *and* has been running long enough that the session-start directive
cannot be blamed on not having had a chance. Every headless run here lasted
seconds. Its silence was correct, and it explains runs 2–4.

So the chain is proven at every link except one: **whether the model chooses to
call `log_session_concepts` during a short session.** Run 1 says it sometimes
does; runs 2–4 say not reliably.

### The finding worth a decision

In three of four short sessions the model never logged, and the nudge that
exists to catch exactly that cannot fire for twelve minutes. A developer whose
sessions are short therefore gets a silent Eklavya — the failure mode the nudge's
own doc comment calls *"the worst-shaped one Eklavya has, because nothing
errors."* The grace window is deliberate and documented, and lowering it is a
product decision about cost and nagging, not a bug to fix unilaterally. Recorded
here so it is decided rather than discovered.

**The nudge fires, and restrains itself.** Seeding a session twenty minutes old
with nothing logged, the same hook that was correctly silent in runs 2-4 now
returns:

```
[Eklavya] Nothing logged this session. Once you know what the current task
involves, call log_session_concepts with the 3-8 concepts it genuinely
exercises, each with a context line naming the real code — without it there is
nothing to quiz on.
```

It then writes `<first>|<nudged>|1`, stays silent on the very next prompt
(cooldown), and goes silent permanently once the session has logged anything.
So the recovery path for the exact failure runs 2-4 exhibited works, and it
does not nag.

That closes every mechanism link:

| link | proven by |
|---|---|
| session-start injects the directive | run 1, where the model acted on it unprompted |
| nothing logged after the grace window → nudge re-injects | direct hook test above |
| nudge respects cooldown, cap, and a session that logged | direct hook test above |
| a logged concept → checkpoint interrupts mid-task | direct hook test, exact contract wording |
| evidence → batch → entry, with provenance and links | the live session above |

What is left is not a mechanism. It is whether a model volunteers the tool call
in a short session, and no harness I can drive settles that.

### Run 5 — resumed after the grace window: the loop runs, end to end

A single `-p` run submits exactly one prompt, at minute zero, so it can never
reach the nudge's twelve-minute grace. A **resumed** session can. Turn 1 did
work and logged nothing; thirteen minutes later the session was resumed with a
second task.

What happened, read out of the database rather than the stream (plugin hooks
other than `SessionStart` do not surface as stream events):

| | |
|---|---|
| Concepts logged | **7**, mid-session, with context lines naming the real code — `lazy-ttl-expiry`, `monotonic-vs-wall-clock`, `amortised-complexity`, … |
| `checkpoints` | `count = 1`, at `07:58:37.847Z` — **the checkpoint fired** |
| `stop_markers` | `block_count = 1`, at `07:58:49.809Z`, `last_logged_count = 7` |
| Task | finished afterwards, in the same turn: *"Task itself is done: per-key TTL in `store.js:19`, lazy expiry on read at `store.js:30`, self-checks pass."* |

So the loop ran: the model logged, the checkpoint interrupted mid-task before
the work was finished, and the work resumed and completed. The one step that did
not happen is the question being **asked**, because `AskUserQuestion` does not
exist in a non-interactive run — there is no one to ask. The model said so and
refused to invent the rest:

> No quiz possible — `AskUserQuestion` isn't available in this session
> (non-interactive), and I won't record an attempt that never happened.
> Concepts are logged, so the question will come up in an interactive session.

Which is the right call, and `attempts` is correctly 0.

One thing this run corrected. The nudge did **not** fire on the resume: `state`
came back stamped `07:57:56`, because `session-start` deletes the row when it
reprints the directive, re-arming the grace window — documented behaviour. The
model logged from the reprinted directive, not from a nudge. So the earlier
reading — that short sessions go silent — is narrower than it looked: a resume
reprints the directive, and here that was enough on its own.

**Status: everything an automated harness can reach is reached.** What remains
is a human seeing the question and answering it, which is not a mechanism and
cannot be simulated. The interactive run below is that, and only that.

### What still needs the interactive run

```bash
cd /some/scratch/repo
claude --plugin-dir /path/to/eklavya
```

Ask for a non-trivial change and watch for the checkpoint. Headless `-p` proved
the memory half and the checkpoint mechanism; it is the worst possible harness
for whether a model volunteers a tool call mid-task.
