-- Failed reads and edits of excluded files, captured before the fix.
--
-- A failed Read, Edit or Write is `tool_error` evidence, and capture used to
-- apply the path exclusions only to `file_read` and `file_edit`. The excluded
-- path was stripped from `files`, but the error text -- which can quote the
-- file, a `.env` for example -- was kept. Capture now drops those events.
--
-- They are identifiable: each of these tools names its file in a required
-- argument, so a failure of one that is left with no file is a failure whose
-- only file was excluded. A rare failure the host sent without its arguments
-- matches too; it named no file, so nothing useful goes with it.
--
-- The links are cleared the way retention pruning clears them (`pruneEvidence`
-- in `src/memory/worker.ts`), so a connection without foreign keys cannot leave
-- rows pointing at nothing. A learning candidate outlives its event. Entries
-- already summarised from these events are left as they are.
-- Keep the tool list in step with `FILE_FAILURE_TOOLS` in
-- `src/memory/capture.ts`, which guards spool records written before this ran.
CREATE TEMP TABLE purge_excluded_failures AS
  SELECT id FROM evidence_events
   WHERE kind = 'tool_error'
     AND tool IN ('Read', 'NotebookRead', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit')
     AND (files IS NULL OR files = '[]');

UPDATE learning_sources SET event_id = NULL WHERE event_id IN (SELECT id FROM purge_excluded_failures);
DELETE FROM memory_entry_events WHERE event_id IN (SELECT id FROM purge_excluded_failures);
DELETE FROM evidence_events WHERE id IN (SELECT id FROM purge_excluded_failures);

DROP TABLE purge_excluded_failures;
