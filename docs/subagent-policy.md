# Subagent policy

Implementers log the concepts they use. The parent asks the learner about that
work. With `delegate_work` on (the default), the parent delegates non-trivial
code changes to background implementers and asks while they build. A tutor
explicitly requested by the learner can teach in its own conversation; an explainer only creates an artifact.

| Role | Logs concepts | Asks questions | Memory capture | Instructions |
|---|---|---|---|---|
| Parent | Yes | Yes | Prompts, tools and lifecycle | SessionStart (directive, plus `DELEGATE` when `delegate_work`), the prompt nudges (logging, and the delegation line next to a task) and the second-file delegation nudge |
| Implementer | Yes, when its tools permit | No | Tools | SubagentStart directive |
| `eklavya-tutor` | No | Yes, when delegated to teach | Tools | `agents/tutor.md` |
| `eklavya-explainer` | No | No | Tools | `agents/explainer.md` |

Sources: [`subagent-start.ts`](../mcp/src/hooks/subagent-start.ts),
[`session-start.ts`](../mcp/src/hooks/session-start.ts),
[`checkpoint-quiz.ts`](../mcp/src/hooks/checkpoint-quiz.ts),
[`delegate-nudge.ts`](../mcp/src/hooks/delegate-nudge.ts),
[`prompt-submit-nudge.ts`](../mcp/src/hooks/prompt-submit-nudge.ts),
[`delegation-lib.ts`](../mcp/src/hooks/delegation-lib.ts),
[`stop-quiz-check.ts`](../mcp/src/hooks/stop-quiz-check.ts) and the agent files.

## The parent delegates and asks

With questions on and `delegate_work` true, the parent hears one contract in
three places, all built from the sentences in
[`delegation-lib.ts`](../mcp/src/hooks/delegation-lib.ts):

- **SessionStart** adds the `DELEGATE` block after the standing directive.
- **UserPromptSubmit** adds one line next to every parent prompt of 25
  characters or more that is not an Eklavya slash command, a subagent's
  hand-back or a background-task notice (the host sends both through the same
  event). This is where a task arrives, before the first edit.
  `/wt implement the 0.2 handoff` counts; "yes, commit it" does not.
- **The second-file nudge** (PostToolUse) repeats it once, the first time the
  parent changes a second distinct file itself.

The contract:

- A code change across several files is built by an agent run in the
  background, with a self-contained brief: the absolute directory to work in
  (the task worktree, if there is one), the goal, the files, the user's
  constraints and the checks to run. Creating or reusing a worktree is setup,
  not delegation: the agent works in it.
- The parent stays the lead. It plans, answers the developer, reviews what comes
  back, runs the checks the user asked for and commits. Its task answer comes
  last.
- A staged plan goes one stage per agent, in order. The parent reviews, checks
  and commits each stage before starting the next, and does not edit an agent's
  files while it runs.
- While an agent builds, the parent asks one question at a time:
  `get_session_quiz_plan` with `while_waiting: true`, `AskUserQuestion`,
  `record_attempt`, verdict, until an agent reports or `questions_needed` is 0.
  Under `cadence: end` all three say questions wait for the end of the task
  instead. `while_waiting` plans one question, skips the cooldown and spends the
  session's `max_questions_per_task`, counted from `attempts` as the hooks count
  it. Under `cadence: end` it returns nothing (`cadence_end`). Passing `max`,
  `domain`, `slugs` or `ignore_cooldown` makes it an ordinary request instead.
- Questions, lookups, docs or design-only work, a fix of a line or two, and
  anything the user said to do inline stay inline. If agents cannot run in the
  background, the parent says so in one line and works inline. The nudge asks for
  that one line whenever the parent stays inline after it.

The contract is advice in the model's context, not enforcement. Nothing blocks an
inline edit, and the [delegation eval](../eval/README.md#the-delegation-eval)
measures how often it is followed.

**What the nudge counts.** An edit tool names its file. After a Bash call, a file
counts when `git status` lists it with an mtime inside that command's own
window: `duration_ms` from the hook input, plus 3 seconds for the hook to start.
If the host sends no duration, the window runs from the session's previous Bash
call. This means:

- the first command in a tree counts, even if it changed two files;
- a file a builder, another chat or an editor changed between the parent's
  commands does not count.

Git is read in up to two trees: the session's own, and the one a leading
`cd <dir> &&` names. When a command has no leading `cd`, the second tree is the
last one such a `cd` named. So after one `cd` into a sibling worktree, `git -C`
and absolute-path commands there count too. A `cd` through a variable is not
followed. A deleted file has no mtime and does not count. Subagent edits neither
trigger the nudge nor count towards it.

**When the nudge stands down.** It stands down for good once the parent starts an
`Agent`/`Task` whose `subagent_type` is not Explore, Plan, `claude-code-guide`,
the tutor or the explainer. That launch is also recorded: whether it ran in the
background, and the fact that the session is now building. That mark is what
`quiz.only_on_changes` reads, so `while_waiting` can ask before the builder's
first edit lands. Without it, the planner answered `no_code_change` the moment
the agent started.

**Recorded state.** The nudge's state is one `meta` row per session id. A resume
or a compaction keeps it, and another chat in the same project has its own. The
row holds:

- the first changed file;
- the tree the last leading `cd` named;
- the time of the previous Bash call;
- whether the nudge fired;
- the delegation, and whether it ran in the background.

It does not record whether the builder finished, or why a parent stayed inline.
The eval reads those from transcripts. It needs questions on and `delegate_work`
true, and stops calling git once it has fired or the parent has delegated.

The parent asks because a delegate cannot: it has no `AskUserQuestion` and
nobody reads its transcript. Background implementers still get the SubagentStart
logging directive. A background agent may stop on a permission prompt and
report back without finishing.

End-of-task questions come from the Stop sweep, after the task answer (one
question under `as-you-go`, the remaining budget under `end`). The sweep itself
is one line the developer also sees; the plan it points to returns `on_finish`,
which asks for "Back to your task:" and a 2-4 line restatement of the answer.
That is what keeps the answer last. The standing directive only says
never to end a turn on a question or a verdict: an earlier line asking the
parent to quiz before its final answer was not followed in live sessions and
was removed. Every plan Eklavya asks for itself is capped at what is left of
the session budget.

## Implementers log; automatic hooks do not quiz them

The parent's SessionStart instructions do not automatically enter a subagent's
context. SubagentStart supplies a short logging directive and says not to ask
the developer questions. It emits `hookSpecificOutput.additionalContext` JSON;
plain stdout is not the contract used here.

The hook checks `quiz.enabled` and session silence, but a missing database does
not suppress its directive. It may open an existing database to check silence;
the old claim that it never reads the database is incorrect.

The logging tool normally resolves the parent's session from the host: a
subagent's tool calls go through the parent's MCP server, which carries the
parent's `CLAUDE_CODE_SESSION_ID` (the checkout's session pointer is the
fallback on hosts without it). Neither directive nor model needs to invent a
session ID. See [parallel tutoring](parallel-tutoring.md) for concurrent sessions.

Checkpoint and Stop hooks return on `agent_id`. Keep both guards: an automatic
question in an unwatched implementation transcript cannot reach the learner.
The subagent's logged concepts remain available to the parent's quiz.

## The tutor is an explicit exception

The tutor reads files, asks text questions and records answers. Its allowlist
excludes concept logging, configuration writes and memory writes. It has no
file-writing tools or `AskUserQuestion`; lettered text is its question interface.

SubagentStart skips any `agent_type` containing `eklavya-tutor`, covering both
bare and plugin-scoped names. The reason is the directive's “do not ask” clause,
which would disable tutoring. Unknown or absent agent types receive the
directive. Automatic checkpoint/Stop guards still apply to the tutor; its own
brief drives the requested teaching.

## The explainer writes a page

With `explain_on_wrong` on (the default), `record_attempt` can return an `explain` block.
The parent records the answer before starting the background explainer, which
creates a page through `eklavya artifacts new`, fills it, opens it and finishes.
The parent does not wait for the page.

The explainer has no Eklavya MCP tools. It still receives the implementer
directive: the unavailable logging instruction is inert, and the instruction
not to ask questions agrees with its brief. Keep artifact guidance aligned with
`user-skill/eklavya-artifacts/`.

## Capture and replay

`capture-tool` intentionally has no `agent_id` exclusion. Delegated tool use is
project evidence, attributed with the agent ID in both the row and its event
fingerprint. Identical actions by parent and delegate remain distinct events.
Prompt capture and Stop seams stay parent-only so a delegate cannot close the
parent's batch midway through a turn.

Transcript replay skips `isSidechain` records. The parent transcript already
contains the delegation and result; live hooks capture detailed subagent tool
use. Replaying sidechains without reconstructing identity could duplicate it.
When hooks did not run, replay retains the parent's account and loses the
delegate's tool-by-tool detail. This is a known limit, not full reconstruction.

## Host limits and maintenance

The integration's recorded Cowork limitation is that SubagentStart is not
delivered. Parent capture and questions can work while delegated concept logging
is thinner. Treat that as the currently supported integration boundary in
`mcp/src/hooks/subagent-start.ts`, not a guarantee about every future host
version. Re-verify with the host when extending support; SubagentStop arrives
after the delegate has finished and is not an equivalent replacement.

Update this policy, the parallel guide, agent tool allowlists and manual host
limitations together when changing delegation. Verify hook JSON and guards with
`mcp/test/hooks.test.ts`; memory attribution and replay behavior are covered by
the memory hardening and replay suites. Record real host observations separately
from unit-test assertions in [verified schemas](verified-schemas.md).
