import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig, type ResolvedConfig } from '../src/config.js';
import { flushAtSeam } from '../src/hooks/memory-lib.js';
import type { EvidenceIdentity } from '../src/memory/identity.js';
import { addCandidate, appendEvent, entryEvents, insertEntry, recordReceipt } from '../src/memory/store.js';
import { prunedKey, pruneEvidence, pruneIfDue } from '../src/memory/worker.js';
import { cleanup, tempDbPath } from './helpers.js';

/**
 * `memory.retention_days` is a promise about raw capture (PRD SEC-02): past
 * the window, what the tools saw is gone and only the distilled memory stays.
 * It used to delete nothing, because it spared every event an entry linked to
 * and every summariser links every event it read.
 */

const PROJECT = '/tmp/demo-repo';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

let dbFile: string;
let db: DB;
let home: string;
let priorHome: string | undefined;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-retention');
  db = openDb(dbFile);
  priorHome = process.env.EKLAVYA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  process.env.EKLAVYA_HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
  db.close();
  cleanup(dbFile);
});

function config(days: number | null = 7): EklavyaConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.memory.retention_days = days;
  return c;
}

function event(uid: string, occurredAt: string, status = 'summarized', sessionId = 's1'): number {
  const { id } = appendEvent(db, { eventUid: uid, project: PROJECT, sessionId, kind: 'tool_use', body: uid, occurredAt });
  db.prepare('UPDATE evidence_events SET status = ? WHERE id = ?').run(status, id);
  return id;
}

const uids = () =>
  (db.prepare('SELECT event_uid FROM evidence_events ORDER BY event_uid').all() as { event_uid: string }[]).map(
    (r) => r.event_uid,
  );
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

describe('pruneEvidence', () => {
  it('deletes old summarised evidence even when an entry cites it, and the entry survives', () => {
    const cited = event('cited', ago(30));
    const young = event('young', ago(1));
    const entry = insertEntry(db, { project: PROJECT, title: 'Cites both', eventIds: [cited, young] });

    expect(pruneEvidence(db, config(), { project: PROJECT })).toBe(1);

    expect(uids()).toEqual(['young']);
    expect(count('SELECT COUNT(*) AS n FROM memory_entries WHERE id = ?', entry)).toBe(1);
    // The drill-down shrinks to what is left rather than failing.
    expect(entryEvents(db, entry).map((e) => e.event_uid)).toEqual(['young']);
    expect(count('SELECT COUNT(*) AS n FROM memory_entry_events WHERE event_id = ?', cited)).toBe(0);
  });

  it('never deletes evidence that has not been summarised yet, however old', () => {
    event('accepted', ago(30), 'accepted');
    event('batched', ago(30), 'batched');
    expect(pruneEvidence(db, config(), { project: PROJECT })).toBe(0);
    expect(uids()).toEqual(['accepted', 'batched']);
  });

  it('keeps a concept candidate when the event it came from ages out', () => {
    const old = event('old', ago(30));
    const candidate = addCandidate(db, { eventId: old, slug: 'x', name: 'X', domain: 'd', confidence: 0.5, project: PROJECT });
    pruneEvidence(db, config(), { project: PROJECT });
    const row = db.prepare('SELECT event_id FROM learning_sources WHERE id = ?').get(candidate) as
      | { event_id: number | null }
      | undefined;
    expect(row).toEqual({ event_id: null });
  });

  it('does nothing at all when retention is unset', () => {
    event('old', ago(3000));
    expect(pruneEvidence(db, config(null), { project: PROJECT })).toBe(0);
    expect(uids()).toEqual(['old']);
  });

  it('removes finished jobs, old receipts and dead sessions\' recall rows, and keeps the live ones', () => {
    const batch = (created: string) =>
      Number(
        db
          .prepare("INSERT INTO memory_batches (project, session_id, reason, created_at) VALUES (?, 's', 'manual', ?)")
          .run(PROJECT, created).lastInsertRowid,
      );
    const job = (status: string, updated: string) =>
      db
        .prepare('INSERT INTO memory_jobs (batch_id, status, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(batch(updated), status, updated, updated);
    job('done', ago(30));
    job('done', ago(1));
    job('pending', ago(30));
    job('paused', ago(30));

    const entry = insertEntry(db, { project: PROJECT, title: 'x' });
    const oldReceipt = recordReceipt(db, {
      project: PROJECT, sessionId: 'dead', scope: 'session_start', method: 'm', delivery: 'confirmed',
      items: [{ entryId: entry, sourceTokens: 10, sentTokens: 1 }],
    });
    db.prepare('UPDATE context_receipts SET created_at = ? WHERE id = ?').run(ago(30), oldReceipt);
    recordReceipt(db, {
      project: PROJECT, sessionId: 'live', scope: 'session_start', method: 'm', delivery: 'confirmed',
      items: [{ entryId: entry, sourceTokens: 10, sentTokens: 1 }],
    });
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('recalled:dead', '1');
    meta.run('recalled:live', '1');
    meta.run('notified:session:dead:abc', JSON.stringify({ ok: true, n: 1, first: ago(30) }));
    meta.run('notified:session:live:abc', JSON.stringify({ ok: true, n: 1, first: ago(1) }));
    meta.run('notified:legacy-shape', 'not json');

    pruneEvidence(db, config(), { project: PROJECT });

    expect(
      (db.prepare('SELECT status FROM memory_jobs ORDER BY id').all() as { status: string }[]).map((r) => r.status),
    ).toEqual(['done', 'pending', 'paused']);
    expect(count('SELECT COUNT(*) AS n FROM context_receipts')).toBe(1);
    expect(count('SELECT COUNT(*) AS n FROM context_receipt_items WHERE receipt_id = ?', oldReceipt)).toBe(0);
    const keys = (db.prepare("SELECT key FROM meta WHERE key LIKE 'recalled:%' OR key LIKE 'notified:%' ORDER BY key").all() as {
      key: string;
    }[]).map((r) => r.key);
    expect(keys).toEqual(['notified:legacy-shape', 'notified:session:live:abc', 'recalled:live']);
    // The memory itself is never retention's to delete.
    expect(count('SELECT COUNT(*) AS n FROM memory_entries')).toBe(1);
  });

  it('stops at the limit and says so by leaving the stamp unwritten', () => {
    for (let i = 0; i < 5; i++) event(`old${i}`, ago(30));
    expect(pruneEvidence(db, config(), { project: PROJECT, limit: 3 })).toBe(3);
    expect(count('SELECT COUNT(*) AS n FROM meta WHERE key = ?', prunedKey(PROJECT))).toBe(0);
    expect(pruneEvidence(db, config(), { project: PROJECT, limit: 3 })).toBe(2);
    expect(count('SELECT COUNT(*) AS n FROM meta WHERE key = ?', prunedKey(PROJECT))).toBe(1);
  });
});

describe('pruneIfDue', () => {
  it('runs at most once per interval', () => {
    event('a', ago(30));
    expect(pruneIfDue(db, config(), PROJECT)).toBe(1);
    event('b', ago(30));
    expect(pruneIfDue(db, config(), PROJECT)).toBe(0);
    expect(uids()).toEqual(['b']);
    // A stamp older than the interval lets the next seam run again.
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(ago(1), prunedKey(PROJECT));
    expect(pruneIfDue(db, config(), PROJECT)).toBe(1);
  });

  it('never runs without retention set', () => {
    event('a', ago(30));
    expect(pruneIfDue(db, config(null), PROJECT)).toBe(0);
    expect(uids()).toEqual(['a']);
  });
});

describe('the session seam prunes by itself', () => {
  it('ages out evidence at a seam with retention set, and never without it', async () => {
    const identity: EvidenceIdentity = { project: PROJECT, checkout: PROJECT, sessionId: 's9', agentId: null, host: 'claude-code' };
    const resolved = (c: EklavyaConfig) => ({ config: c }) as unknown as ResolvedConfig;
    event('old', ago(30));

    await flushAtSeam(db, resolved(config(null)), identity);
    expect(uids()).toEqual(['old']);

    await flushAtSeam(db, resolved(config(7)), identity);
    expect(uids()).toEqual([]);
  });
});

/**
 * Retention is a project setting (`~/.eklavya/projects/<slug>/config.json`)
 * over one shared database, so a sweep run with one project's resolved config
 * may only touch that project's rows. It once deleted every project's
 * summarised evidence past A's window, including B's with retention unset.
 */
describe('retention is per project', () => {
  const A = '/tmp/project-a';
  const B = '/tmp/project-b';
  const ident = (project: string, sessionId = 'seam'): EvidenceIdentity =>
    ({ project, checkout: project, sessionId, agentId: null, host: 'claude-code' });
  const resolvedFor = (c: EklavyaConfig) => ({ config: c }) as unknown as ResolvedConfig;
  const at = (project: string, uid: string, occurredAt: string, status = 'summarized', sessionId = `${project}-s`) => {
    const { id } = appendEvent(db, { eventUid: uid, project, sessionId, kind: 'tool_use', body: uid, occurredAt });
    db.prepare('UPDATE evidence_events SET status = ? WHERE id = ?').run(status, id);
    return id;
  };
  const projectUids = (project: string) =>
    (db.prepare('SELECT event_uid FROM evidence_events WHERE project = ? ORDER BY event_uid').all(project) as {
      event_uid: string;
    }[]).map((r) => r.event_uid);

  it("A's seven-day policy at A's real seam removes A's old evidence and keeps B's", async () => {
    at(A, 'a-old', ago(30));
    at(A, 'a-young', ago(1));
    at(B, 'b-old', ago(30));

    await flushAtSeam(db, resolvedFor(config(7)), ident(A));

    expect(projectUids(A)).toEqual(['a-young']);
    expect(projectUids(B)).toEqual(['b-old']);
  });

  it("B's null retention keeps B's data, and B's seam deletes nothing of A's", async () => {
    at(A, 'a-old', ago(30));
    at(B, 'b-old', ago(3000));
    await flushAtSeam(db, resolvedFor(config(null)), ident(B));
    expect(projectUids(A)).toEqual(['a-old']);
    expect(projectUids(B)).toEqual(['b-old']);
  });

  it('keeps each project on its own schedule: a prune in A does not postpone B', () => {
    at(A, 'a-old', ago(30));
    at(B, 'b-old', ago(30));
    expect(pruneIfDue(db, config(7), A)).toBe(1);
    // A was just swept. B has never been, so B's own sweep is still due.
    expect(pruneIfDue(db, config(7), B)).toBe(1);
    at(A, 'a-old-2', ago(30));
    expect(pruneIfDue(db, config(7), A)).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM meta WHERE key = 'memory_pruned_at'")).toBe(0);
    expect(count("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'memory_pruned_at:%'")).toBe(2);
  });

  it('honours different windows per project', () => {
    at(A, 'a-10', ago(10));
    at(B, 'b-10', ago(10));
    pruneEvidence(db, config(7), { project: A });
    pruneEvidence(db, config(30), { project: B });
    expect(projectUids(A)).toEqual([]);
    expect(projectUids(B)).toEqual(['b-10']);
  });

  it('scopes jobs, receipts and session bookkeeping, and leaves what it cannot attribute', () => {
    const job = (project: string, updated: string) => {
      const batch = Number(
        db
          .prepare("INSERT INTO memory_batches (project, session_id, reason, created_at) VALUES (?, 's', 'manual', ?)")
          .run(project, updated).lastInsertRowid,
      );
      db.prepare("INSERT INTO memory_jobs (batch_id, status, created_at, updated_at) VALUES (?, 'done', ?, ?)").run(
        batch, updated, updated,
      );
    };
    job(A, ago(30));
    job(B, ago(30));

    const receipt = (project: string, sessionId: string) => {
      const entry = insertEntry(db, { project, sessionId, title: 'x' });
      const id = recordReceipt(db, {
        project, sessionId, scope: 'session_start', method: 'm', delivery: 'confirmed',
        items: [{ entryId: entry, sourceTokens: 10, sentTokens: 1 }],
      });
      db.prepare('UPDATE context_receipts SET created_at = ? WHERE id = ?').run(ago(30), id);
    };
    receipt(A, 'a-dead');
    receipt(B, 'b-dead');
    // A session whose only trace left is a meta row belongs to nobody provably.
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const s of ['a-dead', 'b-dead', 'orphan']) {
      meta.run(`recalled:${s}`, '1');
      meta.run(`notified:session:${s}:f`, JSON.stringify({ ok: true, n: 1, first: ago(30) }));
    }
    meta.run(`notified:queue-paused:${A}:auth:f`, JSON.stringify({ ok: true, n: 1, first: ago(30) }));
    meta.run(`notified:queue-paused:${B}:auth:f`, JSON.stringify({ ok: true, n: 1, first: ago(30) }));

    pruneEvidence(db, config(7), { project: A });

    const jobProjects = db
      .prepare('SELECT b.project FROM memory_jobs j JOIN memory_batches b ON b.id = j.batch_id')
      .all() as { project: string }[];
    expect(jobProjects.map((r) => r.project)).toEqual([B]);
    expect(
      (db.prepare('SELECT project FROM context_receipts').all() as { project: string }[]).map((r) => r.project),
    ).toEqual([B]);
    const keys = (db.prepare("SELECT key FROM meta WHERE key LIKE 'recalled:%' OR key LIKE 'notified:%' ORDER BY key").all() as {
      key: string;
    }[]).map((r) => r.key);
    expect(keys).toEqual([
      `notified:queue-paused:${B}:auth:f`,
      'notified:session:b-dead:f',
      'notified:session:orphan:f',
      'recalled:b-dead',
      'recalled:orphan',
    ]);
    // Entries are memory, not evidence: both projects keep theirs.
    expect(count('SELECT COUNT(*) AS n FROM memory_entries')).toBe(2);
  });

  it('leaves links and candidates valid, and a second run is a no-op', () => {
    const aOld = at(A, 'a-old', ago(30));
    const bOld = at(B, 'b-old', ago(30));
    const entryA = insertEntry(db, { project: A, title: 'A', eventIds: [aOld] });
    const entryB = insertEntry(db, { project: B, title: 'B', eventIds: [bOld] });
    const candA = addCandidate(db, { eventId: aOld, slug: 'a', name: 'A', domain: 'd', confidence: 0.5, project: A });
    const candB = addCandidate(db, { eventId: bOld, slug: 'b', name: 'B', domain: 'd', confidence: 0.5, project: B });

    expect(pruneEvidence(db, config(7), { project: A })).toBe(1);
    const snapshot = () => ({
      events: db.prepare('SELECT id, project FROM evidence_events ORDER BY id').all(),
      links: db.prepare('SELECT entry_id, event_id FROM memory_entry_events ORDER BY entry_id').all(),
      candidates: db.prepare('SELECT id, event_id FROM learning_sources ORDER BY id').all(),
    });
    const first = snapshot();
    expect(first.links).toEqual([{ entry_id: entryB, event_id: bOld }]);
    expect(first.candidates).toEqual([
      { id: candA, event_id: null },
      { id: candB, event_id: bOld },
    ]);
    // Nothing dangles: every link and candidate points at a row that exists.
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(entryEvents(db, entryA)).toEqual([]);

    expect(pruneEvidence(db, config(7), { project: A })).toBe(0);
    expect(snapshot()).toEqual(first);
  });
});
