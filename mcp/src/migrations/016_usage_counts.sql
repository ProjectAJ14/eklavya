-- Counts of which parts of Eklavya get used, for the anonymous usage ping
-- (`telemetry.ts`).
--
-- Most of what the ping reports is already on record -- attempts, concepts,
-- memory entries, receipts -- and is counted from those tables at send time.
-- What is not: which CLI command ran, which MCP tool was called, which slash
-- command was typed, and which hook failed open. Those leave no row anywhere,
-- so they are counted here.
--
-- `name` is always one of Eklavya's own identifiers (`cli:doctor`,
-- `tool:record_attempt`, `hook_error:capture-tool`), never anything the
-- developer typed. One row per name per UTC day; the ping sends the days it
-- has not sent yet and deletes them.
CREATE TABLE IF NOT EXISTS usage_counts (
  day   TEXT NOT NULL,              -- YYYY-MM-DD, UTC
  name  TEXT NOT NULL,
  n     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);
