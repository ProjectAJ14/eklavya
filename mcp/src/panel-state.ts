import type { DB } from './db.js';
import { isCowork } from './surface.js';

/**
 * What the hooks and the planner need to know about the side panel, and nothing
 * else: whether this session's host showed up recently, and whether a question
 * is already waiting. Kept apart from `panel.ts` so a hook can read it without
 * loading the recorder (zod, the grading code) behind `panelAnswer`.
 *
 * The panel is a Claude Code mod, and a mod being installed proves nothing. The
 * mod says it is alive by calling `panel_sync` on lifecycle events, which stamps
 * a heartbeat here. A question is presented in the panel only when the setting
 * is on and that heartbeat is fresh; any doubt keeps today's question card.
 */

/** How long after its last `panel_sync` a mod still counts as present. */
export const PANEL_HEARTBEAT_TTL_MS = 90_000;

/**
 * Host surfaces the planner may present the panel on. The terminal was verified
 * (docs/verified-schemas.md); the Desktop Code tab is enabled but not yet
 * observed. It is safe to try: a host that cannot seat the pane reports
 * `placed: false` and the question stays on the card, and a host that never
 * loads the mod never stamps a heartbeat.
 */
export const PANEL_SURFACES: readonly string[] = ['terminal', 'desktop'];

/** The phases in which a question is still waiting for its answer. */
export const OPEN_PHASES = "('pending','unplaced','grading')";

/** An unanswered question stops being open after this long (`panel.ts` expires it). */
export const PANEL_EXPIRY_HOURS = 24;

const heartbeatKey = (sessionId: string): string => `panel_hb:${sessionId}`;

interface Heartbeat {
  at: string;
  surface: string;
  /** False only while the last placement report said the host could not seat the pane. */
  placed: boolean;
}

export interface HostReport {
  version?: string;
  surface: string;
  columns?: number;
}

/**
 * Stamps the heartbeat for a session. `placed` is the mod's latest word on
 * whether the host could seat the pane; a sync that carries none keeps the last.
 */
export function recordHeartbeat(db: DB, sessionId: string, host: HostReport, placed: boolean | undefined, now = new Date()): void {
  const before = readHeartbeat(db, sessionId);
  const beat: Heartbeat = { at: now.toISOString(), surface: host.surface, placed: placed ?? before?.placed ?? true };
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(heartbeatKey(sessionId), JSON.stringify(beat));
  // A session's heartbeat means nothing a day later; drop the stale ones as they
  // are written rather than let one row per session pile up.
  db.prepare("DELETE FROM meta WHERE key LIKE 'panel_hb:%' AND json_extract(value, '$.at') < ?").run(
    new Date(now.getTime() - PANEL_EXPIRY_HOURS * 3600_000).toISOString(),
  );
}

function readHeartbeat(db: DB, sessionId: string): Heartbeat | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(heartbeatKey(sessionId)) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Heartbeat) : null;
}

/**
 * Where this session's next question goes. `panel` only when the setting is on,
 * the host reported in within `PANEL_HEARTBEAT_TTL_MS` from a surface known to
 * work, and its last placement did not fail. Everything else, including Cowork and a
 * database that predates the panel, is the question card.
 */
export function panelPresentation(db: DB, config: { quiz: { panel: boolean } }, sessionId: string, now = new Date()): 'panel' | 'tool' {
  if (!config.quiz.panel || isCowork()) return 'tool';
  try {
    const beat = readHeartbeat(db, sessionId);
    if (!beat || !beat.placed || !PANEL_SURFACES.includes(beat.surface)) return 'tool';
    return now.getTime() - Date.parse(beat.at) <= PANEL_HEARTBEAT_TTL_MS ? 'panel' : 'tool';
  } catch {
    return 'tool';
  }
}

/**
 * Is a panel question already waiting for this session? The hooks go quiet when
 * one is: it is the outstanding question. Read-only, and false for a database
 * that has no `panel_questions` yet (a hook never migrates).
 */
export function hasOpenPanelQuestion(db: DB, sessionId: string): boolean {
  try {
    return (
      db
        .prepare(
          `SELECT 1 FROM panel_questions
            WHERE session_id = ? AND phase IN ${OPEN_PHASES} AND created_at >= datetime('now', ?) LIMIT 1`,
        )
        .get(sessionId, `-${PANEL_EXPIRY_HOURS} hours`) !== undefined
    );
  } catch {
    return false;
  }
}

/**
 * The explicit round a learner asked for (a topic quiz, `max` questions): the
 * slugs still to ask, in order. The planner saves it when it plans a round for
 * the panel, `present_question` takes each question off it, and Next resumes it,
 * so the round keeps its topic and its length across the questions and the last
 * one is known to be last. Stored in `meta`, so it needs no migration.
 */
const roundKey = (sessionId: string): string => `panel_round:${sessionId}`;

export function saveRound(db: DB, sessionId: string, queue: string[], now = new Date()): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(roundKey(sessionId), JSON.stringify({ at: now.toISOString(), queue }));
}

export function clearRound(db: DB, sessionId: string): void {
  db.prepare('DELETE FROM meta WHERE key = ?').run(roundKey(sessionId));
}

/** The slugs still to ask, or null when no round is running (or it is a day old). */
export function loadRound(db: DB, sessionId: string, now = new Date()): string[] | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(roundKey(sessionId)) as { value: string } | undefined;
  if (!row) return null;
  const round = JSON.parse(row.value) as { at: string; queue: string[] };
  return now.getTime() - Date.parse(round.at) <= PANEL_EXPIRY_HOURS * 3600_000 ? round.queue : null;
}

/**
 * Takes `slug` off the round as it is presented. Returns whether more remain,
 * or null when `slug` is not part of a running round (the caller's own `more`
 * then stands).
 */
export function advanceRound(db: DB, sessionId: string, slug: string): boolean | null {
  const queue = loadRound(db, sessionId);
  if (!queue || !queue.includes(slug)) return null;
  const rest = queue.filter((s) => s !== slug);
  if (rest.length > 0) saveRound(db, sessionId, rest);
  else clearRound(db, sessionId);
  return rest.length > 0;
}
