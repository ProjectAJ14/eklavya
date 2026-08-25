-- Phase 3: the git pre-commit hook enforces the gate from outside Claude Code,
-- so a gate row has to say which repository it belongs to (PRD §9.4).
ALTER TABLE gates ADD COLUMN repo TEXT;

CREATE INDEX IF NOT EXISTS idx_gates_repo ON gates(repo, updated_at DESC);
