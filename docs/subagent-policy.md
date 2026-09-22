# Who logs, who quizzes, who stays silent

Delegated work is still work, and Eklavya can only teach what got logged. But a
subagent is not a small session: it has its own context, its own toolset and no
developer watching it. Getting this wrong in either direction is a real failure
— a session that delegates its implementation and logs nothing looks exactly
like Eklavya being broken, and a subagent that asks a question burns one from
the budget on a prompt nobody will ever see.

So there are three roles, and each one does exactly one thing.

| Role | Logs | Quizzes | Captured | How it is told |
|---|---|---|---|---|
| The parent thread | yes | yes | tool uses, prompts, lifecycle | `SessionStart` directive, re-stated by `UserPromptSubmit` when a session has logged nothing |
| An implementer subagent | yes | **no** | tool uses only | `SubagentStart` directive (`mcp/src/hooks/subagent-start.ts`) |
| The `eklavya-tutor` subagent | **no** | yes | tool uses only | `agents/tutor.md`, its own brief — no hook speaks to it |

The fourth column is memory's, and it is the one addition the memory half makes
to this policy. It is not a fourth role: nothing about who logs or who quizzes
changed. See [what memory capture does inside a subagent](#what-memory-capture-does-inside-a-subagent).

## None of this reaches Cowork

The table above is true on Claude Code — the CLI and the Code tab in Claude
Desktop, which are the same engine. It is not true in Cowork.

Cowork fires nine hook events: `PreToolUse`, `PostToolUse`, `Stop`,
`SubagentStop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact`
and `Notification`. `SubagentStart` is not among them. So in a Cowork session
the middle row simply does not happen: an implementer subagent is never told to
log, and whatever it exercised is lost. The parent thread still logs and still
quizzes, because `SessionStart` and `Stop` both fire.

There is nothing to do about it from this side — a hook that is never invoked
cannot be worked around — so it is recorded here rather than fixed. Two
consequences worth holding on to:

- A Cowork session that delegates most of its work will have thin sessions. That
  is the known cost, not a bug to chase.
- `subagent-start.ts` still applies the Cowork surface note to its directive.
  Nothing delivers that today; it means the day Cowork does fire the event, the
  wording is already right and no release is needed to catch up.

`SubagentStop` **does** fire in Cowork, and is the obvious place to close this if
it ever becomes worth closing — but it arrives after the subagent is gone, with
no context to log from, so it is not a drop-in replacement.

## The implementer logs, because it is the one that knows

`SessionStart` fires once, in the parent thread. Its standing directive never
reaches a subagent, which opens with a fresh context and whatever agent file
defined it. So the agent that most often knows what the code touched was the one
agent never asked to say so.

`SubagentStart` closes that. Two details are load-bearing:

- **The output form.** `SessionStart` accepts raw stdout as context;
  `SubagentStart` does not. It needs
  `{"hookSpecificOutput":{"hookEventName":"SubagentStart","additionalContext":"..."}}`,
  and text printed the other way is dropped in silence — a hook that appears to
  work and does nothing.
- **No database read.** The directive depends only on `mode`. A delegated task
  can be the first thing in a session to touch Eklavya, and a hook that bailed
  on a missing database would stay quiet on exactly the fresh install that most
  needs it.

The subagent does not have to know which session it belongs to.
`log_session_concepts` resolves the id from the session pointer
`session-start.ts` stamped for the parent — so a subagent's concepts land in the
parent's session, count toward the same mastery history, and spend the same
commit gate. That is why the directive never mentions `session_id`. The pointer
is keyed by git root, and a subagent inherits the parent's cwd, so it resolves to
the parent and not to whatever session is running in another checkout.

## Nothing quizzes inside a subagent

`AskUserQuestion` is not in a subagent's toolset, and the human is not reading
that transcript. A question asked there is spent from
`max_questions_per_task` and never seen.

Two things enforce it, and both have to stay:

- `checkpoint-quiz.ts` returns immediately when `agent_id` is set. That field is
  present only inside a subagent (`docs/verified-schemas.md`), so the PostToolUse
  checkpoint cannot fire on a subagent's own `log_session_concepts` call.
- The `SubagentStart` directive says not to ask, in as many words. Without it a
  model that has read the tutor skill will helpfully do in prose what the guard
  above prevents by mechanism.

`stop-quiz-check.ts` has the same guard, and needs it more, because it keeps the
turn going. `Stop` is believed to be parent-only — `SubagentStop` is a separate
event — but nothing in this repo has verified that, and the cost of being wrong
is an agent with no `AskUserQuestion` told to run a quiz, repeatedly, in a
transcript nobody reads. This hook is what made that reachable: before it a
subagent logged nothing, so the Stop hook's `logged > last_logged` predicate
could never arm. That is history, not a reason the guard could go: under the
`interleaved` cadence the sweep re-arms on a clock rather than on newly logged
work, so the `agent_id` check is now the only thing keeping a subagent out of it.
What the subagent logged is still there for the parent's own Stop sweep, which is
where it belongs.

## What memory capture does inside a subagent

Capture and quizzing take opposite decisions here, and both are right. A
question asked inside a subagent is spent on a transcript nobody reads; a tool
call made inside a subagent is work that happened to the codebase, and losing it
would make delegated work invisible to recall — which is exactly the session a
developer most needs their memory for, because they did not watch it happen.

So `capture-tool` has **no `agent_id` guard**. It runs after every tool call in
every thread, and `identityOf` (`mcp/src/hooks/memory-lib.ts`) carries
`input.agent_id` into the evidence row's `agent_id` column and into the
`event_uid` fingerprint. Three consequences, all deliberate:

- **A subagent's evidence lands in the parent's session and the parent's
  project.** The identity's `sessionId` comes from the same session pointer
  `log_session_concepts` resolves through, so an implementer's edits and the
  parent's edits are one history. `agent_id` says which thread did it without
  splitting the record.
- **`agent_id` is part of the deduplication key**, so the parent and a subagent
  doing the identical thing are two events rather than one. That is the right
  answer for the same reason the `origin` column exists on the learning side:
  two agents doing the same work twice is a fact about the session, not a
  duplicate to collapse. `memory-hardening.test.ts` holds this one down:
  *"records a subagent under its own identity, so delegated work is
  attributable"*.
- **The other three memory-carrying hooks stay parent-only.**
  `prompt-submit-nudge` and `stop-quiz-check` both return on `agent_id` before
  they touch memory at all. A subagent's "prompt" is the parent's instruction to
  it, not the developer saying what they were trying to do, and a seam flush
  from a subagent would close the parent's batch halfway through the parent's
  turn.

## Transcript replay skips sidechains, on purpose

`mcp/src/memory/replay.ts` reads a Claude Code transcript and captures what the
hooks never saw — a session from before the install, a host with a misconfigured
hook, a host with no hooks. It drops every line with `isSidechain` set, which is
how the transcript marks a subagent's own thread.

That is not a gap left by capture. The parent's transcript already records the
delegation and its result, and the subagent's tool uses were captured live by
`capture-tool` if hooks were running. Replaying the sidechain too would record
the same work a second time under a different identity — and it would slip past
deduplication precisely *because* `agent_id` is in the fingerprint, since the
replay path does not reconstruct it. Replay converges with hook capture by
content rather than by identity (`memory-replay.test.ts`, "converges with hook
capture instead of recording the same work twice"), and content convergence
cannot save you from two records of one event that genuinely differ in wording.

The cost, stated: on a host where hooks never ran, a replayed transcript keeps
the parent thread's account of what a subagent did and loses the subagent's own
tool-by-tool detail. That is the same thin-session cost Cowork pays above, and
it is bounded the same way — the delegation and its outcome survive.

## The tutor is told nothing, on purpose

`eklavya-tutor` (`agents/tutor.md`) is deliberately not given
`log_session_concepts` — it teaches what the builder logged rather than logging
work of its own. But that is not why it is exempt: `Explore` and `Plan` do not
have the tool either and are told anyway, and a subagent without a tool simply
does not call it.

The exemption is about the directive's **second** sentence. *Do not ask the
developer anything here* is a direct order not to do the one thing the tutor
exists to do, so delivering it would disable parallel tutoring without an error
anywhere.

The match is a substring, not an equality: an agent is namespaced
`<plugin>:<name>` when it is installed through `/plugin` and bare when it is a
user-level agent, so both spellings have to hit. And an absent or unrecognised
`agent_type` **fails open** — it speaks. A host that does not send the field is
a host where failing closed would turn the whole feature off in silence, which
is the failure this hook was written to end; the cost of the other direction is
one tutor session that logs instead of quizzing, in a subagent the developer
asked for by name and is watching.

This is the mirror of what superpowers does with a `<SUBAGENT-STOP>` block at
the top of its bootstrap: some subagents need the standing instruction and some
need to be exempted from it, and the exemption has to be as deliberate as the
instruction.

Option A in [`parallel-tutoring.md`](parallel-tutoring.md) is this row of the
table in use.
