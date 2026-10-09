import type { spawn as nodeSpawn } from 'node:child_process';
import type { Database } from 'better-sqlite3';
import type { EklavyaConfig } from './config.js';
import { ProviderError } from './memory/provider.js';
import { ownWords } from './memory/recall.js';
import { reviewPrompts, REVIEW_LIMIT } from './feedback-review.js';
import { runtimeCli } from './update.js';
import { HELPERS, HOST_PROMPT, SLASH, TASK_PROMPT_CHARS } from './prompt-text.js';

/**
 * Prompt feedback: a review of one of the developer's own prompts, one item at
 * a time. This module is the only writer and reader of `feedback_items`, so the
 * one-pending rule lives in one place. Nothing here touches attempts, mastery,
 * gates or concepts; the table has no foreign key to them.
 */

/** Which wording of the rubric an item was written against. */
export const FEEDBACK_RUBRIC = 1;

export type DimensionStatus = 'strong' | 'mixed' | 'missing' | 'not_visible';

export interface Dimension {
  status: DimensionStatus;
  note: string;
  /** A quote from a later prompt; required for Discernment and Diligence unless `not_visible`. */
  evidence?: string;
}

export interface FeedbackReview {
  delegation: Dimension;
  description: Dimension;
  discernment: Dimension;
  diligence: Dimension;
  judged_from: 'prompt';
}

export interface NewFeedback {
  session_id: string;
  project: string;
  event_id: number | null;
  prompt: string;
  review: FeedbackReview;
  better: string;
  tips: string[];
  model: string;
}

export interface FeedbackRow extends Omit<NewFeedback, 'review' | 'tips'> {
  id: number;
  review: FeedbackReview;
  tips: string[];
  rubric: number;
  created_at: string;
  acknowledged_at: string | null;
}

interface RawRow extends Omit<FeedbackRow, 'review' | 'tips'> {
  review: string;
  tips: string;
}

const parse = (r: RawRow): FeedbackRow => ({ ...r, review: JSON.parse(r.review), tips: JSON.parse(r.tips) });

/**
 * The single place the switch and its dependency are combined. Feedback reads
 * the memory the developer chose to keep, so with memory off it is off.
 */
export function feedbackEnabled(config: EklavyaConfig): boolean {
  return config.feedback.enabled && config.memory.enabled;
}

/** The pending item, or null. A database from before the table existed has none. */
export function feedbackPending(db: Database): FeedbackRow | null {
  try {
    const row = db.prepare('SELECT * FROM feedback_items WHERE acknowledged_at IS NULL').get() as RawRow | undefined;
    return row ? parse(row) : null;
  } catch {
    return null;
  }
}

/**
 * Whether an item is waiting, as one cheap indexed read for the greeting, which
 * must never fail: an older schema or an unreadable database means no.
 */
export function feedbackWaiting(db: Database): boolean {
  try {
    return db.prepare('SELECT 1 FROM feedback_items WHERE acknowledged_at IS NULL LIMIT 1').get() !== undefined;
  } catch {
    return false;
  }
}

/**
 * Stores an item unless one is already pending. The check and the insert are
 * one statement, so a second writer loses instead of making a second pending
 * item; the unique index is the backstop for any writer that bypasses this.
 */
export function insertFeedback(db: Database, item: NewFeedback): number | null {
  const info = db
    .prepare(
      `INSERT INTO feedback_items (session_id, project, event_id, prompt, review, better, tips, rubric, model)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM feedback_items WHERE acknowledged_at IS NULL)`,
    )
    .run(
      item.session_id, item.project, item.event_id, item.prompt, JSON.stringify(item.review),
      item.better, JSON.stringify(item.tips), FEEDBACK_RUBRIC, item.model,
    );
  return info.changes === 0 ? null : Number(info.lastInsertRowid);
}

/**
 * Acknowledged means one thing: the developer pressed the button and the server
 * saw the POST. A repeat changes nothing.
 */
export function acknowledgeFeedback(db: Database, id: number): 'acknowledged' | 'already' | 'not_found' {
  const info = db
    .prepare("UPDATE feedback_items SET acknowledged_at = datetime('now') WHERE id = ? AND acknowledged_at IS NULL")
    .run(id);
  if (info.changes > 0) return 'acknowledged';
  return db.prepare('SELECT 1 FROM feedback_items WHERE id = ?').get(id) ? 'already' : 'not_found';
}

/** Deleting the pending item unblocks the next; it is not counted as acknowledged. */
export function deleteFeedback(db: Database, id: number): boolean {
  return db.prepare('DELETE FROM feedback_items WHERE id = ?').run(id).changes > 0;
}

/** A session is read only once it has been quiet this long, so a live one is never reviewed. */
export const SETTLE_MINUTES = 30;
/** And only if it began within this many days: an old session is not worth a coaching note. */
export const WINDOW_DAYS = 14;
/** Sessions looked at in one run, so a long backlog of quiet ones is not one long scan. */
export const MAX_SESSIONS_PER_RUN = 5;

export type GenerateOutcome =
  | { status: 'off' | 'needs_memory' | 'needs_observer' | 'pending' | 'nothing' | 'later' | 'failed' }
  | { status: 'reviewed'; date: string };

interface Candidate {
  id: number;
  text: string;
}

/**
 * The prompts of one session worth reading: the developer's own words, long
 * enough to be a task, and neither a slash command nor something the host sent.
 * Host markup is stripped before the length check, so a pasted log around a
 * three-word ask does not qualify.
 */
function qualifyingPrompts(db: Database, project: string, sessionId: string): Candidate[] {
  const rows = db
    .prepare("SELECT id, body FROM evidence_events WHERE project = ? AND session_id = ? AND kind = 'prompt' ORDER BY occurred_at, id")
    .all(project, sessionId) as { id: number; body: string }[];
  return rows
    .filter((r) => !SLASH.test(r.body.trim()) && !HOST_PROMPT.test(r.body.trim()))
    .map((r) => ({ id: r.id, text: ownWords(r.body) }))
    .filter((c) => c.text.length >= TASK_PROMPT_CHARS)
    .slice(0, REVIEW_LIMIT.prompts)
    .map((c) => ({ id: c.id, text: c.text.slice(0, REVIEW_LIMIT.promptChars) }));
}

/** The failures a later start may get past: a login, a quota, a busy service, a missing install. */
const RETRY_LATER = new Set(['auth', 'quota', 'transient', 'missing', 'cancelled']);

/**
 * Reviews one prompt from the oldest reviewable session of `project`, or says
 * why not. One item per call: only one may be pending.
 *
 * Scoped to one project because the switch is: a project with feedback off must
 * not have its prompts sent because another project turned it on. Nothing is
 * written, and no model is called, while an item is pending.
 */
export async function generateFeedback(
  db: Database,
  config: EklavyaConfig,
  opts: { project: string; now?: Date; currentSession?: string | null; signal?: AbortSignal },
): Promise<GenerateOutcome> {
  if (!config.feedback.enabled) return { status: 'off' };
  if (!config.memory.enabled) return { status: 'needs_memory' };
  const observer = config.providers.observer;
  if (!observer) return { status: 'needs_observer' };
  if (feedbackPending(db)) return { status: 'pending' };

  const now = opts.now ?? new Date();
  const settled = new Date(now.getTime() - SETTLE_MINUTES * 60_000).toISOString();
  const earliest = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const sessions = db
    .prepare(
      `SELECT session_id, MIN(occurred_at) AS began FROM evidence_events
       WHERE project = ? AND session_id <> ? AND session_id NOT IN ${HELPERS}
         AND session_id NOT IN (SELECT session_id FROM feedback_reviewed)
       GROUP BY session_id
       HAVING datetime(MIN(occurred_at)) >= datetime(?) AND datetime(MAX(occurred_at)) <= datetime(?)
       ORDER BY MIN(occurred_at), session_id`,
    )
    .all(opts.project, opts.currentSession ?? '', earliest, settled) as { session_id: string; began: string }[];

  const mark = db.prepare('INSERT OR REPLACE INTO feedback_reviewed (session_id, outcome, detail) VALUES (?, ?, ?)');
  for (const s of sessions.slice(0, MAX_SESSIONS_PER_RUN)) {
    const prompts = qualifyingPrompts(db, opts.project, s.session_id);
    if (!prompts.length) {
      mark.run(s.session_id, 'nothing', null);
      continue;
    }
    let got;
    try {
      got = await reviewPrompts(observer.model, prompts.map((p) => p.text), { signal: opts.signal });
    } catch (err) {
      // `reviewPrompts` rejects only with a ProviderError (the call and the
      // validation both raise one), so the class is always there to read.
      if (RETRY_LATER.has((err as ProviderError).errorClass)) return { status: 'later' };
      const why = err as ProviderError;
      mark.run(s.session_id, 'failed', `${why.errorClass}: ${why.message}`.slice(0, 300));
      return { status: 'failed' };
    }
    const chosen = prompts[got.chosen - 1]!;
    const id = insertFeedback(db, {
      session_id: s.session_id,
      project: opts.project,
      event_id: chosen.id,
      prompt: chosen.text,
      review: got.review,
      better: got.better,
      tips: got.tips,
      model: observer.model,
    });
    // Another writer got there while the model was thinking: nothing is marked,
    // so this session is reviewed once the pending item is acknowledged.
    if (id === null) return { status: 'pending' };
    mark.run(s.session_id, 'item', null);
    return { status: 'reviewed', date: s.began.slice(0, 10) };
  }
  return { status: 'nothing' };
}

/** One start per this long, however many sessions begin. */
export const FEEDBACK_CLAIM_MS = 30 * 60_000;
const CLAIM_KEY = 'feedback_attempt_at';

/**
 * Called by SessionStart: starts the review in a detached process and never
 * waits for it, because a hook may not wait on inference. Claims first, as the
 * usage ping does, so two sessions starting together do not both spawn.
 * Silent on every failure; the next start tries again.
 *
 * `cwd` is the project's: the review is scoped to the project it runs in.
 * `spawn` and `now` are the caller's (the hook passes the real ones) so tests
 * never start a process.
 */
export function startBackgroundFeedback(
  db: Database,
  config: EklavyaConfig,
  opts: { cwd: string; spawn: typeof nodeSpawn; now: number },
): void {
  try {
    if (!feedbackEnabled(config) || !config.providers.observer) return;
    if (process.env.CI || process.env.VITEST) return;
    if (feedbackPending(db)) return;
    const { now } = opts;
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(CLAIM_KEY) as { value: string } | undefined;
    if (now - Date.parse(row?.value ?? '') < FEEDBACK_CLAIM_MS) return;
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      CLAIM_KEY,
      new Date(now).toISOString(),
    );
    const child = opts.spawn(process.execPath, [runtimeCli(), 'feedback', 'generate', '--background'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: opts.cwd,
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* retried at the next session start */
  }
}

/** The item, whatever its state, or null. Reading never acknowledges. */
export function getFeedback(db: Database, id: number): FeedbackRow | null {
  const row = db.prepare('SELECT * FROM feedback_items WHERE id = ?').get(id) as RawRow | undefined;
  return row ? parse(row) : null;
}

export interface FeedbackListRow {
  id: number;
  project: string;
  created_at: string;
  acknowledged_at: string;
  /** The first 80 characters only: the list is a table, the item page has the rest. */
  prompt: string;
  statuses: Record<'delegation' | 'description' | 'discernment' | 'diligence', DimensionStatus>;
}

/** Acknowledged items, newest first, one page. `project` narrows to one project's items. */
export function listAcknowledged(
  db: Database,
  q: { project: string | null; page: number; per: number },
): { total: number; page: number; pages: number; per: number; items: FeedbackListRow[] } {
  const per = Math.min(50, Math.max(1, Math.floor(q.per)));
  const scope = q.project ? 'AND project = ?' : '';
  const args = q.project ? [q.project] : [];
  const { n: total } = db
    .prepare(`SELECT COUNT(*) AS n FROM feedback_items WHERE acknowledged_at IS NOT NULL ${scope}`)
    .get(...args) as { n: number };
  const pages = Math.max(1, Math.ceil(total / per));
  const page = Math.min(pages, Math.max(1, Math.floor(q.page)));
  const rows = db
    .prepare(
      `SELECT * FROM feedback_items WHERE acknowledged_at IS NOT NULL ${scope}
       ORDER BY acknowledged_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, per, (page - 1) * per) as RawRow[];
  const items = rows.map((r) => {
    const row = parse(r);
    const { delegation, description, discernment, diligence } = row.review;
    return {
      id: row.id,
      project: row.project,
      created_at: row.created_at,
      acknowledged_at: row.acknowledged_at!,
      prompt: row.prompt.slice(0, 80),
      statuses: {
        delegation: delegation.status,
        description: description.status,
        discernment: discernment.status,
        diligence: diligence.status,
      },
    };
  });
  return { total, page, pages, per, items };
}

/**
 * What the dashboard's state payload says about feedback: switches, whether an
 * item is waiting (its id, never its text), how many were acknowledged, and
 * whether the last session looked at could not be reviewed. A database from
 * before the tables existed reads as nothing.
 */
export function feedbackSummary(db: Database, config: EklavyaConfig) {
  let pending: { id: number } | null = null;
  let acknowledged = 0;
  let failed = false;
  try {
    const row = feedbackPending(db);
    pending = row ? { id: row.id } : null;
    acknowledged = (db.prepare('SELECT COUNT(*) AS n FROM feedback_items WHERE acknowledged_at IS NOT NULL').get() as { n: number }).n;
    const last = db.prepare('SELECT outcome FROM feedback_reviewed ORDER BY reviewed_at DESC, rowid DESC LIMIT 1').get() as
      | { outcome: string }
      | undefined;
    failed = last?.outcome === 'failed';
  } catch {
    /* an older schema: nothing waiting */
  }
  return {
    enabled: config.feedback.enabled,
    memory: config.memory.enabled,
    observer: config.providers.observer !== null,
    pending,
    // Whether to ask for attention (the badge): a stale item left from before
    // feedback or memory was switched off waits quietly, and is still there to open.
    notify: pending !== null && feedbackEnabled(config),
    acknowledged,
    failed,
  };
}
