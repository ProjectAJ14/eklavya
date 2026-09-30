-- Which repository each project key is, independent of where it sits on disk.
--
-- Every project key is an absolute path, so moving or renaming a checkout used
-- to start it over: the history stayed filed under a folder that no longer
-- existed, and nothing said so. A repository's root commits do not change when
-- its folder does, so they are what `relocate.ts` recognises a moved project by.
--
-- One row per root, because a repository can have several (a merged-in
-- history), and two keys that share any root are the same lineage. Recorded
-- only on this machine, at a session start, and never synced: a path from
-- another device is not a folder this one can find missing.
CREATE TABLE IF NOT EXISTS project_roots (
  project     TEXT NOT NULL,
  root_commit TEXT NOT NULL,
  seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project, root_commit)
);

CREATE INDEX IF NOT EXISTS idx_project_roots_commit ON project_roots(root_commit);
