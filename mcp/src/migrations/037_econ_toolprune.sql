-- Tool pruning (issue #263).
--
-- `econ_tool_use` is the evidence, per project and tool: how many prompts and
-- sessions have passed since a session that loaded the tool last used it.
-- Updated once per session by the background fold (`econ_sessions.evidence`
-- marks the sessions already counted, so a fold that runs again adds nothing).
--
-- `econ_settings_writes` is what `eklavya toolprune apply` did to a checkout's
-- `.claude/settings.local.json`: the file's original bytes and the deny
-- entries Eklavya added, so `restore` removes exactly those.
--
-- `econ_toolprune_kept` is the tools a developer restored: never proposed again.

CREATE TABLE econ_tool_use (
  project         TEXT NOT NULL,
  tool            TEXT NOT NULL,
  deferred        INTEGER NOT NULL DEFAULT 0,
  first_seen_at   TEXT NOT NULL,
  last_used_at    TEXT,
  prompts_since   INTEGER NOT NULL DEFAULT 0,
  sessions_since  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, tool)
);

CREATE TABLE econ_settings_writes (
  project     TEXT PRIMARY KEY,
  record      TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE econ_toolprune_kept (
  project  TEXT NOT NULL,
  tool     TEXT NOT NULL,
  kept_at  TEXT NOT NULL,
  PRIMARY KEY (project, tool)
);

ALTER TABLE econ_sessions ADD COLUMN evidence INTEGER NOT NULL DEFAULT 0;
