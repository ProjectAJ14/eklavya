import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import {
  FEEDBACK_RUBRIC,
  acknowledgeFeedback,
  deleteFeedback,
  TOPIC_CHARS,
  feedbackContext,
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
  it('is on by default for new installs', () => expect(feedbackEnabled(DEFAULT_CONFIG)).toBe(true));
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

describe('feedbackContext', () => {
  it('reads where and when the prompt was written from the session events, and degrades to nulls', () => {
    dbFile = tempDbPath('fbctx');
    const db = openDb(dbFile);
    const ins = db.prepare(
      "INSERT INTO evidence_events (event_uid, project, checkout, session_id, host, kind, body, occurred_at) VALUES (?, '/work/app', '/work/app-wt/x', 's1', 'claude-code', ?, 'b', ?)",
    );
    db.prepare("INSERT INTO evidence_events (event_uid, project, session_id, kind, body, occurred_at) VALUES ('t', '/work/app', 's1', 'prompt', 'fix the login bug, users cannot sign in', '2026-10-01T09:59:00Z')").run();
    ins.run('a', 'prompt', '2026-10-01T10:00:00Z');
    const id = Number(ins.run('b', 'prompt', '2026-10-01T10:05:00Z').lastInsertRowid);
    ins.run('c', 'tool_use', '2026-10-01T10:20:00Z');
    expect(feedbackContext(db, { session_id: 's1', project: '/work/app', event_id: id })).toEqual({
      session_id: 's1', prompted_at: '2026-10-01T10:05:00Z', checkout: '/work/app-wt/x', host: 'claude-code',
      began: '2026-10-01T09:59:00Z', ended: '2026-10-01T10:20:00Z', prompts: 3,
      topic: 'fix the login bug, users cannot sign in',
    });
    expect(feedbackContext(db, { session_id: 'gone', project: '/work/app', event_id: null })).toMatchObject({
      prompted_at: null, checkout: null, began: null, prompts: 0,
    });
    db.close();
  });

  it('cuts a long topic to TOPIC_CHARS with an ellipsis', () => {
    dbFile = tempDbPath('fbtopic');
    const db = openDb(dbFile);
    const long = 'refactor the payment client '.repeat(20);
    db.prepare("INSERT INTO evidence_events (event_uid, project, session_id, kind, body, occurred_at) VALUES ('l', '/work/app', 's1', 'prompt', ?, '2026-10-01T10:00:00Z')").run(long);
    const { topic } = feedbackContext(db, { session_id: 's1', project: '/work/app', event_id: null });
    expect(topic).toBe(`${long.trim().slice(0, TOPIC_CHARS)}…`);
    db.close();
  });

  it('returns the empty context instead of throwing when the events cannot be read', () => {
    const broken = { prepare: () => { throw new Error('no such table: evidence_events'); } } as unknown as Database.Database;
    expect(feedbackContext(broken, { session_id: 's9', project: '/work/app', event_id: 3 })).toEqual({
      session_id: 's9', prompted_at: null, checkout: null, host: null, began: null, ended: null, prompts: 0, topic: null,
    });
  });
});
