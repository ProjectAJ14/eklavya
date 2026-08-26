-- Grade 0 was carrying two opposite meanings: "I don't know, teach me" and
-- "not now, leave me alone". The tutor skill collapsed them into one row of its
-- grading table, so a learner asking to be taught was dropped exactly like one
-- asking to be left alone (observed: four blanks in one session, nothing
-- taught). SM-2 wants both at 0 -- neither is a recall success -- so the
-- distinction cannot live in `grade`.
--
-- It has to be recorded rather than inferred, because the useful question comes
-- a day later: "did I already teach this, or has it never been explained?"
-- `feedback` text cannot answer that reliably.
--
-- NULL means "recorded before this column existed"; readers must treat it as
-- unknown, not as any particular outcome.
ALTER TABLE attempts ADD COLUMN outcome TEXT
  CHECK (outcome IN ('answered','dont_know','declined'));
