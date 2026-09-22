import type { DB } from './db.js';
import { findRepoConfig } from './config.js';

const CURRENT_SESSION_KEY = 'current_session';
export const FALLBACK_SESSION_ID = 'default';

/**
 * The session pointer, keyed by checkout.
 *
 * One global pointer is not enough. Two Claude Code sessions in two repos share
 * this database, the model cannot see its own session id, and the tools tell it
 * to omit `session_id` -- so every tool call in both sessions resolves through
 * the same row. `prompt-submit-nudge` re-stamps that row on every prompt, which
 * means the pointer names whichever developer typed last, not whichever model is
 * calling. A model that churns for ten minutes while the other window is in use
 * logs its concepts into the other session: a talea session asked its developer
 * about D-Pilot's `app.use('/d-pilot', router)` exactly this way.
 *
 * Keying on the git root is what makes the two not collide. Worktrees keep their
 * own key on purpose -- unlike `projectKey`, which folds them into the main
 * checkout for level-keeping, here they are what concurrent sessions usually
 * are, and folding them back would re-create the collision this prevents. Two
 * sessions in one checkout still share a pointer, but then the work they mix is
 * at least from the same codebase.
 */
/*
 * The bare `current_session` row a pre-1.18 install left behind is dead once
 * this ships: nothing reads it and nothing writes it, and the first prompt in
 * each checkout stamps the keyed row that replaces it. It is one row of a few
 * bytes, and clearing it would cost a migration to save them.
 */
function sessionKeyFor(cwd?: string | null): string {
  const { repoRoot } = findRepoConfig(cwd ?? process.cwd());
  return repoRoot ? `${CURRENT_SESSION_KEY}:${repoRoot}` : CURRENT_SESSION_KEY;
}

export function getCurrentSession(db: DB, cwd?: string | null): string | null {
  // This checkout's row and nothing else. Falling back to a shared row would
  // hand back another repo's live session, which is the whole failure above --
  // and it would defeat the `default` that `set_config` relies on to refuse a
  // hookless host (`FALLBACK_SESSION_ID`, `tools/config_tools.ts`): a Cursor
  // session with no hooks would silence a real session in another repo instead.
  // Worse, a hook handed no `session_id` resolves through here and then stamps
  // what it read, so a shared fallback would freeze the foreign id into this
  // checkout for good.
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(sessionKeyFor(cwd)) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setCurrentSession(db: DB, sessionId: string, cwd?: string | null): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(sessionKeyFor(cwd), sessionId);
}

/**
 * The model cannot see its own Claude Code session id, but the Phase 2 hooks
 * receive the real one on stdin — so both sides have to agree on a resolution
 * order or the hooks query rows that were written under a different key
 * (phase-1 decision G1).
 */
export function resolveSessionId(db: DB, explicit?: string | null, cwd?: string | null): string {
  const candidate =
    (explicit && explicit.trim()) ||
    (process.env.EKLAVYA_SESSION_ID && process.env.EKLAVYA_SESSION_ID.trim()) ||
    getCurrentSession(db, cwd) ||
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
 * It silences, it does not exempt: the commit gate reads the project config and
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
