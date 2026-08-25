-- Loop guard for the Stop hook (phase-2, P0).
--
-- `stop_hook_active` is no longer a documented hook input (deviation D2), so the
-- guard cannot lean on the harness at all. The rule is: block at most once per
-- set of logged concepts. Blocking stamps the count of concepts logged for the
-- session; the next Stop only blocks again if that count has grown, which means
-- genuinely new work happened. `block_count` is a hard backstop on top.

CREATE TABLE IF NOT EXISTS stop_markers (
  session_id        TEXT PRIMARY KEY,
  last_blocked_at   TEXT,
  last_logged_count INTEGER NOT NULL DEFAULT 0,
  block_count       INTEGER NOT NULL DEFAULT 0
);
