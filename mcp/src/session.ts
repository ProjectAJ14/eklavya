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
