-- Batch provenance (PRD MEM-01: "a versioned input batch and prompt/config
-- identity").
--
-- 009 made the input reconstructible -- the events, the reason, the counts --
-- but not the run. `memory_entries.generator` records the summariser after the
-- fact and only when the batch produced something, so a batch that came out
-- wrong, or produced nothing at all, left no way to know which summariser or
-- which configuration had read it. Both are written when the job is claimed,
-- which is the point at which they are known and before the call that may fail.
--
-- Nullable because every batch written before this migration ran genuinely has
-- no answer, and a backfilled guess would be worse than an honest NULL.
ALTER TABLE memory_batches ADD COLUMN summarizer TEXT;

-- Digest over the settings that change what a summary comes out as: what
-- capture accepted, what redaction removed, which model read it. Never a key --
-- a provider config names an environment variable, not its value (SEC-01).
ALTER TABLE memory_batches ADD COLUMN config_digest TEXT;
