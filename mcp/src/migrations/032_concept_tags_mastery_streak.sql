-- Concept tags, and the evidence a mastery claim needs beyond a count.
--
-- Tags. A concept is an entity: a short name, a description that deepens, and
-- tags. `domain` stays (seeds, packs and the dashboard filter by it) and is
-- the first tag of a new concept; tags are the open vocabulary beside it, kept
-- as a JSON array of short lowercase strings and shown to the model next to
-- the concepts it might duplicate.
ALTER TABLE concepts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';

-- Mastery used to be `score >= 0.7 AND reps >= 2`: two multiple-choice answers
-- in one sitting made a concept "mastered". Two more facts decide it now, both
-- scoped to the current streak (a failed answer resets reps, and these with it):
--   passed_days      distinct calendar days (UTC) the streak's passes fell on
--   top_passed_tier  the highest question tier among the streak's passes
-- Existing rows are backfilled from their attempts, over all passes rather
-- than the current streak, which is the most they could honestly claim.
ALTER TABLE mastery ADD COLUMN passed_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mastery ADD COLUMN top_passed_tier INTEGER NOT NULL DEFAULT 0;

UPDATE mastery SET
  passed_days = COALESCE((SELECT COUNT(DISTINCT substr(ts, 1, 10)) FROM attempts a
                           WHERE a.concept_id = mastery.concept_id AND a.grade >= 3), 0),
  top_passed_tier = COALESCE((SELECT MAX(difficulty) FROM attempts a
                               WHERE a.concept_id = mastery.concept_id AND a.grade >= 3 AND a.retry_of IS NULL), 0);
