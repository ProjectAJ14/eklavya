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
-- needs to know which attempts were recognition and which were recall. Inferring
-- it from whether `options` is NULL would work today and break the moment a
-- format arrives that has no options.
--
-- `options` exists so the question text does not have to carry them. Question
-- fingerprinting (PRD goal 2) hashes `question`, so baking four shuffled options
-- into that string would make every reshuffle look like a brand-new question and
-- silently undo "never ask the same question twice". The stem goes in
-- `question`; the options live here as a JSON array.
--
-- NULL `format` means "recorded before this column existed" -- unknown, and in
-- particular not an assertion that it was free-form.
--
-- fill_blank and open are accepted now though nothing writes them yet: the CHECK
-- is the expensive part to change later, and the next phase adds both.
ALTER TABLE attempts ADD COLUMN format TEXT
  CHECK (format IN ('mcq','fill_blank','open'));

ALTER TABLE attempts ADD COLUMN options TEXT;
