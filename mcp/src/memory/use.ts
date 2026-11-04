import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';

/**
 * What recall did for the sessions it served (issue #259): per entry, how
 * often it was sent, opened and applied, a decayed utility score that ranks
 * recall, and whether it may be outdated. Computed by the background fold
 * from rows the hooks and tools already wrote; a hook never runs any of it.
 */

export const UTILITY_DECAY = 0.8;
/** Sent this often and never applied: probably not worth its place. */
export const NEVER_APPLIED_AFTER = 5;
/** Commits to an entry's files since it was written before it is a stale candidate. */
export const STALE_COMMITS = 3;
const GIT_TIMEOUT_MS = 2_000;

const nowIso = () => new Date().toISOString();
const list = (json: string | null): string[] => {
  try {
    const v = JSON.parse(json ?? '[]') as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** Commits to `files` since `since`, or null when git cannot say. */
function commitsSince(repo: string, since: string, files: string[]): number | null {
  try {
    const out = execFileSync('git', ['log', '--format=%H', `--since=${since}`, '--', ...files], {
      cwd: repo,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').filter(Boolean).length;
  } catch {
    return null;
  }
}

/**
 * Why an entry may be outdated, or null: one of its files is gone, its files
 * have had `STALE_COMMITS` commits since, or a newer decision or fix covers
 * the same files.
 */
export function staleReason(db: DB, repo: string | null, entry: { id: number; project: string; files: string | null; occurred_at: string }): string | null {
  const files = list(entry.files).filter((f) => !f.startsWith('/') || (repo && f.startsWith(repo)));
  if (!files.length) return null;
  if (repo) {
    const missing = files.find((f) => !fs.existsSync(path.isAbsolute(f) ? f : path.join(repo, f)));
    if (missing) return `files changed since ${entry.occurred_at.slice(0, 10)}: ${path.basename(missing)} was deleted or renamed`;
    const n = commitsSince(repo, entry.occurred_at, files);
    if (n !== null && n >= STALE_COMMITS) return `files changed since ${entry.occurred_at.slice(0, 10)}: ${n} commits to them`;
  }
  const newer = db
    .prepare(
      `SELECT e.id, e.type FROM memory_entries e
       WHERE e.project = ? AND e.id != ? AND e.occurred_at > ? AND e.type IN ('decision', 'bugfix')
         AND e.deleted_at IS NULL AND e.superseded_by IS NULL AND e.files IS NOT NULL
         AND EXISTS (SELECT 1 FROM json_each(e.files) WHERE json_each.value IN (SELECT value FROM json_each(?)))
       ORDER BY e.occurred_at DESC LIMIT 1`,
    )
    .get(entry.project, entry.id, entry.occurred_at, JSON.stringify(files)) as { id: number; type: string } | undefined;
  return newer ? `a newer ${newer.type} (#${newer.id}) covers the same files` : null;
}

/**
 * Folds one finished session into the per-entry figures. Once per session.
 * `repo` is the checkout, for the git checks; null skips them.
 */
export function foldEntryUse(db: DB, config: EklavyaConfig, project: string, sessionId: string, repo: string | null): void {
  if (db.prepare('SELECT 1 FROM memory_use_sessions WHERE session_id = ?').get(sessionId)) return;
  const sent = new Set(
    (
      db
        .prepare(
          `SELECT DISTINCT i.entry_id FROM context_receipt_items i JOIN context_receipts r ON r.id = i.receipt_id
           WHERE r.session_id = ? AND r.delivery IN ('emitted', 'confirmed')`,
        )
        .all(sessionId) as { entry_id: number }[]
    ).map((r) => r.entry_id),
  );
  const opened = new Set(
    (db.prepare(`SELECT entry_ids FROM memory_reads WHERE session_id = ? AND tool = 'memory_get'`).all(sessionId) as { entry_ids: string }[]).flatMap((r) =>
      list(r.entry_ids).map(Number),
    ),
  );
  const touched = new Set(
    (db.prepare(`SELECT files FROM evidence_events WHERE session_id = ? AND kind IN ('file_read', 'file_edit') AND files IS NOT NULL`).all(sessionId) as { files: string }[]).flatMap((r) =>
      list(r.files).map((f) => path.basename(f)),
    ),
  );
  const at = nowIso();
  const upsert = db.prepare(
    `INSERT INTO memory_entry_use (entry_id, sent, opened, applied, utility, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET sent = sent + excluded.sent, opened = opened + excluded.opened,
       applied = applied + excluded.applied, utility = utility * ${UTILITY_DECAY} + excluded.utility, updated_at = excluded.updated_at`,
  );
  const appliedHere = db.prepare('INSERT OR IGNORE INTO memory_session_applied (session_id, entry_id) VALUES (?, ?)');
  const flag = db.prepare(
    `UPDATE memory_entry_use SET stale_reason = ?, stale_since = ?, stale_by = 'fold' WHERE entry_id = ? AND stale_reason IS NULL`,
  );
  db.transaction(() => {
    for (const id of new Set([...sent, ...opened])) {
      const entry = db.prepare('SELECT id, project, files, occurred_at FROM memory_entries WHERE id = ?').get(id) as
        | { id: number; project: string; files: string | null; occurred_at: string }
        | undefined;
      if (!entry || entry.project !== project) continue;
      const applied = list(entry.files).some((f) => touched.has(path.basename(f)));
      upsert.run(id, sent.has(id) ? 1 : 0, opened.has(id) ? 1 : 0, applied ? 1 : 0, applied ? 1 : 0, at);
      if (applied) appliedHere.run(sessionId, id);
      if (!config.memory.stale_check) continue;
      const use = db.prepare('SELECT sent, applied FROM memory_entry_use WHERE entry_id = ?').get(id) as { sent: number; applied: number };
      const reason =
        use.sent >= NEVER_APPLIED_AFTER && use.applied === 0 ? `sent ${use.sent} times and never used` : staleReason(db, repo, entry);
      if (reason) flag.run(reason, at, id);
    }
    db.prepare('INSERT INTO memory_use_sessions (session_id, folded_at) VALUES (?, ?)').run(sessionId, at);
  })();
}

export interface EntryUse {
  utility: number;
  stale_reason: string | null;
  stale_since: string | null;
  stale_by: string | null;
}

/** The use row of each id that has one. */
export function entryUse(db: DB, ids: number[]): Map<number, EntryUse> {
  if (!ids.length) return new Map();
  const rows = db
    .prepare(`SELECT entry_id, utility, stale_reason, stale_since, stale_by FROM memory_entry_use WHERE entry_id IN (${ids.map(() => '?').join(',')})`)
    .all(...ids) as (EntryUse & { entry_id: number })[];
  return new Map(rows.map(({ entry_id, ...r }) => [entry_id, r]));
}

/** Marks an entry as possibly outdated, by the model through `memory_flag_stale`. */
export function flagStale(db: DB, id: number, reason: string): void {
  db.prepare(
    `INSERT INTO memory_entry_use (entry_id, stale_reason, stale_since, stale_by, updated_at) VALUES (?, ?, ?, 'model', ?)
     ON CONFLICT(entry_id) DO UPDATE SET stale_reason = excluded.stale_reason, stale_since = excluded.stale_since, stale_by = 'model', updated_at = excluded.updated_at`,
  ).run(id, reason.slice(0, 300), nowIso(), nowIso());
}

/** Stale counts for the dashboard: flagged now, and rewritten by a refresh. */
export function staleCounts(db: DB, project: string | null): { flagged: number; refreshed: number } {
  return db
    .prepare(
      `SELECT COALESCE(SUM(u.stale_reason IS NOT NULL AND e.superseded_by IS NULL), 0) AS flagged, COALESCE(SUM(u.refreshed_at IS NOT NULL), 0) AS refreshed
       FROM memory_entry_use u JOIN memory_entries e ON e.id = u.entry_id WHERE (? IS NULL OR e.project = ?)`,
    )
    .get(project, project) as { flagged: number; refreshed: number };
}
