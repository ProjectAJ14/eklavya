-- Difficulty levels, earned per project (phase-9).
--
-- Tier already varies per question: `nextTierToAsk` walks a concept from recall
-- to design as the learner gets it right. What that cannot express is where the
-- learner stands *on this codebase*, and the gap shows up at both ends. A cold
-- start takes the median tier of everything they have ever mastered, so someone
-- with a solid web-auth history opens an unfamiliar React repo on judgement
-- questions about code they met four minutes ago -- and the honest answer to
-- those is "no idea", which is the answer that gets a plugin uninstalled.
--
-- So a coarse band sits above the tier ladder: easy (tiers 1-2), medium (2-4),
-- hard (3-5). Everyone starts at easy, and a level is earned by evidence rather
-- than chosen.
--
-- `repo` on attempts, because the band is per project. "How hard should this be"
-- is a question about a codebase, not about a person: the same developer is a
-- different learner on their fourth Node service and their first Rust one, and
-- one global level would have to be wrong for one of them.
--
-- `level` on attempts, because progress has to be attributable to the band it
-- was earned in. Deriving it from `difficulty` afterwards would be wrong in both
-- directions: the bands overlap, so tier 2 belongs to easy and medium alike.
--
-- Both are NULL for every attempt recorded before this migration, and that is
-- deliberate rather than a gap to backfill later. `repo` is unrecoverable -- the
-- session's cwd was never stored -- and reading a level out of an old tier-3
-- answer would hand out promotions nobody earned, on install day, to everyone.
-- NULL here means unknown, the same as in migrations 004, 005 and 006.
ALTER TABLE attempts ADD COLUMN repo TEXT;

ALTER TABLE attempts ADD COLUMN level TEXT
  CHECK (level IN ('easy','medium','hard'));

-- One row per project, created lazily on the first promotion.
--
-- `promoted_at` is when this level was entered, and it is what makes progress
-- countable: the passing answers that count toward the next promotion are the
-- ones recorded after it. There is deliberately no `passed_at_level` counter --
-- see `levelProgress` in store.ts. A counter can drift from the attempt rows
-- that justify it, and it would freeze `level_up_after` at whatever it was when
-- each attempt landed, so lowering the threshold would not release the learners
-- already past it.
--
-- `repo` is the git root as `findRepoConfig` resolves it (symlinks resolved, so
-- the server and the git hook agree on the string). A directory outside any
-- repository falls into the shared '*' bucket rather than minting a row per cwd.
CREATE TABLE IF NOT EXISTS project_levels (
  repo        TEXT PRIMARY KEY,
  level       TEXT NOT NULL DEFAULT 'easy'
              CHECK (level IN ('easy','medium','hard')),
  promoted_at TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The progress count runs on the SessionStart critical path (PRD §9.1), so it
-- gets its own index rather than scanning a growing attempts table.
CREATE INDEX IF NOT EXISTS idx_attempts_repo_level ON attempts(repo, level, ts DESC);
