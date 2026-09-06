# Learning *while* the agent works

The post-task quiz (Phase 2) is the reliable version of Eklavya's idea. This document covers the ambitious version: tutoring that runs **during** generation, while the code is still being written.

There are two ways to get it. Neither requires code changes — that was a design constraint on the MCP server from the start (PRD §5.4).

---

## Option A — the tutor subagent

`agents/tutor.md` defines an `eklavya-tutor` subagent with read-only file access (`Read`, `Grep`, `Glob`) and six of the nine Eklavya MCP tools: `get_learner_profile`, `get_session_quiz_plan`, `record_attempt`, `get_concept_graph`, `upsert_concepts`, `get_gate_status`. Not `log_session_concepts`, and not `get_config`/`set_config` — the tutor teaches what the builder logged; it does not log work of its own or change the dials. Each name is listed twice, plugin-scoped and bare, so one set resolves whichever way the server was registered. Ask for it by name:

> Implement the refresh-token rotation in `auth.ts`. While you do, have the eklavya-tutor agent quiz me on what it involves.

The subagent reads the files being written and teaches from them, sharing the same knowledge database and the same session, so anything it records counts toward the same mastery history and the same commit gate.

**What it cannot do:** it has no file-writing tools, on purpose. Tutoring must never race the implementation for the same file. It does still write to the knowledge database — that is what `record_attempt` and `upsert_concepts` are for.

The tutor is also the one subagent `SubagentStart` deliberately says nothing to — it has no `log_session_concepts` and nothing to log. [`subagent-policy.md`](subagent-policy.md) is the whole policy: who logs, who quizzes, who stays silent.

**The honest limitation:** the main thread and the subagent take turns rather than genuinely interleaving. It feels closer to "explain what you just did, in stages" than to a second person talking while the first types.

---

## Option B — two panes, one database

The version that actually feels like the pitch. Run two Claude Code sessions side by side: one building, one teaching.

```bash
# One shared id, so both panes agree on which session this work belongs to.
export EKLAVYA_SESSION_ID="$(basename "$PWD")-$(date +%s)"

tmux new-session -d -s eklavya -n work "EKLAVYA_SESSION_ID=$EKLAVYA_SESSION_ID claude"
tmux split-window    -t eklavya        "EKLAVYA_SESSION_ID=$EKLAVYA_SESSION_ID claude"
tmux attach -t eklavya
```

Left pane: give it the task. It implements, and logs concepts as it goes.
Right pane: `/eklavya:learn <topic>` or `/eklavya:quiz`. It teaches from what the left pane just logged, in real time.

### Why the environment variable matters

Claude Code gives every session its own id, and the hooks use the one they are handed on stdin — so without the override the two panes' hooks are two unrelated sessions, and answering questions in the right pane would not satisfy the gate holding the left pane's commit.

The MCP tools are messier still. A tool call that carries no `session_id` falls back to `meta.current_session`, a single row that the SessionStart hook stamps with the *starting* pane's id — so the second pane to start overwrites it, and both panes' tools then disagree with both panes' hooks about which session the work belongs to.

`EKLAVYA_SESSION_ID` overrides session resolution in both the MCP server (`resolveSessionId`, `mcp/src/session.ts`) and the hooks (`sessionId`, `mcp/src/hooks/lib.ts`), ahead of the harness id and ahead of that `meta` row, so both panes write to one session. In normal single-pane use it is unset and the harness's own session id is authoritative. The one asymmetry: in the server an explicit `session_id` argument still beats the variable; in the hooks nothing does.

### What is shared, and what is not

| | Shared across panes |
|---|---|
| Concept graph, mastery, review schedule | Always — these are keyed by concept, not by session |
| Session concepts and the commit gate | Only when `EKLAVYA_SESSION_ID` is set to the same value |
| The conversation itself | Never — the panes cannot see each other's messages |

The teaching pane learns what is being built by reading the database and the files, not by watching the other conversation. Tell it what you are working on if it seems lost.

### Practical notes

- **The Stop hook fires in both panes.** With a shared `EKLAVYA_SESSION_ID` it reads the same session in both, so either pane can be the one told to run the quiz — the teaching pane is not silent just because nothing was logged *there*. The loop guard is shared for the same reason: `stop_markers` is keyed by session, and a block only re-arms when the count of logged concepts grows, so the two panes cannot both block on the same batch of work. If it is noisy, raise `min_minutes_between_quizzes` (ambient mode only — enforced ignores the cooldown so the gate stays passable) or lower `max_stop_blocks_per_session`. Both panes read the same repo config, so there is no per-pane setting — and `quiet` is not the lever here: it suppresses the session-start banner and the settings line above a question, not the Stop quiz.
- **The commit gate is satisfied from either pane.** Answering in the teaching pane unblocks the commit in the building pane, which is the whole point.
- **Concurrent writes are safe.** WAL mode, short transactions, and a retry on lock contention (`mcp/src/concurrency.ts`, five attempts on `SQLITE_BUSY`); tested with three processes writing simultaneously, and separately with a reader held open while writers work — the git hook must never stall.
- **Any multiplexer works.** tmux is the example; screen, iTerm splits, or two terminal windows behave identically. Nothing here is tmux-specific.
