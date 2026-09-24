# Subagent policy

Implementers log the concepts they use. The parent asks the learner about that
work. A tutor explicitly requested by the learner can teach in its own
conversation; an explainer only creates an artifact.

| Role | Logs concepts | Asks questions | Memory capture | Instructions |
|---|---|---|---|---|
| Parent | Yes | Yes | Prompts, tools and lifecycle | SessionStart and prompt nudge |
| Implementer | Yes, when its tools permit | No | Tools | SubagentStart directive |
| `eklavya-tutor` | No | Yes, when delegated to teach | Tools | `agents/tutor.md` |
| `eklavya-explainer` | No | No | Tools | `agents/explainer.md` |

Sources: [`subagent-start.ts`](../mcp/src/hooks/subagent-start.ts),
[`checkpoint-quiz.ts`](../mcp/src/hooks/checkpoint-quiz.ts),
[`stop-quiz-check.ts`](../mcp/src/hooks/stop-quiz-check.ts) and the agent files.

## Implementers log; automatic hooks do not quiz them

The parent's SessionStart instructions do not automatically enter a subagent's
context. SubagentStart supplies a short logging directive and says not to ask
the developer questions. It emits `hookSpecificOutput.additionalContext` JSON;
plain stdout is not the contract used here.

The hook checks `quiz.enabled` and session silence, but a missing database does
not suppress its directive. It may open an existing database to check silence;
the old claim that it never reads the database is incorrect.

The logging tool normally resolves the parent's session through the inherited
checkout's session pointer. Neither directive nor model needs to invent a
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

With `explain_on_wrong` enabled, `record_attempt` can return an `explain` block.
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
