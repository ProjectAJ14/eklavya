-- Out-of-order delivery for shared-folder sync.
--
-- A synced folder does not deliver files in the order they were written: a
-- cloud client can hand over revision 2 before revision 1. The pull used to
-- advance a peer's `sync_state.last_revision` to every revision it applied, so
-- a revision that arrived late sat below the mark and was never read -- a lost
-- memory, or a deletion that never propagated, with sync reporting success.
--
-- `last_revision` now means what migration 011 always said it meant for a peer:
-- every revision up to and including it is accounted for. It advances only over
-- a contiguous run of revisions that were applied, or that the writer declared
-- it will never write (its `void.json`). A revision applied above that floor is
-- remembered here instead, so a duplicate or a resumed pull skips it, and the
-- floor catches up -- deleting these rows -- once the gap below it fills.
--
-- Bounded by the files a peer has published above its floor; a writer on this
-- release voids the revisions it abandoned, so a permanent gap does not keep the
-- table growing. Existing marks are kept as they are: a revision an earlier
-- release already stepped over cannot be told apart from one it applied.
CREATE TABLE IF NOT EXISTS sync_received (
  device_id TEXT NOT NULL,
  revision  INTEGER NOT NULL,
  PRIMARY KEY (device_id, revision)
) WITHOUT ROWID;

-- Revisions from this peer known to exist (a file, or a later revision seen)
-- that have not yet been applied: what `sync status` reports as outstanding.
ALTER TABLE sync_state ADD COLUMN outstanding INTEGER NOT NULL DEFAULT 0;
