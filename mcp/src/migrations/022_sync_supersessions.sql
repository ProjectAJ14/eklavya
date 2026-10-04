-- A correction's link to its replacement, for the moment sync delivers the
-- corrected entry before the entry that replaced it.
--
-- `memory_entries.superseded_by` is a local row id, so sync carries the
-- replacement's `entry_uid` instead and resolves it on arrival. A device pushes
-- every changed entry in one pass, in no promised order, and a peer can be
-- partway through another device's stream, so the original often lands first
-- and its replacement does not exist here yet. Until it does, the link waits in
-- this table: the original leaves retrieval when its replacement arrives, and
-- the push scan still reads the link from here, so the next push from this
-- device cannot publish the original as live again.
--
-- One row per waiting original. Removed with the entry it describes and once
-- the replacement arrives; never synced itself.
CREATE TABLE IF NOT EXISTS sync_supersessions (
  entry_uid       TEXT PRIMARY KEY REFERENCES memory_entries(entry_uid) ON DELETE CASCADE,
  replacement_uid TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_supersessions_replacement ON sync_supersessions(replacement_uid);
