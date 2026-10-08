import type { Database } from 'better-sqlite3';
import type { EklavyaConfig } from './config.js';

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
