import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import {
  WORKER_LEASE_MS,
  groupAlive,
  handOffWorker,
  isInternalObserver,
  launchWorker,
  reserveWorker,
  startStamp,
  stopWorker,
  workerStatus,
} from '../src/memory/reservation.js';

const posix = process.platform !== 'win32';
let dbFile = '';
let db: DB;
const strays: ChildProcess[] = [];
const origExec = process.execPath;

const holderRow = () =>
  db.prepare("SELECT value FROM meta WHERE key = 'memory_worker'").get() as { value: string } | undefined;

function holder(fields: Record<string, unknown>): void {
  const now = Date.now();
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('memory_worker', ?)").run(
    JSON.stringify({
      token: 'hand-written',
      pid: null,
      child: null,
      job: null,
      until: new Date(now + WORKER_LEASE_MS).toISOString(),
      heartbeat: new Date(now).toISOString(),
      ...fields,
    }),
  );
}

function sleeper(script = 'sleep 60'): ChildProcess {
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  strays.push(child);
  return child;
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  dbFile = tempDbPath('eklavya-reservation-cov');
  db = openDb(dbFile);
});

afterEach(() => {
  process.execPath = origExec;
  for (const child of strays.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  db.close();
  cleanup(dbFile);
});

describe('reservation edge cases', () => {
  it('reads the observer marker from the environment', () => {
    expect(isInternalObserver({})).toBe(false);
    expect(isInternalObserver({ EKLAVYA_INTERNAL_OBSERVER: '1' })).toBe(true);
  });

  it('treats a holder row it cannot parse as a free slot and takes it', () => {
    db.prepare("INSERT INTO meta (key, value) VALUES ('memory_worker', 'not json')").run();
    const token = reserveWorker(db);
    expect(token).toBeTruthy();
    expect(JSON.parse(holderRow()!.value).token).toBe(token);
  });

  it('no pid and no group are never alive', () => {
    expect(groupAlive(null)).toBe(false);
    expect(startStamp(null)).toBeNull();
  });

  it.skipIf(!posix)('keeps a live holder recorded without a start stamp', () => {
    // A row from before pid start stamps were recorded: liveness alone decides.
    holder({ pid: process.pid });
    expect(workerStatus(db)).toMatchObject({ pid: process.pid, stale: false });
    expect(reserveWorker(db)).toBeNull();
  });

  it.skipIf(!posix)('keeps a live provider group recorded without a start stamp, and with a matching one', async () => {
    const group = sleeper();
    await until(() => startStamp(group.pid!) !== null);
    holder({ child: group.pid });
    expect(workerStatus(db)).toMatchObject({ child: group.pid });
    holder({ child: group.pid, childStart: startStamp(group.pid!) });
    expect(workerStatus(db)).toMatchObject({ child: group.pid });
    // A stamp that does not match is a stranger with a recycled number.
    holder({ child: group.pid, childStart: 'Thu Jan  1 00:00:00 1970' });
    expect(workerStatus(db)).toBeNull();
  });

  it('backs off when the slot changed between its read and its lock', () => {
    const racing = new Proxy(db, {
      get(real, prop) {
        if (prop === 'transaction') {
          return (fn: () => unknown) => {
            // Another process takes the slot in the gap.
            holder({ token: 'someone-else' });
            return real.transaction(fn);
          };
        }
        const value = Reflect.get(real, prop, real) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
      },
    });
    expect(reserveWorker(racing)).toBeNull();
    expect(JSON.parse(holderRow()!.value).token).toBe('someone-else');
  });

  it('hands off from a holder written before generations were counted', () => {
    holder({ token: 'legacy' });
    const next = handOffWorker(db, 'legacy', () => true);
    expect(next).toBeTruthy();
    expect(JSON.parse(holderRow()!.value)).toMatchObject({ token: next, generation: 1 });
  });
});

describe('launchWorker failure paths', () => {
  it('releases the slot when the executable cannot start', async () => {
    const token = reserveWorker(db)!;
    process.execPath = '/nonexistent/eklavya-node';
    expect(launchWorker(db, token)).toBe(false);
    expect(holderRow()).toBeUndefined();
    // The asynchronous spawn error arrives too, and finds nothing left to release.
    await new Promise((r) => setTimeout(r, 50));
    expect(holderRow()).toBeUndefined();
  });

  it('releases the slot when spawning throws outright', () => {
    const token = reserveWorker(db)!;
    process.execPath = '';
    expect(launchWorker(db, token, { probe: true })).toBe(false);
    expect(holderRow()).toBeUndefined();
  });

  it.skipIf(!posix)('still reports a launch whose early pid record was refused', () => {
    const token = reserveWorker(db)!;
    process.execPath = '/usr/bin/true';
    const refusing = new Proxy(db, {
      get(real, prop) {
        if (prop === 'transaction') {
          return () => {
            throw new Error('database is locked');
          };
        }
        const value = Reflect.get(real, prop, real) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value;
      },
    });
    expect(launchWorker(refusing, token)).toBe(true);
    // The child adopts the slot itself; the early copy of its pid never landed.
    expect(JSON.parse(holderRow()!.value)).toMatchObject({ token, pid: null });
  });
});

describe.skipIf(!posix)('stopWorker', () => {
  it('signals the provider tree directly when its worker is already gone', async () => {
    const group = sleeper();
    await until(() => startStamp(group.pid!) !== null);
    holder({ pid: 999_999_999, child: group.pid, childStart: startStamp(group.pid!) });
    const outcome = await stopWorker(db, 2_000);
    expect(outcome).toMatchObject({ stopped: true, pid: 999_999_999, child: group.pid, forced: false, released: true });
    expect(groupAlive(group.pid!)).toBe(false);
    expect(holderRow()).toBeUndefined();
  });

  it('forces a worker that ignores SIGTERM', async () => {
    const worker = sleeper("trap '' TERM; while :; do sleep 0.05; done");
    await until(() => startStamp(worker.pid!) !== null);
    holder({ pid: worker.pid, pidStart: startStamp(worker.pid!) });
    const outcome = await stopWorker(db, 150);
    expect(outcome).toMatchObject({ stopped: true, pid: worker.pid, forced: true, released: true });
    expect(holderRow()).toBeUndefined();
  });
});
