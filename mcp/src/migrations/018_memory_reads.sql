-- Every call to a memory read tool, whether or not it named a receipt.
--
-- `memory_get` charges a detail fetch to the recall that proposed it, but only
-- when the model passes `receipt_id`, which is optional. A read without one
-- used to leave no trace at all, so "no detail fetches" in the receipts could
-- not tell "never read" from "read without a receipt". One row per call, from
-- `memory_search`, `memory_get`, `memory_timeline` and `memory_file_history`.
--
-- Ids, counts and timings only. No query text, no narrative, no file path:
-- `entry_ids` are the rows the call returned, `result_tokens` the estimated
-- size of what it returned (`chars4-v1`). `receipt_id` is not a foreign key:
-- a read outlives the receipt that retention removes, and stays counted.
CREATE TABLE IF NOT EXISTS memory_reads (
  id             INTEGER PRIMARY KEY,
  created_at     TEXT NOT NULL,
  project        TEXT,
  session_id     TEXT,
  tool           TEXT NOT NULL,
  receipt_id     INTEGER,
  entry_ids      TEXT NOT NULL DEFAULT '[]',
  outcome        TEXT NOT NULL,              -- ok|empty|error
  latency_ms     INTEGER NOT NULL DEFAULT 0,
  result_tokens  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_memory_reads_project ON memory_reads(project, created_at);
