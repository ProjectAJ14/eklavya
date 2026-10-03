-- Corrections: answering a missed question again after reading its explainer.
--
-- An explainer page teaches the answer to a question the learner missed, and
-- until now the record still said "missed" forever after. A correction lets
-- them pick again from the dashboard. Grading that pick needs the right answer,
-- which `record_attempt` never kept: the tutor knew it and handed it to the
-- explainer from its own context. So the answer key is stored at record time.
--
-- `correct` is the right option's label exactly as offered. NULL means it was
-- not recorded -- every row before 019, free-recall rows, and a label the tutor
-- passed that was not one of the options. A NULL row cannot be corrected:
-- inventing a right answer nobody recorded would be guessing.
ALTER TABLE attempts ADD COLUMN correct TEXT;

-- JSON array parallel to `options`: the one-clause description shown under each
-- option in the in-session question. NULL when not recorded or when its length
-- did not match `options`.
ALTER TABLE attempts ADD COLUMN option_notes TEXT;

-- Set only on a correction row: the id of the missed attempt it corrects. A
-- correction is a pass that moves mastery, but it was picked straight after
-- reading the answer -- recognition, not recall -- so the gate, level progress
-- and the review backlog all skip rows where this is set.
ALTER TABLE attempts ADD COLUMN retry_of INTEGER REFERENCES attempts(id);

-- Every pick on the correction modal, right or wrong, in order. The try number
-- is the row's position for its `attempt_id`. Wrong picks are logged and never
-- graded: the miss already cost the grade, and charging each click would
-- punish reading the page.
CREATE TABLE IF NOT EXISTS attempt_retries (
  id         INTEGER PRIMARY KEY,
  attempt_id INTEGER NOT NULL REFERENCES attempts(id),  -- the original missed attempt
  picked     TEXT NOT NULL,
  correct    INTEGER NOT NULL CHECK (correct IN (0,1)),
  ts         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attempt_retries_attempt ON attempt_retries(attempt_id, id);

-- One correction per missed attempt, enforced where a double click or two open
-- tabs cannot get around it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_retry_of ON attempts(retry_of) WHERE retry_of IS NOT NULL;
