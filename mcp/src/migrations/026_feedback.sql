-- Prompt feedback: one review of one of the developer's own prompts at a time.
--
-- `feedback_items` has no foreign key to attempts, mastery or concepts on
-- purpose: feedback cannot join the grading tables, so it cannot change them.
-- `prompt` is the developer's own words as the capture path already redacted
-- them; `event_id` is the evidence row it came from and is null once retention
-- prunes that row. `review`, `tips` are JSON. `rubric` is the version of the
-- 4D wording the review was written against, so old items stay readable.
-- `model` is the observer model's name and nothing else.
-- `acknowledged_at` is set only by the developer pressing Acknowledge; null
-- means pending.
CREATE TABLE IF NOT EXISTS feedback_items (
  id              INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL,
  project         TEXT NOT NULL,
  event_id        INTEGER,
  prompt          TEXT NOT NULL,
  review          TEXT NOT NULL,
  better          TEXT NOT NULL,
  tips            TEXT NOT NULL,
  rubric          INTEGER NOT NULL,
  model           TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at TEXT
);

-- One pending item at a time, enforced by the database and not only by the code.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_one_pending
  ON feedback_items((1)) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_session ON feedback_items(session_id);

-- Sessions already looked at, including those with nothing worth reviewing, so a
-- quiet session is not scanned again at every start.
CREATE TABLE IF NOT EXISTS feedback_reviewed (
  session_id  TEXT PRIMARY KEY,
  outcome     TEXT NOT NULL,
  reviewed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
