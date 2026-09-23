-- The two tables that point at an evidence event by `event_id`, indexed by it.
--
-- `pruneEvidence` deletes aged-out events, and for every deleted event SQLite
-- has to find the rows referencing it: the explicit `UPDATE learning_sources
-- ... WHERE event_id IN (...)` and `DELETE FROM memory_entry_events WHERE
-- event_id IN (...)`, and the foreign-key actions on both columns. Neither was
-- indexed -- `memory_entry_events`'s primary key starts with `entry_id`, which
-- a lookup by `event_id` alone cannot use -- so each deleted event cost a scan
-- of every link and every candidate. One illustrative fixture, 1,000 expired
-- events against 10,000 retained links: ~238ms to prune before, ~3ms after.
--
-- Nothing else changes: no row is touched, and both are plain b-tree indexes a
-- downgrade would simply ignore.
CREATE INDEX IF NOT EXISTS idx_entry_events_event ON memory_entry_events(event_id);
CREATE INDEX IF NOT EXISTS idx_sources_event      ON learning_sources(event_id);
