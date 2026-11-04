-- Memory analytics and stale context (issue #259).
--
-- `memory_entry_use` is what each entry did for the sessions it was sent to,
-- computed by the background fold, never by a hook: how often it was sent,
-- opened (a `memory_get` of it) and applied (the session later read or edited
-- one of its files), a utility score that decays by 0.8 a session and ranks
-- recall, and, when the fold or the model flagged it, why it may be outdated.
--
-- Receipts and the read log keep the informative terms of their query (never
-- the whole prompt), and a read keeps how long after its recall it came.

CREATE TABLE memory_entry_use (
  entry_id      INTEGER PRIMARY KEY REFERENCES memory_entries (id) ON DELETE CASCADE,
  sent          INTEGER NOT NULL DEFAULT 0,
  opened        INTEGER NOT NULL DEFAULT 0,
  applied       INTEGER NOT NULL DEFAULT 0,
  utility       REAL NOT NULL DEFAULT 0,
  stale_reason  TEXT,
  stale_since   TEXT,
  -- fold | model
  stale_by      TEXT,
  refreshed_at  TEXT,
  updated_at    TEXT NOT NULL
);

-- Which sessions the fold already counted, so a second fold adds nothing.
CREATE TABLE memory_use_sessions (
  session_id  TEXT PRIMARY KEY,
  folded_at   TEXT NOT NULL
);

ALTER TABLE context_receipts ADD COLUMN query_terms TEXT;
ALTER TABLE memory_reads ADD COLUMN query_terms TEXT;
ALTER TABLE memory_reads ADD COLUMN seconds_since_recall INTEGER;
