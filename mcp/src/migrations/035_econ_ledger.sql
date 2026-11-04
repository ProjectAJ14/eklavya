-- The cost ledger (issue #261).
--
-- `econ_sessions` holds one row per Claude Code session: the token usage read
-- from its transcript by the background fold, priced per model. Numbers and
-- names only: no prompt, no tool argument, no output is ever stored. A row is
-- created `pending` at session start with the transcript's path, and filled
-- in (`folded_at`) once the session ends or its transcript has been quiet for
-- ten minutes. A fold can run again; it replaces the row.
--
-- `econ_overhead` holds what Eklavya itself spent: each `claude -p` call it
-- made (observer, feedback review, loop-guard judge, stale refresh), from the
-- call's JSON envelope, and each Eklavya subagent (the explainer) found in a
-- session's transcript. A subagent's tokens are already in its session's
-- totals; its overhead row labels them, it does not add them again
-- (`in_session` = 1).

CREATE TABLE econ_sessions (
  session_id        TEXT PRIMARY KEY,
  project           TEXT,
  transcript_path   TEXT,
  model             TEXT,
  claude_version    TEXT,
  started_at        TEXT,
  ended_at          TEXT,
  prompts           INTEGER NOT NULL DEFAULT 0,
  requests          INTEGER NOT NULL DEFAULT 0,
  tool_calls        INTEGER NOT NULL DEFAULT 0,
  tool_errors       INTEGER NOT NULL DEFAULT 0,
  input             INTEGER NOT NULL DEFAULT 0,
  cache_read        INTEGER NOT NULL DEFAULT 0,
  cache_write_5m    INTEGER NOT NULL DEFAULT 0,
  cache_write_1h    INTEGER NOT NULL DEFAULT 0,
  output            INTEGER NOT NULL DEFAULT 0,
  effective         INTEGER NOT NULL DEFAULT 0,
  -- The share of `effective` spent on Eklavya: turns that called its tools
  -- (the quiz) and its subagents.
  quiz_effective    INTEGER NOT NULL DEFAULT 0,
  eklavya_effective INTEGER NOT NULL DEFAULT 0,
  -- JSON list of models with usage and no price row.
  unpriced          TEXT,
  -- JSON: the economy and memory settings in force, for the on/off comparison.
  settings          TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  folded_at         TEXT
);
CREATE INDEX econ_sessions_project ON econ_sessions (project, started_at);
CREATE INDEX econ_sessions_pending ON econ_sessions (folded_at) WHERE folded_at IS NULL;

CREATE TABLE econ_overhead (
  id              INTEGER PRIMARY KEY,
  occurred_at     TEXT NOT NULL,
  project         TEXT,
  session_id      TEXT,
  -- observer | feedback | judge | stale_refresh | subagent:<agent type>
  source          TEXT NOT NULL,
  model           TEXT,
  input           INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  cache_write_5m  INTEGER NOT NULL DEFAULT 0,
  cache_write_1h  INTEGER NOT NULL DEFAULT 0,
  output          INTEGER NOT NULL DEFAULT 0,
  effective       INTEGER NOT NULL DEFAULT 0,
  unpriced        INTEGER NOT NULL DEFAULT 0,
  -- What `claude -p` reported it cost, when it did.
  cost_usd        REAL,
  in_session      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX econ_overhead_time ON econ_overhead (occurred_at);
CREATE INDEX econ_overhead_session ON econ_overhead (session_id, source);
