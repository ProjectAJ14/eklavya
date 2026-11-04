-- The shared session page (issue: one session page for Learning, Memory and Cost).
--
-- `econ_sessions.eklavya_tools` is the fold's count of each Eklavya MCP tool
-- the session called, as JSON `{"memory_search": 3, ...}`: tool names and
-- counts only, never arguments or results. NULL until the session is folded.
--
-- `memory_session_applied` is which recalled entries a session went on to use
-- (read or edit one of the entry's files), one row per session and entry,
-- written by the same fold that adds to `memory_entry_use.applied`. That
-- column is a running total per entry; this table is the per-session half.

ALTER TABLE econ_sessions ADD COLUMN eklavya_tools TEXT;

CREATE TABLE memory_session_applied (
  session_id  TEXT NOT NULL,
  entry_id    INTEGER NOT NULL REFERENCES memory_entries (id) ON DELETE CASCADE,
  PRIMARY KEY (session_id, entry_id)
);

-- The session page reads these two by session.
CREATE INDEX IF NOT EXISTS idx_memory_reads_session ON memory_reads (session_id);
CREATE INDEX IF NOT EXISTS econ_guard_events_session ON econ_guard_events (session_id);
