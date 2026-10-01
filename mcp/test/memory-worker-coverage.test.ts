import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { appendEvent, batchSession, insertEntry } from '../src/memory/store.js';
import { eventUid } from '../src/memory/identity.js';
import {
  flushSession,
  probeDue,
  processPending,
  sessionSoFar,
  standInWhilePaused,
  superviseWorker,
} from '../src/memory/worker.js';
import { reserveWorker } from '../src/memory/reservation.js';

/**
 * The worker's less travelled paths. Every `claude` is a shell script that
 * prints a canned envelope; no model is called.
 */

const posix = process.platform !== 'win32';
const PROJECT = '/work/cov-repo';
const LOCAL: EklavyaConfig = { ...DEFAULT_CONFIG, providers: { ...DEFAULT_CONFIG.providers, observer: null } };
const OBSERVED: EklavyaConfig = {
  ...DEFAULT_CONFIG,
  providers: { ...DEFAULT_CONFIG.providers, observer: { kind: 'anthropic', model: 'm' } },
};

let dbFile = '';
let db: DB;
let bin = '';
const origPath = process.env.PATH;
let seq = 0;

function event(kind: 'prompt' | 'assistant', body: string, sessionId = 's1'): void {
  seq += 1;
  appendEvent(db, {
    eventUid: eventUid({ host: 'claude-code', sessionId, kind, occurredAt: `t${seq}`, body }),
    project: PROJECT,
    sessionId,
    kind,
    body,
    occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
  });
}

function queue(sessionId = 's1', withAssistant = false): void {
  event('prompt', 'Add refresh token rotation to the auth client', sessionId);
  if (withAssistant) event('assistant', 'Rotation is in place and tested.', sessionId);
  batchSession(db, { project: PROJECT, sessionId, reason: 'session_seam' });
}

function fakeClaude(reply: unknown): void {
  const file = path.join(bin, 'reply.json');
  fs.writeFileSync(file, JSON.stringify(reply));
  fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\ncat "${file}"\n`, { mode: 0o755 });
}

/** `db`, with the statements or transactions `fail` names refused. */
function refusing(fail: { sql?: (sql: string) => boolean; transaction?: () => boolean }): DB {
  return new Proxy(db, {
    get(real, prop) {
      if (prop === 'prepare' && fail.sql) {
        return (sql: string) => {
          if (fail.sql!(sql)) throw new Error('database is locked');
          return real.prepare(sql);
        };
      }
      if (prop === 'transaction' && fail.transaction) {
        return (fn: () => unknown) => {
          if (fail.transaction!()) throw new Error('database is locked');
          return real.transaction(fn);
        };
      }
      const value = Reflect.get(real, prop, real) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
    },
  });
}

const jobs = () => db.prepare('SELECT status, attempts, last_error FROM memory_jobs ORDER BY id').all() as {
  status: string;
  attempts: number;
  last_error: string | null;
}[];
const holder = () => db.prepare("SELECT value FROM meta WHERE key = 'memory_worker'").get();

beforeEach(() => {
  dbFile = tempDbPath('eklavya-worker-cov');
  db = openDb(dbFile);
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-worker-cov-bin-'));
  process.env.PATH = `${bin}${path.delimiter}${origPath}`;
});

afterEach(() => {
  vi.useRealTimers();
  process.env.PATH = origPath;
  db.close();
  cleanup(dbFile);
  fs.rmSync(bin, { recursive: true, force: true });
});

describe('processPending', () => {
  it('does nothing once already cancelled', async () => {
    queue();
    const signal = AbortSignal.abort();
    expect(await processPending(db, LOCAL, { signal })).toMatchObject({ processed: 0, stopped: 'cancelled' });
    expect(jobs()).toEqual([{ status: 'pending', attempts: 0, last_error: null }]);
  });

  it('finishes a job whose batch has no evidence left, as skipped', async () => {
    queue();
    db.prepare('DELETE FROM evidence_events').run();
    expect(await processPending(db, LOCAL)).toMatchObject({ processed: 0, skipped: 1, stopped: 'empty' });
    expect(jobs()[0]!.status).toBe('done');
  });

  it('records a non-Error failure as text', async () => {
    queue();
    let thrown = false;
    const result = await processPending(db, LOCAL, {
      onJob: (id) => {
        if (id === null && !thrown) {
          thrown = true;
          throw 'status write refused';
        }
      },
    });
    expect(result).toMatchObject({ failed: 1, processed: 0 });
    expect(jobs()[0]).toMatchObject({ status: 'pending', last_error: 'status write refused' });
  });

  it.skipIf(!posix)('stores proposed concepts and a checkpoint without its empty sections', async () => {
    fakeClaude({
      subtype: 'success',
      is_error: false,
      structured_output: {
        observations: [
          {
            title: 'Rotated refresh tokens',
            type: 'feature',
            narrative: 'n',
            facts: [],
            files: [],
            tags: [],
            concepts: [{ slug: 'token-rotation', name: 'Token rotation', domain: 'security' }],
          },
        ],
        checkpoint: { request: 'Add rotation', investigated: '', learned: 'Refresh tokens are single use', completed: 'Rotation', next_steps: '' },
      },
    });
    queue('s1', true);
    expect(await processPending(db, OBSERVED)).toMatchObject({ processed: 1, entries: 1 });
    const candidates = db.prepare('SELECT slug, status FROM learning_sources').all();
    expect(candidates).toEqual([{ slug: 'token-rotation', status: 'candidate' }]);
    const summary = db
      .prepare("SELECT narrative FROM memory_entries WHERE kind = 'session_summary'")
      .get() as { narrative: string };
    expect(summary.narrative).toBe('Request: Add rotation\n\nLearned: Refresh tokens are single use\n\nCompleted: Rotation');
  });
});

describe('sessionSoFar', () => {
  it('lists an observation recorded without a type as a change', () => {
    insertEntry(db, {
      project: PROJECT,
      sessionId: 's1',
      kind: 'observation',
      type: null,
      title: 'Untyped work',
      narrative: 'n',
      facts: [],
      files: [],
      tags: [],
      generator: 'test',
      confidence: 0.5,
      eventIds: [],
    });
    expect(sessionSoFar(db, PROJECT, 's1')).toBe('Recorded so far:\n- change: Untyped work');
  });
});

describe('superviseWorker', () => {
  it('stops before any job when its signal was already aborted', async () => {
    queue();
    const token = reserveWorker(db)!;
    const result = await superviseWorker(db, token, LOCAL, {
      maxJobs: 2,
      loadConfig: () => LOCAL,
      signal: AbortSignal.abort(),
    });
    expect(result).toMatchObject({ processed: 0, stopped: 'cancelled', handedOff: false, released: true });
    expect(holder()).toBeUndefined();
  });

  it('keeps going on the last settings when they cannot be re-read', async () => {
    queue();
    const token = reserveWorker(db)!;
    const result = await superviseWorker(db, token, LOCAL, {
      maxJobs: 2,
      loadConfig: () => {
        throw new Error('config unreadable');
      },
    });
    expect(result).toMatchObject({ processed: 1, stopped: 'empty', released: true });
  });

  it.skipIf(!posix)('cancels the call, unspent, when it cannot record the provider process', async () => {
    fakeClaude({ subtype: 'success', is_error: false, structured_output: { observations: [] } });
    queue();
    const token = reserveWorker(db)!;
    let calls = 0;
    const result = await superviseWorker(db, token, OBSERVED, {
      maxJobs: 2,
      // After the pre-claim renew: the slot is lost before the call is recorded.
      loadConfig: () => {
        if (++calls === 1) db.prepare("DELETE FROM meta WHERE key = 'memory_worker'").run();
        return OBSERVED;
      },
      launch: () => false,
    });
    expect(result).toMatchObject({ processed: 0, failed: 0, stopped: 'cancelled', handedOff: false });
    expect(jobs()[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('gives up the run, and still releases, when claiming a job throws', async () => {
    queue();
    const token = reserveWorker(db)!;
    const flaky = refusing({ sql: (sql) => sql.startsWith('SELECT * FROM memory_jobs') });
    const result = await superviseWorker(flaky, token, LOCAL, { maxJobs: 2, loadConfig: () => LOCAL });
    expect(result).toMatchObject({ processed: 0, stopped: 'refused', released: true });
    expect(holder()).toBeUndefined();
    expect(jobs()[0]!.status).toBe('pending');
  });

  it('releases its own slot when the hand-off cannot be written', async () => {
    const token = reserveWorker(db)!;
    let calls = 0;
    let broken = false;
    const flaky = refusing({ transaction: () => broken });
    const launch = vi.fn(() => true);
    const result = await superviseWorker(flaky, token, OBSERVED, {
      maxJobs: 2,
      loadConfig: () => {
        // The second read is the hand-off's own check.
        if (++calls === 2) broken = true;
        return OBSERVED;
      },
      launch,
    });
    expect(result).toMatchObject({ stopped: 'empty', handedOff: false, released: true });
    expect(launch).not.toHaveBeenCalled();
    expect(holder()).toBeUndefined();
  });

  it('reports the slot unreleased when the database refuses the release for the whole retry window', async () => {
    vi.useFakeTimers();
    const token = reserveWorker(db)!;
    const flaky = refusing({ sql: (sql) => sql.includes("json_extract(value, '$.token')") });
    const run = superviseWorker(flaky, token, LOCAL, { maxJobs: 1, loadConfig: () => LOCAL });
    await vi.advanceTimersByTimeAsync(10_500);
    expect(await run).toMatchObject({ stopped: 'empty', handedOff: false, released: false });
    expect(holder()).toBeDefined();
  });
});

describe('seams', () => {
  it('flushSession batches the open session and drains it', async () => {
    event('prompt', 'Add refresh token rotation to the auth client');
    const result = await flushSession(db, LOCAL, PROJECT, 's1');
    expect(result).toMatchObject({ processed: 1, stopped: 'empty' });
    expect(jobs()[0]!.status).toBe('done');
  });

  it('probeDue says no when the database cannot answer', () => {
    const other = openDb(tempDbPath('eklavya-worker-cov-probe'));
    const file = other.name;
    other.close();
    expect(probeDue(other)).toBe(false);
    cleanup(file);
  });

  it('marks a waiting batch whose evidence is gone as stood in, without writing entries', async () => {
    queue();
    db.prepare('DELETE FROM evidence_events').run();
    expect(await standInWhilePaused(db)).toBe(1);
    const batch = db.prepare('SELECT summarizer FROM memory_batches').get() as { summarizer: string };
    expect(batch.summarizer).toBeTruthy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get()).toEqual({ n: 0 });
    // Stood in once: the next seam does not read it again.
    expect(await standInWhilePaused(db)).toBe(0);
  });
});
