-- Import provenance: the durable id map that makes an import resumable and
-- idempotent (PRD MIG-02).
--
-- Without it, a run interrupted halfway has no way to tell what it already
-- wrote, and the only safe second attempt is a full re-import that duplicates
-- everything. Entry and event uids are deterministic, so duplication is already
-- prevented at the row level -- but "already present" and "just written" are
-- indistinguishable without a map, and a report that cannot say which is which
-- cannot validate its own counts.
--
-- Keyed by (source, source_db, source_table, source_id) rather than by source
-- id alone: two Claude Mem databases (a laptop's and a restored backup) share
-- their autoincrement ids, and folding them together would silently drop half
-- of the second import.
CREATE TABLE IF NOT EXISTS import_id_map (
  source       TEXT NOT NULL,     -- importer id, e.g. 'claude-mem'
  source_db    TEXT NOT NULL,     -- identity of the source file, not its path of the day
  source_table TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  target_table TEXT NOT NULL,     -- 'memory_entries' | 'evidence_events' | 'learning_sources'
  target_id    INTEGER NOT NULL,
  imported_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source, source_db, source_table, source_id)
);

CREATE INDEX IF NOT EXISTS idx_import_target ON import_id_map(target_table, target_id);
