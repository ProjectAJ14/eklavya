-- Write-time keyword expansion (issue #258).
--
-- The observer may now add `keywords`: the other words a developer would use
-- to ask about an observation ("auth", "login", "session cookie" for an entry
-- titled "Rotate refresh tokens on reuse"). They are stored on the entry and
-- indexed as a fifth FTS column, so a prompt worded differently from the
-- entry can still match it without a model call at recall time.
--
-- The index is rebuilt from `memory_entries` exactly as migration 020 does,
-- with the same live-row triggers plus the new column.

ALTER TABLE memory_entries ADD COLUMN keywords TEXT;

DROP TRIGGER IF EXISTS memory_entries_ai;
DROP TRIGGER IF EXISTS memory_entries_ad;
DROP TRIGGER IF EXISTS memory_entries_au;
DROP TABLE IF EXISTS memory_fts;
DROP VIEW IF EXISTS memory_fts_live;

CREATE VIEW memory_fts_live AS
  SELECT id, title, narrative, facts, files, keywords FROM memory_entries WHERE deleted_at IS NULL;

CREATE VIRTUAL TABLE memory_fts USING fts5(
  title, narrative, facts, files, keywords,
  content = 'memory_fts_live',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO memory_fts(memory_fts) VALUES ('rebuild');

CREATE TRIGGER memory_entries_ai AFTER INSERT ON memory_entries
WHEN new.deleted_at IS NULL BEGIN
  INSERT INTO memory_fts(rowid, title, narrative, facts, files, keywords)
  VALUES (new.id, new.title, new.narrative, new.facts, new.files, new.keywords);
END;

CREATE TRIGGER memory_entries_ad AFTER DELETE ON memory_entries
WHEN old.deleted_at IS NULL BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, narrative, facts, files, keywords)
  VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.files, old.keywords);
END;

CREATE TRIGGER memory_entries_au AFTER UPDATE ON memory_entries
WHEN old.title IS NOT new.title
  OR old.narrative IS NOT new.narrative
  OR old.facts IS NOT new.facts
  OR old.files IS NOT new.files
  OR old.keywords IS NOT new.keywords
  OR old.id IS NOT new.id
  OR (old.deleted_at IS NULL) IS NOT (new.deleted_at IS NULL)
BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, narrative, facts, files, keywords)
  SELECT 'delete', old.id, old.title, old.narrative, old.facts, old.files, old.keywords
  WHERE old.deleted_at IS NULL;
  INSERT INTO memory_fts(rowid, title, narrative, facts, files, keywords)
  SELECT new.id, new.title, new.narrative, new.facts, new.files, new.keywords
  WHERE new.deleted_at IS NULL;
END;
