-- A change counter for the dashboard's stale-data notice.
--
-- An open dashboard polls to learn whether work landed since it loaded. It
-- used to compare a handful of row counts, and a count cannot see a row that
-- changes in place: a session summary is rewritten as the session runs
-- (`replaceEntry`), a receipt moves from prepared to delivered, a candidate is
-- accepted. The page kept showing the old next steps with no notice.
--
-- `change_version.n` moves on every insert, update and delete of a table the
-- dashboard displays, from whichever process writes it: hooks, the MCP server,
-- the worker, the CLI. The poll reads one integer. It never moves on a read,
-- so an unchanged database never raises the notice.
--
-- Left out on purpose: `meta` (schema and seed bookkeeping), `usage_counts`,
-- sync and import bookkeeping, checkpoints and stop markers, collections, and
-- `memory_batches` -- none of them is on the page. Two tables are narrowed:
-- `gates` is upserted on every turn but the page reads only its `repo`, and a
-- `memory_jobs` lease renewal is not a change the queue counts show.
CREATE TABLE IF NOT EXISTS change_version (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n  INTEGER NOT NULL
);
INSERT OR IGNORE INTO change_version (id, n) VALUES (1, 0);

CREATE TRIGGER IF NOT EXISTS change_version_attempts_i AFTER INSERT ON attempts
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_attempts_u AFTER UPDATE ON attempts
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_attempts_d AFTER DELETE ON attempts
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_attempt_retries_i AFTER INSERT ON attempt_retries
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_attempt_retries_u AFTER UPDATE ON attempt_retries
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_attempt_retries_d AFTER DELETE ON attempt_retries
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_concepts_i AFTER INSERT ON concepts
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_concepts_u AFTER UPDATE ON concepts
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_concepts_d AFTER DELETE ON concepts
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_edges_i AFTER INSERT ON edges
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_edges_u AFTER UPDATE ON edges
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_edges_d AFTER DELETE ON edges
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_mastery_i AFTER INSERT ON mastery
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_mastery_u AFTER UPDATE ON mastery
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_mastery_d AFTER DELETE ON mastery
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_session_concepts_i AFTER INSERT ON session_concepts
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_session_concepts_u AFTER UPDATE ON session_concepts
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_session_concepts_d AFTER DELETE ON session_concepts
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_project_levels_i AFTER INSERT ON project_levels
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_project_levels_u AFTER UPDATE ON project_levels
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_project_levels_d AFTER DELETE ON project_levels
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_context_receipts_i AFTER INSERT ON context_receipts
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_context_receipts_u AFTER UPDATE ON context_receipts
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_context_receipts_d AFTER DELETE ON context_receipts
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_context_receipt_items_i AFTER INSERT ON context_receipt_items
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_context_receipt_items_u AFTER UPDATE ON context_receipt_items
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_context_receipt_items_d AFTER DELETE ON context_receipt_items
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_evidence_events_i AFTER INSERT ON evidence_events
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_evidence_events_u AFTER UPDATE ON evidence_events
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_evidence_events_d AFTER DELETE ON evidence_events
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_learning_sources_i AFTER INSERT ON learning_sources
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_learning_sources_u AFTER UPDATE ON learning_sources
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_learning_sources_d AFTER DELETE ON learning_sources
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_memory_entries_i AFTER INSERT ON memory_entries
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_entries_u AFTER UPDATE ON memory_entries
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_entries_d AFTER DELETE ON memory_entries
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_memory_entry_tags_i AFTER INSERT ON memory_entry_tags
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_entry_tags_u AFTER UPDATE ON memory_entry_tags
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_entry_tags_d AFTER DELETE ON memory_entry_tags
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_memory_entry_events_i AFTER INSERT ON memory_entry_events
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_entry_events_u AFTER UPDATE ON memory_entry_events
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_entry_events_d AFTER DELETE ON memory_entry_events
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_memory_vectors_i AFTER INSERT ON memory_vectors
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_vectors_u AFTER UPDATE ON memory_vectors
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_vectors_d AFTER DELETE ON memory_vectors
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_memory_reads_i AFTER INSERT ON memory_reads
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_reads_u AFTER UPDATE ON memory_reads
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_reads_d AFTER DELETE ON memory_reads
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_gates_i AFTER INSERT ON gates
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_gates_u AFTER UPDATE ON gates
WHEN old.repo IS NOT new.repo BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_gates_d AFTER DELETE ON gates
BEGIN UPDATE change_version SET n = n + 1; END;

CREATE TRIGGER IF NOT EXISTS change_version_memory_jobs_i AFTER INSERT ON memory_jobs
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_jobs_u AFTER UPDATE ON memory_jobs
WHEN old.status IS NOT new.status OR old.error_class IS NOT new.error_class
BEGIN UPDATE change_version SET n = n + 1; END;
CREATE TRIGGER IF NOT EXISTS change_version_memory_jobs_d AFTER DELETE ON memory_jobs
BEGIN UPDATE change_version SET n = n + 1; END;
