-- What each of Eklavya's own calls produced, by id (the Cost workflow's call page).
--
-- `econ_overhead` still holds no prompt and no reply. These columns say which
-- row a call served, so the page can show what it wrote from rows Eklavya
-- already keeps:
--
--   batch_id    an observer call: the `memory_batches` row it summarised. Its
--               entries are `memory_entries.batch_id`, its evidence
--               `evidence_events.batch_id` (gone once `memory.retention_days`
--               prunes it). The worker now also records the batch's project
--               and session on the row.
--   entry_id    a stale_refresh call: the `memory_entries` row it rewrote; the
--               rewrite is that row's `superseded_by`.
--   feedback_id a feedback call: the `feedback_items` row it wrote, set once
--               the item is saved. A review that wrote no item leaves it NULL.
--
-- No foreign keys: a ledger row outlives what it points at, and the page says
-- when that is gone. Rows written before this migration stay NULL.

ALTER TABLE econ_overhead ADD COLUMN batch_id INTEGER;
ALTER TABLE econ_overhead ADD COLUMN entry_id INTEGER;
ALTER TABLE econ_overhead ADD COLUMN feedback_id INTEGER;
