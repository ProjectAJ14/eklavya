-- The Did You Know card shown before a panel question.
--
-- JSON {fact, details} written by `present_question`, or NULL for a question
-- without a card (every row before this migration; the tool schema now
-- requires one). It teaches the concept and carries no answer, so `panel_sync` may
-- send it to the mod; the key stays server-side.
ALTER TABLE panel_questions ADD COLUMN card TEXT;
