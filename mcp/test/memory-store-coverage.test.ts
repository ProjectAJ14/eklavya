import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import {
  addCandidate,
  appendEvent,
  deleteEntry,
  entryById,
  eventsForSession,
  failJob,
  insertEntry,
  pendingCandidates,
  receiptTotals,
  recordReceipt,
  replaceEntry,
  timeline,
  type EvidenceInput,
} from '../src/memory/store.js';

const P = '/tmp/store-cov';
let dbFile: string;
let db: DB;
beforeEach(() => {
  dbFile = tempDbPath('eklavya-store-cov');
  db = openDb(dbFile);
});
afterEach(() => {
  db.close();
  cleanup(dbFile);
});

const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('evidence', () => {
  it('lists a session newest first, up to the limit', () => {
    for (const [uid, at] of [['a', '2026-01-01'], ['b', '2026-01-03'], ['c', '2026-01-02']]) {
      appendEvent(db, { eventUid: uid, project: P, sessionId: 's', kind: 'note', body: uid, occurredAt: at });
    }
    appendEvent(db, { eventUid: 'other', project: P, sessionId: 'x', kind: 'note', body: 'x' });
    expect(eventsForSession(db, 's').map((e) => e.event_uid)).toEqual(['b', 'c', 'a']);
    expect(eventsForSession(db, 's', 1).map((e) => e.event_uid)).toEqual(['b']);
  });

  it('reports id 0 when a row is ignored for a reason other than its uid', () => {
    // INSERT OR IGNORE also swallows a NOT NULL violation, leaving no row to find.
    const bad = { eventUid: 'nobody', project: P, sessionId: 's', kind: 'note', body: null } as unknown as EvidenceInput;
    expect(appendEvent(db, bad)).toEqual({ id: 0, inserted: false });
    expect(count('evidence_events')).toBe(0);
  });
});

describe('jobs', () => {
  it('treats failing an unknown job as a no-op', () => {
    expect(() => failJob(db, 999, 'me', 'transient', 'boom')).not.toThrow();
    expect(count('memory_jobs')).toBe(0);
  });
});

describe('entries', () => {
  it('replaces an entry with an empty narrative when none is given', () => {
    const id = insertEntry(db, { project: P, title: 'First', narrative: 'old words' });
    replaceEntry(db, id, { project: P, title: 'Second' });
    expect(entryById(db, id)).toMatchObject({ title: 'Second', narrative: '' });
  });

  it('hard-deletes the row and its derived index', () => {
    const id = insertEntry(db, { project: P, title: 'Gone for good' });
    expect(count('memory_vectors')).toBe(1);
    deleteEntry(db, id, true);
    expect(entryById(db, id)).toBeUndefined();
    expect(count('memory_vectors')).toBe(0);
  });

  it('filters the timeline by type and window, and shows deleted rows only on request', () => {
    const a = insertEntry(db, { project: P, title: 'a', type: 'feature', occurredAt: '2026-01-01T00:00:00.000Z' });
    const b = insertEntry(db, { project: P, title: 'b', type: 'bugfix', occurredAt: '2026-02-01T00:00:00.000Z' });
    const c = insertEntry(db, { project: P, title: 'c', type: 'feature', occurredAt: '2026-03-01T00:00:00.000Z' });
    expect(timeline(db, { type: 'feature' }).map((e) => e.id)).toEqual([c, a]);
    expect(timeline(db, { since: '2026-01-15', until: '2026-02-15' }).map((e) => e.id)).toEqual([b]);
    deleteEntry(db, b);
    expect(timeline(db).map((e) => e.id)).toEqual([c, a]);
    expect(timeline(db, { includeDeleted: true }).map((e) => e.id)).toEqual([c, b, a]);
  });
});

describe('receipts and candidates', () => {
  it('limits receipt totals to a recent window', () => {
    const recent = recordReceipt(db, { project: P, scope: 'session_start', method: 'm', delivery: 'confirmed', items: [] });
    const old = recordReceipt(db, { project: P, scope: 'session_start', method: 'm', delivery: 'confirmed', items: [] });
    db.prepare("UPDATE context_receipts SET created_at = datetime('now', '-30 days') WHERE id = ?").run(old);
    expect(recent).not.toBe(old);
    expect(receiptTotals(db, P).receipts).toBe(2);
    expect(receiptTotals(db, P, 7).receipts).toBe(1);
  });

  it('lists pending candidates across every project when none is named', () => {
    addCandidate(db, { slug: 'a', name: 'a', domain: 'd', confidence: 0.5, project: P });
    addCandidate(db, { slug: 'b', name: 'b', domain: 'd', confidence: 0.9, project: '/tmp/other' });
    expect(pendingCandidates(db).map((c) => c.slug)).toEqual(['b', 'a']);
    expect(pendingCandidates(db, null, 1).map((c) => c.slug)).toEqual(['b']);
  });
});
