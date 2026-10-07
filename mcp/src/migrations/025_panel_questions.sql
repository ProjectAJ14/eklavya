-- Pending questions for the quiz side panel.
--
-- With the panel the model no longer asks and grades in one blocked turn: it
-- hands the question to `present_question` and goes back to work, and a Claude
-- Code mod (which has no database and loses its state on reload) shows it. So
-- the question, its answer key and the once-only guard need a transactional
-- home next to `attempts`.
--
-- `key` is the model's grading of each option ({correct_id, grades}). It is
-- never sent to the mod: the server grades from it.
--
-- `attempt_id` is set in the same transaction as the attempt row, and `result`
-- is the exact reply the pane was given, so a retried answer returns it
-- verbatim and writes nothing.
--
-- `phase`: pending (waiting), unplaced (the host could not seat the pane),
-- grading (reserved for a typed answer graded later), answered, skipped,
-- expired (24 hours unanswered; an unanswered question is not a decline).
CREATE TABLE IF NOT EXISTS panel_questions (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  repo        TEXT NOT NULL,
  concept_id  INTEGER NOT NULL REFERENCES concepts(id),
  tier        INTEGER NOT NULL,
  stem        TEXT NOT NULL,
  options     TEXT NOT NULL,
  key         TEXT NOT NULL,
  explanation TEXT NOT NULL,
  -- 1 when the model has more questions queued in this round (an explicit
  -- /eklavya:quiz): the pane offers "Next question" only then.
  more        INTEGER NOT NULL DEFAULT 0,
  phase       TEXT NOT NULL DEFAULT 'pending'
              CHECK (phase IN ('pending','unplaced','grading','answered','skipped','expired')),
  attempt_id  INTEGER REFERENCES attempts(id),
  result      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- At most one open question per session, enforced where two callers cannot
-- get around it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_panel_questions_open
  ON panel_questions(session_id) WHERE phase IN ('pending','unplaced','grading');
