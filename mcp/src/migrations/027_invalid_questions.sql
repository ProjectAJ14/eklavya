-- Questions the tutor got wrong, kept apart from `attempts` on purpose.
--
-- A question that lacked the context to be answered, or had two defensible
-- keys, is the tutor's failure. Recording it as an attempt -- as a blank, which
-- is what the tutor was told to do -- grades the learner 0 and pins mastery at
-- the floor for something they could not have answered. Nothing that scores,
-- levels, schedules or gates reads this table, so an invalid question cannot
-- move any of them. It is read only by the repeat check, so the same broken
-- question is not asked again.
CREATE TABLE IF NOT EXISTS invalid_questions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  concept_id INTEGER NOT NULL REFERENCES concepts(id),
  session_id TEXT NOT NULL,
  question   TEXT NOT NULL,
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS invalid_questions_concept ON invalid_questions(concept_id, id DESC);
