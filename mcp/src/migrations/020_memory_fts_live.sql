-- Keyword index over live memory entries only, with the triggers as its one owner.
--
-- Until now the index had two writers. Soft delete set `deleted_at`, which fired
-- the update trigger (remove the old terms, index the new ones), and then
-- `deleteEntry` removed the terms by hand a second time. The row stayed in
-- `memory_entries` with nothing left in the index, so the next update or delete
-- of that row asked FTS5 to remove terms it no longer held. FTS5 cannot detect
-- that for an external-content table: it reported "database disk image is
-- malformed", and a second soft delete, a hard delete or any later update of
-- the row failed.
--
-- The fix makes indexing follow the row's lifecycle. The index's content is a
-- view of the rows that are not deleted, so what is indexed and what the index
-- is checked against are the same set, and `integrity-check` holds after every
-- transition. The triggers remove terms only from a row that was live and add
-- them only to a row that is live, so an update to a deleted row, a repeated
-- soft delete and a hard delete of a soft-deleted row touch nothing. The manual
-- delete in `deleteEntry` is gone with this migration.
--
-- Rebuilding repairs databases the double delete already damaged. The index is
-- derived data: `memory_entries` keeps every row, its evidence links and its
-- deletion state, and the rebuild re-reads the terms from it.

DROP TRIGGER IF EXISTS memory_entries_ai;
DROP TRIGGER IF EXISTS memory_entries_ad;
DROP TRIGGER IF EXISTS memory_entries_au;
DROP TABLE IF EXISTS memory_fts;

CREATE VIEW IF NOT EXISTS memory_fts_live AS
  SELECT id, title, narrative, facts, files FROM memory_entries WHERE deleted_at IS NULL;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, narrative, facts, files,
  content = 'memory_fts_live',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');

CREATE TRIGGER memory_entries_ai AFTER INSERT ON memory_entries
WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO memory_fts(rowid, title, narrative, facts, files)
  VALUES (new.id, new.title, new.narrative, new.facts, new.files);
END;

CREATE TRIGGER memory_entries_ad AFTER DELETE ON memory_entries
WHEN old.deleted_at IS NULL BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, narrative, facts, files)
  VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.files);
END;

-- Only a change to an indexed column or to whether the row is live reindexes;
-- marking a row superseded or recording a read leaves the index alone.
CREATE TRIGGER memory_entries_au AFTER UPDATE ON memory_entries
WHEN old.title IS NOT new.title
  OR old.narrative IS NOT new.narrative
  OR old.facts IS NOT new.facts
  OR old.files IS NOT new.files
  OR old.id IS NOT new.id
  OR (old.deleted_at IS NULL) IS NOT (new.deleted_at IS NULL)
BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, narrative, facts, files)
  SELECT 'delete', old.id, old.title, old.narrative, old.facts, old.files
  WHERE old.deleted_at IS NULL;
  INSERT INTO memory_fts(rowid, title, narrative, facts, files)
  SELECT new.id, new.title, new.narrative, new.facts, new.files
  WHERE new.deleted_at IS NULL;
END;
