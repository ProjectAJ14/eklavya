-- Memory: the evidence half of the unified plugin (.plan/unified-memory-learning).
--
-- Learning already records what the developer was *asked* and what they knew.
-- These tables record what actually *happened* -- the prompts, tool uses, edits
-- and failures a session produced -- and the observations distilled from them.
-- They live in the same file as the learning tables (ADR-02) so one transaction
-- can say "this evidence produced this concept candidate", and they hold no
-- foreign key into learning except that one explicit link table.
--
-- Nothing here is trusted instruction material. Everything an observer or an
-- import writes is derived data with provenance, quoted back to the model as
-- evidence and never as a system prompt (PRD SEC-01).

-- Raw accepted evidence. One row per host event that survived exclusion and
-- sanitisation. `event_uid` is the idempotency key: hooks and transcript replay
-- both converge here and must not record the same turn twice (PRD CAP-02).
CREATE TABLE IF NOT EXISTS evidence_events (
  id          INTEGER PRIMARY KEY,
  event_uid   TEXT NOT NULL UNIQUE,
  project     TEXT NOT NULL,              -- projectKey: worktrees folded into their checkout
  checkout    TEXT,                       -- the unfolded root, so a worktree stays distinguishable
  session_id  TEXT NOT NULL,
  agent_id    TEXT,                       -- subagent identity, NULL for the main thread
  host        TEXT NOT NULL DEFAULT 'claude-code',
  source      TEXT NOT NULL DEFAULT 'hook', -- 'hook' | 'replay' | 'manual' | 'import'
  kind        TEXT NOT NULL,              -- prompt|tool_use|tool_error|file_edit|file_read|assistant|lifecycle|note
  tool        TEXT,
  title       TEXT,
  body        TEXT NOT NULL DEFAULT '',
  files       TEXT,                       -- JSON array of repo-relative paths
  occurred_at TEXT NOT NULL,              -- when it happened on the host
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  redacted    INTEGER NOT NULL DEFAULT 0, -- 1 when the privacy filter removed something
  batch_id    INTEGER,                    -- set once a batch claims it
  status      TEXT NOT NULL DEFAULT 'accepted' -- accepted|batched|summarized
);

-- The immutable input to one observation job. A provider request must be
-- reconstructible from storage after a crash, not from a lost in-memory
-- conversation (PRD DATA-03), so the batch is written before the job runs.
CREATE TABLE IF NOT EXISTS memory_batches (
  id          INTEGER PRIMARY KEY,
  project     TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,              -- 'size' | 'time' | 'session_seam' | 'manual'
  event_count INTEGER NOT NULL DEFAULT 0,
  byte_count  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Durable jobs with claim leases. A crashed worker's lease expires and the job
-- is retried; `attempts` and `last_error` classify why, so a permanent failure
-- (bad auth) is distinguishable from a transient one (timeout).
CREATE TABLE IF NOT EXISTS memory_jobs (
  id          INTEGER PRIMARY KEY,
  batch_id    INTEGER NOT NULL REFERENCES memory_batches(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'summarize',
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|claimed|done|failed|paused
  attempts    INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TEXT,
  last_error  TEXT,
  error_class TEXT,                       -- transient|auth|quota|overflow|malformed|permanent
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- An observation: the distilled, searchable unit of memory. `kind` separates a
-- generated observation from a session summary and from a note the developer
-- wrote by hand. Corrections supersede rather than overwrite, so the audit
-- trail survives (PRD MEM-03).
CREATE TABLE IF NOT EXISTS memory_entries (
  id            INTEGER PRIMARY KEY,
  entry_uid     TEXT NOT NULL UNIQUE,
  project       TEXT NOT NULL,
  session_id    TEXT,
  batch_id      INTEGER REFERENCES memory_batches(id) ON DELETE SET NULL,
  kind          TEXT NOT NULL DEFAULT 'observation', -- observation|session_summary|note
  type          TEXT,                     -- bugfix|feature|refactor|decision|discovery|...
  title         TEXT NOT NULL,
  narrative     TEXT NOT NULL DEFAULT '',
  facts         TEXT,                     -- JSON array of strings
  files         TEXT,                     -- JSON array of repo-relative paths
  generator     TEXT NOT NULL DEFAULT 'local', -- summarizer id, e.g. 'local-v1' or a provider id
  confidence    REAL,
  occurred_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  superseded_by INTEGER REFERENCES memory_entries(id) ON DELETE SET NULL,
  deleted_at    TEXT,
  import_source TEXT                      -- provenance when the row came from an importer
);

-- Which raw events an entry came from. Drill-down from an observation to the
-- evidence behind it, and the reason an entry can be rebuilt after a bad batch.
CREATE TABLE IF NOT EXISTS memory_entry_events (
  entry_id INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES evidence_events(id) ON DELETE CASCADE,
  PRIMARY KEY (entry_id, event_id)
);

-- Tags are a table rather than JSON because filtering by tag is a first-class
-- retrieval path and `json_each` over the whole corpus is not an index.
CREATE TABLE IF NOT EXISTS memory_entry_tags (
  entry_id INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  PRIMARY KEY (entry_id, tag)
);

-- Keyword retrieval. Contentless FTS5: the row content lives in memory_entries
-- and the index stores only the terms, so there is one copy of the text.
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  title, narrative, facts, files,
  content = 'memory_entries',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Semantic retrieval (ADR-03). One row per entry per embedder: switching
-- embedders re-embeds in the background and vectors of different models are
-- never compared, because `embedder_id` is part of the read filter.
CREATE TABLE IF NOT EXISTS memory_vectors (
  entry_id    INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  embedder_id TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  vec         BLOB NOT NULL,              -- float32 little-endian, L2-normalised
  PRIMARY KEY (entry_id, embedder_id)
);

-- The savings ledger (PRD MET-01). One receipt per injection: what would have
-- been read (`base_tokens`), what was actually delivered (`delivered_tokens`),
-- how both were counted, and whether delivery was confirmed. A percentage the
-- dashboard or the banner shows must be derivable from these rows alone.
CREATE TABLE IF NOT EXISTS context_receipts (
  id               INTEGER PRIMARY KEY,
  receipt_uid      TEXT NOT NULL UNIQUE,
  project          TEXT NOT NULL,
  session_id       TEXT,
  scope            TEXT NOT NULL,         -- 'session_start' | 'search' | 'resume' | ...
  method           TEXT NOT NULL,         -- tokenizer/estimator identity
  base_tokens      INTEGER NOT NULL DEFAULT 0,
  delivered_tokens INTEGER NOT NULL DEFAULT 0,
  item_count       INTEGER NOT NULL DEFAULT 0,
  delivery         TEXT NOT NULL DEFAULT 'unknown', -- confirmed|unknown|prepared
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-item accounting, so a later detail fetch updates the same episode's total
-- instead of leaving the optimistic index-only percentage standing.
CREATE TABLE IF NOT EXISTS context_receipt_items (
  receipt_id    INTEGER NOT NULL REFERENCES context_receipts(id) ON DELETE CASCADE,
  entry_id      INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  source_tokens INTEGER NOT NULL DEFAULT 0,
  sent_tokens   INTEGER NOT NULL DEFAULT 0,
  stage         TEXT NOT NULL DEFAULT 'index', -- 'index' | 'detail'
  PRIMARY KEY (receipt_id, entry_id, stage)
);

-- The one explicit bridge between the two halves (PRD LRN-02, DATA-01).
-- An evidence-derived concept candidate. `status` is the gate: a candidate is
-- not a concept, and no row here ever records an attempt or moves mastery.
CREATE TABLE IF NOT EXISTS learning_sources (
  id         INTEGER PRIMARY KEY,
  entry_id   INTEGER REFERENCES memory_entries(id) ON DELETE CASCADE,
  event_id   INTEGER REFERENCES evidence_events(id) ON DELETE CASCADE,
  concept_id INTEGER REFERENCES concepts(id),
  slug       TEXT,                        -- proposed slug before validation
  name       TEXT,
  domain     TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'candidate', -- candidate|accepted|rejected|duplicate
  project    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Saved focused knowledge collections (PRD RET-04). The filter is stored so a
-- rebuild reproduces the same query; membership is materialised so a failed
-- rebuild can be discarded without losing the last good set.
CREATE TABLE IF NOT EXISTS memory_collections (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  filter      TEXT NOT NULL DEFAULT '{}', -- JSON query descriptor
  project     TEXT,
  built_at    TEXT,
  status      TEXT NOT NULL DEFAULT 'ready', -- ready|building|failed
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS memory_collection_items (
  collection_id INTEGER NOT NULL REFERENCES memory_collections(id) ON DELETE CASCADE,
  entry_id      INTEGER NOT NULL REFERENCES memory_entries(id) ON DELETE CASCADE,
  rank          REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, entry_id)
);

-- Read paths on a user's critical path: the SessionStart recall, the dashboard
-- timeline, and the worker's claim scan.
CREATE INDEX IF NOT EXISTS idx_events_project_time  ON evidence_events(project, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session       ON evidence_events(session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_status        ON evidence_events(status, project);
CREATE INDEX IF NOT EXISTS idx_entries_project_time ON memory_entries(project, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_session      ON memory_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status          ON memory_jobs(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_receipts_project     ON context_receipts(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sources_status       ON learning_sources(status, project);
CREATE INDEX IF NOT EXISTS idx_tags_tag             ON memory_entry_tags(tag);

-- FTS stays in step through triggers rather than through every call site
-- remembering to update it. External-content FTS5 needs the old values on
-- delete, which only a trigger has to hand.
CREATE TRIGGER IF NOT EXISTS memory_entries_ai AFTER INSERT ON memory_entries BEGIN
  INSERT INTO memory_fts(rowid, title, narrative, facts, files)
  VALUES (new.id, new.title, new.narrative, new.facts, new.files);
END;

CREATE TRIGGER IF NOT EXISTS memory_entries_ad AFTER DELETE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, narrative, facts, files)
  VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.files);
END;

CREATE TRIGGER IF NOT EXISTS memory_entries_au AFTER UPDATE ON memory_entries BEGIN
  INSERT INTO memory_fts(memory_fts, rowid, title, narrative, facts, files)
  VALUES ('delete', old.id, old.title, old.narrative, old.facts, old.files);
  INSERT INTO memory_fts(rowid, title, narrative, facts, files)
  VALUES (new.id, new.title, new.narrative, new.facts, new.files);
END;
