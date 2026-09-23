import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig, type ResolvedConfig } from '../src/config.js';
import { flushAtSeam } from '../src/hooks/memory-lib.js';
import type { EvidenceIdentity } from '../src/memory/identity.js';
import { addCandidate, appendEvent, entryEvents, insertEntry, recordReceipt } from '../src/memory/store.js';
import { pruneEvidence, pruneIfDue } from '../src/memory/worker.js';
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

    expect(pruneEvidence(db, config())).toBe(1);

    expect(uids()).toEqual(['young']);
    expect(count('SELECT COUNT(*) AS n FROM memory_entries WHERE id = ?', entry)).toBe(1);
    // The drill-down shrinks to what is left rather than failing.
    expect(entryEvents(db, entry).map((e) => e.event_uid)).toEqual(['young']);
    expect(count('SELECT COUNT(*) AS n FROM memory_entry_events WHERE event_id = ?', cited)).toBe(0);
  });

  it('never deletes evidence that has not been summarised yet, however old', () => {
    event('accepted', ago(30), 'accepted');
    event('batched', ago(30), 'batched');
    expect(pruneEvidence(db, config())).toBe(0);
    expect(uids()).toEqual(['accepted', 'batched']);
  });

  it('keeps a concept candidate when the event it came from ages out', () => {
    const old = event('old', ago(30));
    const candidate = addCandidate(db, { eventId: old, slug: 'x', name: 'X', domain: 'd', confidence: 0.5, project: PROJECT });
    pruneEvidence(db, config());
    const row = db.prepare('SELECT event_id FROM learning_sources WHERE id = ?').get(candidate) as
      | { event_id: number | null }
      | undefined;
    expect(row).toEqual({ event_id: null });
  });

  it('does nothing at all when retention is unset', () => {
    event('old', ago(3000));
    expect(pruneEvidence(db, config(null))).toBe(0);
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

    pruneEvidence(db, config());

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
    expect(pruneEvidence(db, config(), { limit: 3 })).toBe(3);
    expect(count("SELECT COUNT(*) AS n FROM meta WHERE key = 'memory_pruned_at'")).toBe(0);
    expect(pruneEvidence(db, config(), { limit: 3 })).toBe(2);
    expect(count("SELECT COUNT(*) AS n FROM meta WHERE key = 'memory_pruned_at'")).toBe(1);
  });
});

describe('pruneIfDue', () => {
  it('runs at most once per interval', () => {
    event('a', ago(30));
    expect(pruneIfDue(db, config())).toBe(1);
    event('b', ago(30));
    expect(pruneIfDue(db, config())).toBe(0);
    expect(uids()).toEqual(['b']);
    // A stamp older than the interval lets the next seam run again.
    db.prepare("UPDATE meta SET value = ? WHERE key = 'memory_pruned_at'").run(ago(1));
    expect(pruneIfDue(db, config())).toBe(1);
  });

  it('never runs without retention set', () => {
    event('a', ago(30));
    expect(pruneIfDue(db, config(null))).toBe(0);
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
