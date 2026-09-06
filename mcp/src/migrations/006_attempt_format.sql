-- A blank prompt is a bad interface for a quiz you did not ask for. Mid-task,
-- the honest answer to "walk me through what the browser does with this" is
-- often nothing at all -- not because the learner does not know, but because
-- typing a paragraph costs more than the question is worth right then.
-- Recognition is cheap to answer and still teaches, so the default question
-- shape becomes multiple choice.
--
-- Two columns, because the two facts are needed for different reasons:
--
-- `format` is what makes the grade readable later. A correct multiple-choice
-- answer is weaker evidence than a correct free answer -- one in four is a
-- coin -- so `record_attempt` caps it, and any future rebalancing of mastery
-- needs to know which attempts were recognition and which were recall.
--
-- `options` exists so the question text does not have to carry them. Question
-- fingerprinting hashes `question`, so baking four shuffled options into that
-- string would make every reshuffle look like a brand-new question and
-- silently undo "never ask the same question twice". The stem goes in
-- `question`; the options live here as a JSON array.
--
-- NULL `format` means the learner answered in their own words -- they picked
-- "Other" and typed an explanation, which is free recall and escapes the cap.
-- On rows written before this column existed it means "unknown".
--
-- 'mcq' is the only format Eklavya writes. The CHECK still names two others it
-- never writes; they are dead values kept because rewriting an applied
-- migration's CHECK means rebuilding the table for nothing.
ALTER TABLE attempts ADD COLUMN format TEXT
  CHECK (format IN ('mcq','fill_blank','open'));

ALTER TABLE attempts ADD COLUMN options TEXT;
