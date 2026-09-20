import type { DB } from './db.js';

const CURRENT_SESSION_KEY = 'current_session';
export const FALLBACK_SESSION_ID = 'default';

export function getCurrentSession(db: DB): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(CURRENT_SESSION_KEY) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setCurrentSession(db: DB, sessionId: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(CURRENT_SESSION_KEY, sessionId);
}

/**
 * The model cannot see its own Claude Code session id, but the Phase 2 hooks
 * receive the real one on stdin — so both sides have to agree on a resolution
 * order or the hooks query rows that were written under a different key
 * (phase-1 decision G1).
 */
export function resolveSessionId(db: DB, explicit?: string | null): string {
  const candidate =
    (explicit && explicit.trim()) ||
    (process.env.EKLAVYA_SESSION_ID && process.env.EKLAVYA_SESSION_ID.trim()) ||
    getCurrentSession(db) ||
    FALLBACK_SESSION_ID;

  return candidate;
}

const SESSION_OFF_PREFIX = 'session_off:';

/**
 * The per-session off switch: "turn Eklavya off, just for now".
 *
 * `mode: off` is the only other way to stop Eklavya, and both of its scopes are
 * files that outlive the session — a developer who silences an urgent afternoon
 * by writing `off` to their global config is a developer who finds out weeks
 * later that they turned the tool off for good. So this is stored in `meta`,
 * keyed by the session id both the hooks and the tools already agree on
 * (`resolveSessionId`), and nothing ever reads the row again once that session
 * ends. A row per silenced session accumulates, at a few bytes each; cleaning
 * them up would need a session lifetime the schema does not have.
 *
 * It silences, it does not exempt: the commit gate reads `.eklavya.json` and
 * knows nothing about sessions, so an enforced repo still holds the commit.
 */
export function sessionOffKey(sessionId: string): string {
  return `${SESSION_OFF_PREFIX}${sessionId}`;
}

export function isSessionOff(db: DB, sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(sessionOffKey(sessionId)) as
      | { value: string }
      | undefined;
    return row?.value === '1';
  } catch {
    // Hooks call this on every turn and must never break a session. A database
    // that cannot answer means "not silenced", the same as a missing row.
    return false;
  }
}

export function setSessionOff(db: DB, sessionId: string, off: boolean): void {
  if (!off) {
    db.prepare('DELETE FROM meta WHERE key = ?').run(sessionOffKey(sessionId));
    return;
  }
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, '1')
     ON CONFLICT(key) DO UPDATE SET value = '1'`,
  ).run(sessionOffKey(sessionId));
}
