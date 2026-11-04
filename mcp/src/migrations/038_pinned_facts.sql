-- Pinned facts (issue #264): facts about a project that hold across sessions,
-- shown first in the session-start recall once they have earned it.
--
-- Two sources. Environment facts are learned with no model call from failures
-- that recur (`economy/envfacts.ts`): "bare `pytest` is not installed here;
-- `python -m pytest` works". With `economy.envfacts = observer`, the observer
-- may also propose environment facts, decisions and conventions in free text.
-- Either way a fact is `forming` until three sessions confirm it, then
-- `active`; its score decays by 0.8 a session and a contradiction counts five
-- times, and a fact below zero retires. A retired fact stays as history.
--
-- `pinned_fact_shown` records which facts each session was shown, so a fact's
-- effect on later sessions can be measured.

CREATE TABLE pinned_facts (
  id              INTEGER PRIMARY KEY,
  project         TEXT NOT NULL,
  fact_key        TEXT NOT NULL,
  -- form_repair | env_value | boundary | arg_repair | empty_probe | observer
  family          TEXT NOT NULL,
  -- env | decision | convention
  kind            TEXT NOT NULL,
  text            TEXT NOT NULL,
  params          TEXT,
  source          TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'forming',
  score           REAL NOT NULL DEFAULT 0,
  confirmations   INTEGER NOT NULL DEFAULT 0,
  exercised       INTEGER NOT NULL DEFAULT 0,
  applied         INTEGER NOT NULL DEFAULT 0,
  contradictions  INTEGER NOT NULL DEFAULT 0,
  high            INTEGER NOT NULL DEFAULT 0,
  -- JSON list of the sessions already counted, newest last, so a session counts once.
  sessions        TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  retired_at      TEXT,
  retired_reason  TEXT,
  UNIQUE (project, fact_key)
);
CREATE INDEX pinned_facts_live ON pinned_facts (project, state);

CREATE TABLE pinned_fact_shown (
  session_id  TEXT NOT NULL,
  fact_id     INTEGER NOT NULL REFERENCES pinned_facts (id) ON DELETE CASCADE,
  shown_at    TEXT NOT NULL,
  PRIMARY KEY (session_id, fact_id)
);
