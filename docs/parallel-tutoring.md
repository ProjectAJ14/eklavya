# Learning *while* the agent works

The post-task quiz (Phase 2) is the reliable version of Eklavya's idea. This document covers the ambitious version: tutoring that runs **during** generation, while the code is still being written.

There are two ways to get it. Neither requires code changes — that was a design constraint on the MCP server from the start (PRD §5.4).

---

## Option A — the tutor subagent

`agents/tutor.md` defines an `eklavya-tutor` subagent with read-only file access and the Eklavya MCP tools. Ask for it by name:

> Implement the refresh-token rotation in `auth.ts`. While you do, have the eklavya-tutor agent quiz me on what it involves.

The subagent reads the files being written and teaches from them, sharing the same knowledge database and the same session, so anything it records counts toward the same mastery history and the same commit gate.

**What it cannot do:** it has no write tools, on purpose. Tutoring must never race the implementation for the same file.

**The honest limitation:** the main thread and the subagent take turns rather than genuinely interleaving. It feels closer to "explain what you just did, in stages" than to a second person talking while the first types.

---

## Option B — two panes, one database

The version that actually feels like the pitch. Run two Claude Code sessions side by side: one building, one teaching.

```bash
# One shared id, so both panes agree on which session this work belongs to.
export EKLAVYA_SESSION_ID="$(basename "$PWD")-$(date +%s)"

tmux new-session  -s eklavya -n work   "EKLAVYA_SESSION_ID=$EKLAVYA_SESSION_ID claude"
tmux split-window -t eklavya           "EKLAVYA_SESSION_ID=$EKLAVYA_SESSION_ID claude"
tmux attach -t eklavya
```

Left pane: give it the task. It implements, and logs concepts as it goes.
Right pane: `/eklavya:learn <topic>` or `/eklavya:quiz`. It teaches from what the left pane just logged, in real time.

### Why the environment variable matters

Claude Code gives every session its own id, so without it the two panes would be two unrelated sessions: the teaching pane would see none of the building pane's work, and answering questions in the right pane would not satisfy the gate holding the left pane's commit.

`EKLAVYA_SESSION_ID` overrides session resolution in both the MCP server and the hooks, so both panes write to one session. In normal single-pane use it is unset and the harness's own session id is authoritative.

### What is shared, and what is not

| | Shared across panes |
|---|---|
| Concept graph, mastery, review schedule | Always — these are keyed by concept, not by session |
| Session concepts and the commit gate | Only when `EKLAVYA_SESSION_ID` is set to the same value |
| The conversation itself | Never — the panes cannot see each other's messages |

The teaching pane learns what is being built by reading the database and the files, not by watching the other conversation. Tell it what you are working on if it seems lost.

### Practical notes

- **The Stop hook fires in both panes.** In the teaching pane it usually has nothing to say, because nothing was logged there. If it becomes noisy, set `"quiet": true` or a longer `min_minutes_between_quizzes` for that session.
- **The commit gate is satisfied from either pane.** Answering in the teaching pane unblocks the commit in the building pane, which is the whole point.
- **Concurrent writes are safe.** WAL mode, short transactions, and a retry on lock contention (`src/concurrency.ts`); tested with three processes writing simultaneously plus a reader running throughout.
- **Any multiplexer works.** tmux is the example; screen, iTerm splits, or two terminal windows behave identically. Nothing here is tmux-specific.
