import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig, type ResolvedConfig } from '../src/config.js';
import { flushAtSeam, record, replaySpool, SEAM_MAX_AGE_MS, SEAM_MIN_EVENTS } from '../src/hooks/memory-lib.js';
import type { EvidenceIdentity } from '../src/memory/identity.js';
import { drainSpool } from '../src/memory/capture.js';
import { spoolEvent, spoolPath, takeSpooled } from '../src/memory/spool.js';
import { appendEvent } from '../src/memory/store.js';
import { cleanup, tempDbPath } from './helpers.js';

const PROJECT = '/tmp/demo-repo';

let dbFile: string;
let db: DB;
let home: string;
let priorHome: string | undefined;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-seam');
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

const identity = (sessionId = 's1'): EvidenceIdentity => ({
  project: PROJECT,
  checkout: PROJECT,
  sessionId,
  agentId: null,
  host: 'claude-code',
});

function resolved(over: (c: EklavyaConfig) => void = () => {}): ResolvedConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  over(config);
  return { config } as unknown as ResolvedConfig;
}

let seq = 0;
function events(n: number, sessionId = 's1', ageMs = 0): void {
  const at = new Date(Date.now() - ageMs).toISOString();
  for (let i = 0; i < n; i++) {
    appendEvent(db, { eventUid: `e${seq++}`, project: PROJECT, sessionId, kind: 'tool_use', body: `ran step ${seq}`, occurredAt: at });
  }
}

const batches = (sessionId = 's1') =>
  (db.prepare('SELECT COUNT(*) AS n FROM memory_batches WHERE session_id = ?').get(sessionId) as { n: number }).n;
const open = (sessionId = 's1') =>
  (db.prepare("SELECT COUNT(*) AS n FROM evidence_events WHERE status = 'accepted' AND session_id = ?").get(sessionId) as {
    n: number;
  }).n;

describe('a Stop seam closes a batch only once it is worth a summary', () => {
  it('leaves a short, fresh turn open, so a two-event turn is not a model call', async () => {
    events(2);
    await flushAtSeam(db, resolved(), identity());
    expect(batches()).toBe(0);
    expect(open()).toBe(2);
  });

  it('closes once enough events have accumulated', async () => {
    events(SEAM_MIN_EVENTS);
    await flushAtSeam(db, resolved(), identity());
    expect(batches()).toBe(1);
    expect(open()).toBe(0);
  });

  it('closes a small batch once its oldest event is old enough', async () => {
    events(1, 's1', SEAM_MAX_AGE_MS + 60_000);
    events(1);
    await flushAtSeam(db, resolved(), identity());
    expect(batches()).toBe(1);
    expect(open()).toBe(0);
  });

  it('flushes everything when asked to, however small', async () => {
    events(1);
    await flushAtSeam(db, resolved(), identity(), { all: true });
    expect(batches()).toBe(1);
  });

  it('closes an abandoned session\'s leftovers at another session\'s seam, and leaves a live one alone', async () => {
    events(2, 'dead', SEAM_MAX_AGE_MS + 60_000);
    events(2, 'live');
    await flushAtSeam(db, resolved(), identity('s1'));
    expect(batches('dead')).toBe(1);
    expect(batches('live')).toBe(0);
  });

  it('a session start flushes every session in the project, so nothing is stranded', async () => {
    events(2, 'yesterday');
    await flushAtSeam(db, resolved(), identity('today'), { all: true });
    expect(batches('yesterday')).toBe(1);
    expect(open('yesterday')).toBe(0);
  });

  it('the local summariser follows the same rule: no observation for a two-event turn', async () => {
    events(2);
    await flushAtSeam(db, resolved(), identity());
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number }).n).toBe(0);
    events(SEAM_MIN_EVENTS);
    await flushAtSeam(db, resolved(), identity());
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number }).n).toBe(1);
  });
});

describe('the spool stays bounded when replay keeps failing', () => {
  // A database that opens but refuses every write (read-only, disk full): each
  // seam claims the spool and fails on its first record, never calling commit.
  it('does not claim a new file while an earlier claim is still unreplayed', () => {
    spoolEvent({ n: 1 });
    takeSpooled(); // claimed, never committed
    spoolEvent({ n: 2 });
    const second = takeSpooled();
    const dir = path.dirname(spoolPath());
    expect(fs.readdirSync(dir).filter((f) => f.includes('.taking-'))).toHaveLength(1);
    // The fresh event waits in the live file, and the old claim comes back.
    expect(fs.existsSync(spoolPath())).toBe(true);
    expect(second.records).toEqual([{ n: 1 }]);
    second.commit();
    expect(takeSpooled().records).toEqual([{ n: 2 }]);
  });

  it('is not wedged by a claim that can never be read', () => {
    fs.mkdirSync(`${spoolPath()}.taking-999-1`, { recursive: true }); // a directory, not a file
    spoolEvent({ n: 1 });
    const taken = takeSpooled();
    expect(taken.records).toEqual([{ n: 1 }]);
    taken.commit();
    expect(fs.existsSync(spoolPath())).toBe(false);
  });

  it('counts claimed files against the cap, so a stuck replay cannot grow the spool without end', () => {
    const dir = path.dirname(spoolPath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${spoolPath()}.taking-1-1`, 'x'.repeat(4 * 1024 * 1024 + 1));
    expect(spoolEvent({ n: 1 })).toBe('dropped');
    expect(fs.existsSync(spoolPath())).toBe(false);
  });
});

describe('a busy database spools the event instead of losing it', () => {
  it('spools while another writer holds the lock, and replays once it is free', () => {
    db.pragma('busy_timeout = 50');
    const other = new Database(dbFile);
    other.exec('BEGIN IMMEDIATE');
    try {
      record(db, resolved(), identity(), { kind: 'prompt', body: 'rotate the refresh tokens' });
      expect(fs.existsSync(spoolPath())).toBe(true);
      expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_events').get() as { n: number }).n).toBe(0);
    } finally {
      other.exec('ROLLBACK');
      other.close();
    }
    replaySpool(db);
    const rows = db.prepare('SELECT body FROM evidence_events').all() as { body: string }[];
    expect(rows.map((r) => r.body)).toEqual(['rotate the refresh tokens']);
    expect(fs.existsSync(spoolPath())).toBe(false);
  });

  it('creates the spool readable by its owner only', () => {
    if (process.platform === 'win32') return;
    spoolEvent({ eventUid: 'x', project: PROJECT });
    expect(fs.statSync(spoolPath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(spoolPath())).mode & 0o077).toBe(0);
  });

  it('replays a spool a crashed drain left half-taken', () => {
    // What a drain that died after claiming the file, before finishing, leaves.
    const record = { eventUid: 'crashed', project: PROJECT, sessionId: 's1', kind: 'tool_use', body: 'left behind' };
    fs.mkdirSync(path.dirname(spoolPath()), { recursive: true });
    fs.writeFileSync(`${spoolPath()}.taking-99999-1`, `${JSON.stringify(record)}\n`);
    expect(drainSpool(db)).toEqual({ replayed: 1, skipped: 0 });
    expect(fs.readdirSync(path.dirname(spoolPath())).filter((f) => f.includes('taking'))).toEqual([]);
    expect(drainSpool(db)).toEqual({ replayed: 0, skipped: 0 });
  });

  it('keeps a spooled event on disk when the replay itself fails', () => {
    const record = { eventUid: 'kept', project: PROJECT, sessionId: 's1', kind: 'tool_use', body: 'keep me' };
    spoolEvent(record);
    const closedFile = tempDbPath('eklavya-closed');
    const closed = openDb(closedFile);
    closed.close();
    // A closed handle throws on every statement — the drain must not delete
    // what it could not write.
    expect(() => drainSpool(closed)).not.toThrow();
    cleanup(closedFile);
    expect(drainSpool(db)).toEqual({ replayed: 1, skipped: 0 });
  });
});
