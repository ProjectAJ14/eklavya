-- Interleaved quizzing (phase-8).
--
-- Until now the only trigger was the Stop hook, so every question landed after
-- the work was finished -- four of them, in a row, at the exact moment the
-- developer wanted to be done. That is a tax on shipping, not learning while the
-- agent works. `PostToolUse` fires mid-turn and the model sees its output
-- immediately, so a question can now land at the seam where a concept was
-- logged, while the code that taught it is still on screen.
--
-- This table is the pacing state for that. It is deliberately separate from
-- `stop_markers`: the two guards protect against different failures.
-- `stop_markers` stops an end-of-turn loop; this stops a mid-turn burst -- ten
-- concepts logged in one call must not become ten questions in a row.
--
-- `count` is the session's spend against `max_questions_per_task`, which becomes
-- a SESSION budget rather than an end-of-session batch size. The Stop hook reads
-- attempts, not this column, so a question answered here is one the Stop hook
-- will not ask again.
CREATE TABLE IF NOT EXISTS checkpoints (
  session_id           TEXT PRIMARY KEY,
  last_checkpoint_at   TEXT,
  count                INTEGER NOT NULL DEFAULT 0
);
