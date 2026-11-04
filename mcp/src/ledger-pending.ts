import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import type { DB } from './db.js';

/**
 * The part of the cost ledger the hooks use: open a session's row and start
 * the detached fold. Kept apart from `ledger.ts`, which pulls in the
 * transcript reader and the provider, so session start stays light.
 */

export const QUIET_MS = 10 * 60_000;
/** A pending session with no transcript after this long never had one. */
export const ABANDONED_MS = 24 * 3_600_000;

/** Opens a pending row for a session. Cheap: one insert, safe to repeat. */
export function openSession(db: DB, row: { sessionId: string; project: string | null; transcriptPath: string | null }): void {
  db.prepare(
    `INSERT INTO econ_sessions (session_id, project, transcript_path) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       transcript_path = COALESCE(econ_sessions.transcript_path, excluded.transcript_path),
       project = COALESCE(econ_sessions.project, excluded.project)`,
  ).run(row.sessionId, row.project, row.transcriptPath);
}

/** Sessions still to fold whose transcript has been quiet for `QUIET_MS`, not counting `except`. */
export function quietPending(db: DB, now: number, except: string | null = null): string[] {
  const rows = db
    .prepare('SELECT session_id, transcript_path, created_at FROM econ_sessions WHERE folded_at IS NULL AND session_id IS NOT ? LIMIT 50')
    .all(except) as { session_id: string; transcript_path: string | null; created_at: string }[];
  return rows
    .filter((r) => {
      try {
        return now - fs.statSync(r.transcript_path!).mtimeMs >= QUIET_MS;
      } catch {
        // No transcript yet: another session may only just have started. A day
        // later there will never be one; fold it as empty so it stops waiting.
        return now - Date.parse(r.created_at) >= ABANDONED_MS;
      }
    })
    .map((r) => r.session_id);
}

/**
 * Starts `eklavya fold` in a detached process the hook never waits for. The
 * fold reads whole transcripts, which a hook must never do.
 */
export function startFold(cli: string, args: string[], spawn: typeof nodeSpawn = nodeSpawn): void {
  startDetached(cli, ['fold', ...args], spawn);
}

/** Runs `eklavya <args>` detached: the fold, the loop guard's judge. Never awaited. */
export function startDetached(cli: string, args: string[], spawn: typeof nodeSpawn = nodeSpawn): void {
  // A test run spawns real hooks; a detached process outliving it would write
  // to a database the test is about to delete. Tests pass their own spawn.
  if (spawn === nodeSpawn && process.env.VITEST) return;
  try {
    const child = spawn(process.execPath, [cli, ...args], { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* The next session start folds what this one could not; the next call asks the judge again. */
  }
}

/** `1234567` → `1.2M`, `12345` → `12.3k`. */
export const compact = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));

/**
 * The session banner's cost line (issue #265): the last folded session in
 * this project, Eklavya's share of it, and what the loop guard and tool
 * pruning did since. Null when no session here has been priced yet.
 */
export function lastSessionLine(db: DB, project: string, except: string | null): string | null {
  const last = db
    .prepare(
      `SELECT effective, eklavya_effective, model, ended_at, unpriced FROM econ_sessions
       WHERE project = ? AND folded_at IS NOT NULL AND session_id IS NOT ? AND requests > 0
       ORDER BY COALESCE(ended_at, created_at) DESC LIMIT 1`,
    )
    .get(project, except) as { effective: number; eklavya_effective: number; model: string | null; ended_at: string | null; unpriced: string | null } | undefined;
  if (!last) return null;
  const share = last.effective ? Math.round((100 * last.eklavya_effective) / last.effective) : 0;
  const since = last.ended_at ?? '';
  const guard = db.prepare(`SELECT COUNT(*) AS n FROM econ_guard_events WHERE project = ? AND kind IN ('redirect', 'notice', 'stop') AND at >= ?`).get(project, since) as { n: number };
  const pruned = db.prepare('SELECT record FROM econ_settings_writes WHERE project = ? AND applied_at >= ?').get(project, since) as { record: string } | undefined;
  const parts = [
    `Last session · ${compact(last.effective)} effective tokens${last.model ? ` on ${last.model}` : ''}${last.unpriced ? ' (part unpriced)' : ''}`,
    `Eklavya ${share}%`,
    ...(guard.n ? [`loop guard stepped in ${guard.n}×`] : []),
    ...(pruned ? [`${(JSON.parse(pruned.record) as { added: string[] }).added.length} tool(s) pruned`] : []),
  ];
  return parts.join(' · ');
}
