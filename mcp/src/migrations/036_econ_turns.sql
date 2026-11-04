-- The loop guard (issue #262).
--
-- `econ_turns` is one prompt-turn per session and agent: the counts the guard
-- folds on every tool call (`state`, JSON of numbers, file basenames and
-- command shapes, never output), how many redirects it has sent, and the
-- judge's verdict when one was asked for. A turn opens at UserPromptSubmit and
-- closes at Stop with its outcome: green only when a check ran after the last
-- edit and passed.
--
-- `econ_envelope` keeps the call counts of turns that ended green, per
-- project: how long a turn here usually runs. Only the newest 500 are read.
--
-- `econ_guard_events` records every redirect, notice and judge call, so
-- `eklavya cost` and the dashboard can show them.

CREATE TABLE econ_turns (
  id            INTEGER PRIMARY KEY,
  session_id    TEXT NOT NULL,
  agent_id      TEXT NOT NULL DEFAULT '',
  project       TEXT,
  opened_at     TEXT NOT NULL,
  closed_at     TEXT,
  state         TEXT NOT NULL,
  nudges        INTEGER NOT NULL DEFAULT 0,
  noticed       INTEGER NOT NULL DEFAULT 0,
  -- null: never asked; 'pending': a judge is running; 'done': `verdict` holds it.
  judge_status  TEXT,
  verdict       TEXT,
  outcome       TEXT
);
CREATE INDEX econ_turns_open ON econ_turns (session_id, agent_id, closed_at);

CREATE TABLE econ_envelope (
  id           INTEGER PRIMARY KEY,
  project      TEXT NOT NULL,
  calls        INTEGER NOT NULL,
  snapshot     TEXT,
  recorded_at  TEXT NOT NULL
);
CREATE INDEX econ_envelope_project ON econ_envelope (project, id);

CREATE TABLE econ_guard_events (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL,
  session_id  TEXT,
  project     TEXT,
  turn_id     INTEGER,
  -- redirect | notice | judge | stop
  kind        TEXT NOT NULL,
  reason      TEXT
);
CREATE INDEX econ_guard_events_at ON econ_guard_events (at);
