import type Database from 'better-sqlite3';

/**
 * The loop guard's word in the status bar (issue #262), kept in its own file
 * so `eklavya statusline`, which runs on every refresh, loads nothing else.
 */
/** The status-line note while the session's open turn has had a notice. */
export function guardNote(db: Database.Database, sessionId: string): string | null {
  try {
    const row = db
      .prepare(`SELECT noticed, nudges FROM econ_turns WHERE session_id = ? AND agent_id = '' AND closed_at IS NULL ORDER BY id DESC LIMIT 1`)
      .get(sessionId) as { noticed: number; nudges: number } | undefined;
    if (row?.noticed) return 'loop guard: this turn looks stuck';
    if (row?.nudges) return 'loop guard: redirected';
    return null;
  } catch {
    return null;
  }
}

