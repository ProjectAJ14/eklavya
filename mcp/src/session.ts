import type { DB } from './db.js';
import { findRepoConfig } from './config.js';
import { IDLE_BREAK_MINUTES, parseStamp } from './time.js';

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
  stampHostSession(db, sessionId);
  noteActivity(db, sessionId);
}

/**
 * When this session's current stretch of work began: its first activity, or the
 * first after an idle gap longer than `IDLE_BREAK_MINUTES`. Only work logged
 * since then is askable. Activity is a prompt or session start (stamped with the
 * pointer) and every work tool call (stamped by the checkpoint hook): an agent
 * working alone for seventy minutes after one prompt is not idle, and measuring
 * from prompts alone made that whole task stale the moment the developer typed
 * a follow-up.
 */
const ACTIVITY_PREFIX = 'activity:';

export function noteActivity(db: DB, sessionId: string, at = new Date()): void {
  const key = `${ACTIVITY_PREFIX}${sessionId}`;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  const now = at.toISOString();
  // An empty start means "since the session began": the first record sets no
  // boundary, because work logged before it (a session that predates this
  // stamp, or whose first stamp is a tool call) is still this stretch's work.
  // Only a real break starts a bounded stretch.
  const [last, since = ''] = row ? row.value.split('|') : [];
  const lastMs = parseStamp(last);
  const broke = lastMs !== null && at.getTime() - lastMs > IDLE_BREAK_MINUTES * 60_000;
  if (!row) {
    db.prepare(`DELETE FROM meta WHERE key LIKE ? AND substr(value, 1, 10) < date('now', '-7 day')`).run(
      `${ACTIVITY_PREFIX}%`,
    );
  }
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, `${now}|${broke ? now : since}`);
}

/** The start of the session's current stretch of work, or null for "since it began". */
export function workSince(db: DB, sessionId: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`${ACTIVITY_PREFIX}${sessionId}`) as
      | { value: string }
      | undefined;
    return row?.value.split('|')[1] || null;
  } catch {
    return null;
  }
}

/**
 * The host's own answer to "which session is calling", which the checkout
 * pointer can only guess at.
 *
 * The pointer guesses wrong in the two ways real work produces. Two windows in
 * one checkout share it, so a model logs into whichever session was typed in
 * last. And a model that passes the sibling worktree it is editing as `cwd`
 * finds no pointer at all and lands in the shared `default` bucket, where the
 * next session in that position is quizzed on it. One OIP day had both: a
 * session's answers graded under the window beside it, and a session asked four
 * questions about the previous day's scroll fix.
 *
 * Claude Code hands every process it spawns -- this MCP server and the hooks
 * alike -- `CLAUDE_CODE_SESSION_ID`, so the server knows its session without
 * being told. That id is fixed when the server starts, though, and `/clear`
 * starts a new session in the same process. So the hooks, which always see the
 * current id, also record it against the host process (its messaging socket,
 * one per `claude` process), and that record wins over the startup value.
 * Hosts that set neither variable fall through to the checkout pointer.
 */
const HOST_SESSION_PREFIX = 'host_session:';

function envValue(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/**
 * Which `claude` process this is: its messaging socket, else the session id it
 * started with -- a host without the socket still gets a record the hooks
 * refresh after `/clear`, instead of the startup id winning outright.
 */
function hostKey(): string | null {
  const socket = envValue('CLAUDE_CODE_MESSAGING_SOCKET');
  if (socket) return socket;
  const started = envValue('CLAUDE_CODE_SESSION_ID');
  return started ? `id:${started}` : null;
}

function stampHostSession(db: DB, sessionId: string): void {
  const host = hostKey();
  if (!host) return;
  // A row per `claude` process; a week is far past any process still running.
  db.prepare(`DELETE FROM meta WHERE key LIKE ? AND substr(value, 1, 10) < date('now', '-7 day')`).run(
    `${HOST_SESSION_PREFIX}%`,
  );
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(`${HOST_SESSION_PREFIX}${host}`, `${new Date().toISOString()}|${sessionId}`);
}

export function hostSession(db: DB): string | null {
  const host = hostKey();
  if (host) {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`${HOST_SESSION_PREFIX}${host}`) as
      | { value: string }
      | undefined;
    const id = row?.value.slice(row.value.indexOf('|') + 1);
    if (id) return id;
  }
  return envValue('CLAUDE_CODE_SESSION_ID');
}

/**
 * The model cannot see its own Claude Code session id, but the Phase 2 hooks
 * receive the real one on stdin — so both sides have to agree on a resolution
 * order or the hooks query rows that were written under a different key
 * (phase-1 decision G1). The host's id comes before the checkout pointer:
 * see `hostSession`.
 */
export function resolveSessionId(db: DB, explicit?: string | null, cwd?: string | null): string {
  const candidate =
    (explicit && explicit.trim()) ||
    envValue('EKLAVYA_SESSION_ID') ||
    hostSession(db) ||
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
