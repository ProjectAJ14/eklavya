-- One row each time the live option-length check acts on a question.
--
-- `sent_back` is the first, lopsided version being returned for a rewrite;
-- `rewritten` and `unchanged` say whether the second version still tripped the
-- check (it is shown either way). A question that passed first time is not
-- recorded: its presence is already an `attempts` or `panel_questions` row.
-- No option text is stored. Nothing that scores, levels, schedules or gates
-- reads this table; only `eklavya eval history` does.
CREATE TABLE IF NOT EXISTS option_checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  slug       TEXT,
  surface    TEXT NOT NULL CHECK (surface IN ('panel','card')),
  outcome    TEXT NOT NULL CHECK (outcome IN ('sent_back','rewritten','unchanged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS option_checks_created ON option_checks(created_at);
