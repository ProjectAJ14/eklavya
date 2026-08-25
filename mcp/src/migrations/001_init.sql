-- Eklavya schema v1 (PRD §7).
-- Every statement is IF NOT EXISTS so the runner is safe to re-apply.

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS concepts (
  id          INTEGER PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,        -- 'jwt-structure', 'httponly-cookies'
  name        TEXT NOT NULL,
  domain      TEXT NOT NULL,               -- 'web-auth', 'react', 'node-backend', ...
  description TEXT,
  tier        INTEGER NOT NULL DEFAULT 1,  -- 1 fundamentals … 5 expert
  source      TEXT NOT NULL DEFAULT 'seed' -- 'seed' | 'llm'
);

CREATE TABLE IF NOT EXISTS edges (
  from_concept INTEGER NOT NULL REFERENCES concepts(id),
  to_concept   INTEGER NOT NULL REFERENCES concepts(id),
  relation     TEXT NOT NULL CHECK (relation IN ('prerequisite_of','related_to','part_of')),
  PRIMARY KEY (from_concept, to_concept, relation)
);

CREATE TABLE IF NOT EXISTS mastery (
  concept_id   INTEGER PRIMARY KEY REFERENCES concepts(id),
  score        REAL NOT NULL DEFAULT 0,    -- 0..1
  ease         REAL NOT NULL DEFAULT 2.5,  -- SM-2 ease factor
  interval_d   REAL NOT NULL DEFAULT 0,    -- current review interval, days
  reps         INTEGER NOT NULL DEFAULT 0,
  last_seen    TEXT,                       -- ISO timestamp
  next_review  TEXT                        -- ISO timestamp
);

CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id),
  session_id  TEXT,
  question    TEXT NOT NULL,
  answer      TEXT,
  grade       INTEGER NOT NULL,            -- 0..5 (SM-2 quality)
  difficulty  INTEGER NOT NULL,            -- tier the question was asked at
  feedback    TEXT,                        -- tutor's explanation
  ts          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS session_concepts (
  session_id  TEXT NOT NULL,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id),
  context     TEXT,                        -- e.g. 'set httpOnly on refresh cookie in auth.ts'
  ts          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (session_id, concept_id)
);

CREATE TABLE IF NOT EXISTS gates (
  session_id   TEXT PRIMARY KEY,
  mode         TEXT NOT NULL,              -- 'ambient' | 'enforced'
  required     INTEGER NOT NULL DEFAULT 0,
  answered     INTEGER NOT NULL DEFAULT 0,
  passed       INTEGER NOT NULL DEFAULT 0, -- boolean
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Read paths that must stay fast: the SessionStart hook and the PreToolUse gate
-- both run on the critical path of a user action (PRD §9).
CREATE INDEX IF NOT EXISTS idx_concepts_domain       ON concepts(domain);
CREATE INDEX IF NOT EXISTS idx_session_concepts_sid  ON session_concepts(session_id);
CREATE INDEX IF NOT EXISTS idx_attempts_concept_ts   ON attempts(concept_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_session      ON attempts(session_id);
CREATE INDEX IF NOT EXISTS idx_mastery_next_review   ON mastery(next_review);
