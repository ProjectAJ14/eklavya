import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import {
  FEEDBACK_RUBRIC,
  acknowledgeFeedback,
  deleteFeedback,
  feedbackEnabled,
  feedbackPending,
  insertFeedback,
  type NewFeedback,
} from '../src/feedback.js';
import { cleanup, tempDbPath } from './helpers.js';

let dbFile = '';
afterEach(() => {
  if (dbFile) cleanup(dbFile);
  dbFile = '';
});

const item = (over: Partial<NewFeedback> = {}): NewFeedback => ({
  session_id: 's1',
  project: '/work/app',
  event_id: 7,
  prompt: 'fix the login bug',
  review: { worked: 'ok', gaps: [{ area: 'outcome', missing: 'No goal.' }] },
  better: 'Fix the login bug in [the file].',
  tips: ['Say what fixed looks like'],
  model: 'sonnet',
  ...over,
});

const open = () => {
  dbFile = tempDbPath('feedback');
  return openDb(dbFile);
};

describe('feedbackEnabled', () => {
  const cfg = (feedback: boolean, memory: boolean): EklavyaConfig => ({
    ...DEFAULT_CONFIG,
    feedback: { enabled: feedback },
    memory: { ...DEFAULT_CONFIG.memory, enabled: memory },
  });
  it('is off by default', () => expect(feedbackEnabled(DEFAULT_CONFIG)).toBe(false));
  it('needs both switches', () => {
    expect(feedbackEnabled(cfg(true, true))).toBe(true);
    expect(feedbackEnabled(cfg(true, false))).toBe(false);
    expect(feedbackEnabled(cfg(false, true))).toBe(false);
  });
});

describe('the one-pending gate', () => {
  it('has nothing pending on a fresh database', () => {
    expect(feedbackPending(open())).toBeNull();
  });

  it('stores an item and reads it back parsed', () => {
    const db = open();
    const id = insertFeedback(db, item());
    expect(id).toBeTypeOf('number');
    const row = feedbackPending(db)!;
    expect(row.id).toBe(id);
    expect(row.rubric).toBe(FEEDBACK_RUBRIC);
    expect(row.tips).toEqual(['Say what fixed looks like']);
    expect(row.review.gaps).toEqual([{ area: 'outcome', missing: 'No goal.' }]);
    expect(row.acknowledged_at).toBeNull();
  });

  it('refuses a second item while one is pending', () => {
    const db = open();
    expect(insertFeedback(db, item())).not.toBeNull();
    expect(insertFeedback(db, item({ session_id: 's2' }))).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_items').get()).toEqual({ n: 1 });
  });

  it('leaves exactly one row when two connections insert at once', () => {
    const a = open();
    const b = new Database(dbFile);
    const results = [insertFeedback(a, item()), insertFeedback(b, item({ session_id: 's2' }))];
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(a.prepare('SELECT COUNT(*) AS n FROM feedback_items').get()).toEqual({ n: 1 });
    b.close();
  });

  it('lets a new item in once the pending one is acknowledged', () => {
    const db = open();
    const id = insertFeedback(db, item())!;
    expect(acknowledgeFeedback(db, id)).toBe('acknowledged');
    expect(feedbackPending(db)).toBeNull();
    expect(insertFeedback(db, item({ session_id: 's2' }))).not.toBeNull();
  });

  it('acknowledges once: a repeat is "already" and writes nothing', () => {
    const db = open();
    const id = insertFeedback(db, item())!;
    expect(acknowledgeFeedback(db, id)).toBe('acknowledged');
    const first = db.prepare('SELECT acknowledged_at FROM feedback_items WHERE id = ?').get(id);
    db.prepare("UPDATE feedback_items SET acknowledged_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
    expect(acknowledgeFeedback(db, id)).toBe('already');
    expect(db.prepare('SELECT acknowledged_at FROM feedback_items WHERE id = ?').get(id)).toEqual({
      acknowledged_at: '2020-01-01 00:00:00',
    });
    expect(first).not.toEqual({ acknowledged_at: null });
  });

  it('says not_found for an id that does not exist', () => {
    expect(acknowledgeFeedback(open(), 999)).toBe('not_found');
  });

  it('deleting the pending item unblocks the next, and is not an acknowledgement', () => {
    const db = open();
    const id = insertFeedback(db, item())!;
    expect(deleteFeedback(db, id)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_items WHERE acknowledged_at IS NOT NULL').get()).toEqual({ n: 0 });
    expect(insertFeedback(db, item({ session_id: 's2' }))).not.toBeNull();
    expect(deleteFeedback(db, 12345)).toBe(false);
  });

  it('reads as nothing pending when the table does not exist', () => {
    const bare = new Database(':memory:');
    expect(feedbackPending(bare)).toBeNull();
    bare.close();
  });
});

describe('mastery guard', () => {
  const GRADING = ['mastery', 'attempts', 'project_levels', 'gates', 'concepts', 'session_concepts', 'checkpoints'];
  const snapshot = (db: Database.Database) =>
    Object.fromEntries(
      GRADING.map((t) => [
        t,
        crypto.createHash('sha256').update(JSON.stringify(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())).digest('hex'),
      ]),
    );

  it('leaves every grading table untouched through insert, acknowledge and delete', () => {
    const db = open();
    const before = snapshot(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM concepts').get()).not.toEqual({ n: 0 });
    const id = insertFeedback(db, item())!;
    acknowledgeFeedback(db, id);
    const second = insertFeedback(db, item({ session_id: 's2' }))!;
    deleteFeedback(db, second);
    expect(snapshot(db)).toEqual(before);
  });
});
