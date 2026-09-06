# Who logs, who quizzes, who stays silent

Delegated work is still work, and Eklavya can only teach what got logged. But a
subagent is not a small session: it has its own context, its own toolset and no
developer watching it. Getting this wrong in either direction is a real failure
— a session that delegates its implementation and logs nothing looks exactly
like Eklavya being broken, and a subagent that asks a question burns one from
the budget on a prompt nobody will ever see.

So there are three roles, and each one does exactly one thing.

| Role | Logs | Quizzes | How it is told |
|---|---|---|---|
| The parent thread | yes | yes | `SessionStart` directive, re-stated by `UserPromptSubmit` when a session has logged nothing |
| An implementer subagent | yes | **no** | `SubagentStart` directive (`mcp/src/hooks/subagent-start.ts`) |
| The `eklavya-tutor` subagent | **no** | yes | `agents/tutor.md`, its own brief — no hook speaks to it |

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
`log_session_concepts` resolves the id from `meta.current_session`, which
`session-start.ts` stamped for the parent — so a subagent's concepts land in the
parent's session, count toward the same mastery history, and spend the same
commit gate. That is why the directive never mentions `session_id`.

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

`stop-quiz-check.ts` has the same guard, and needs it more, because it blocks
with exit 2. `Stop` is believed to be parent-only — `SubagentStop` is a separate
event — but nothing in this repo has verified that, and the cost of being wrong
is an agent with no `AskUserQuestion` told to run a quiz, repeatedly, in a
transcript nobody reads. This hook is what made that reachable: before it a
subagent logged nothing, so the Stop hook's `logged > last_logged` predicate
could never arm. What the subagent logged is still there for the parent's own
Stop sweep, which is where it belongs.

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
