-- Failures avoided by facts (issue #268).
--
-- `avoided` is what the session's fold found for a FormRepair fact it was
-- shown: 1 when the session ran the fact's intent and never ran its failing
-- form, 0 when it ran the failing form or never needed the intent. NULL until
-- the session is folded, and for any other kind of fact. The Cost workflow's
-- "failures avoided" figure counts the 1s; it is an estimate, since a session
-- may have avoided the failing form without reading the fact.

ALTER TABLE pinned_fact_shown ADD COLUMN avoided INTEGER;
