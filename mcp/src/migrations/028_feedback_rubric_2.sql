-- Prompt feedback no longer uses the four-dimension rubric. Items written under
-- it (rubric 1) keep their prompt, rewrite and tips; their per-dimension notes
-- are cleared to the current shape, so nothing reads or shows the old rubric.
UPDATE feedback_items SET review = '{"worked":"","gaps":[]}' WHERE rubric = 1;
