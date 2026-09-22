-- Multi-device sync (ADR-09): a shared *directory*, never a server.
--
-- Two devices point at one folder -- Dropbox, iCloud, Syncthing, a mounted
-- share, a git repo -- and exchange revision records as files. None of those is
-- a dependency, because the target is a path. The hosted team server in the
-- PRD's Phase 6 is deliberately not built.
--
-- What crosses is memory entries, their tags and their tombstones. Attempts,
-- mastery, gates, receipts and raw `evidence_events` never do (PRD SEC-02): a
-- developer's assessment history is theirs, and pointing a team at one shared
-- folder must not hand them everyone's quiz record. `src/memory/sync.ts`
-- enforces that with a column allowlist; these tables simply have nowhere to
-- put anything else.

-- Per-device high-water marks, including this device's own counter.
--
-- One uniform meaning for every row: "revisions from this device up to and
-- including `last_revision` are reflected in this database". For a peer that
-- makes a pull incremental -- only files above the mark are read. For the local
-- device it is the last revision handed out, so `revision` is monotonic per
-- device and a pair (device_id, revision) names one version for ever.
CREATE TABLE IF NOT EXISTS sync_state (
  device_id     TEXT PRIMARY KEY,
  last_revision INTEGER NOT NULL DEFAULT 0,
  last_sync_at  TEXT
);

-- The version vector, one row per entry uid: which device wrote the version
-- this database currently holds, at which revision, and what it descended from.
--
-- Keyed by `entry_uid` and not by the entry's integer id, and with no foreign
-- key, on purpose. Row ids are local; `entry_uid` is the only name two devices
-- agree on. And a tombstone has to outlive the row it buries -- without a
-- record that survives the delete, the next pull from a device that still had
-- the entry would resurrect it, which is the exact bug this table prevents.
--
-- `base` is the version this one replaced, spelled `<device>:<revision>` (NULL
-- for a first write). An incoming record whose `base` is what we already hold
-- is a fast-forward and applies. Anything else is divergence, and divergence is
-- quarantined rather than merged.
--
-- `hash` covers the payload, so the push scan can tell a changed entry from an
-- untouched one without a write-time hook in `memory/store.ts`.
CREATE TABLE IF NOT EXISTS sync_records (
  entry_uid  TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  revision   INTEGER NOT NULL,
  base       TEXT,
  op         TEXT NOT NULL DEFAULT 'upsert',  -- 'upsert' | 'delete' (a tombstone)
  hash       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Losing versions, kept readable rather than dropped.
--
-- Two devices editing one entry between syncs is not something a timestamp can
-- adjudicate, so nothing here is overwritten silently: the local version stays
-- live, the incoming one lands here with its whole payload, and a repair call
-- picks a side. `payload` is the wire record verbatim so that choosing the
-- remote side needs nothing from the target directory, which may be offline by
-- the time somebody looks.
CREATE TABLE IF NOT EXISTS sync_conflicts (
  id          INTEGER PRIMARY KEY,
  entry_uid   TEXT NOT NULL,
  device_id   TEXT NOT NULL,             -- the device whose version lost
  revision    INTEGER NOT NULL,
  base        TEXT,
  local_ref   TEXT NOT NULL,             -- `<device>:<revision>` held at the time
  payload     TEXT NOT NULL,             -- the incoming record, as JSON
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolution  TEXT                       -- 'local' | 'remote' | 'superseded'
);

CREATE INDEX IF NOT EXISTS idx_sync_records_device ON sync_records(device_id, revision);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_open ON sync_conflicts(resolved_at, entry_uid);
