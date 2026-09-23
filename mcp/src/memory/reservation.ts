import crypto from 'node:crypto';
import type { DB } from '../db.js';

/**
 * One background memory worker per installation, and none inside Eklavya's own
 * helpers.
 *
 * The incident this exists for: the observer runs `claude -p`, that helper ran
 * the plugin's hooks despite `disableAllHooks`, its seams started more workers,
 * and each worker started another helper — 165 workers and 169 Haiku processes
 * on a 16 GB Mac before it stopped answering. Two independent guards, so either
 * one alone would have held:
 *
 *   1. `OBSERVER_ENV` marks every process descended from a helper. Every hook,
 *      the launcher and `memory process` return before touching anything.
 *   2. A single reservation row in the shared database. Checking "is there
 *      work" and then spawning let every seam that closed together spawn its
 *      own worker; now the check and the claim are one IMMEDIATE transaction,
 *      and only the winner spawns.
 */

export const OBSERVER_ENV = 'EKLAVYA_INTERNAL_OBSERVER';

export function isInternalObserver(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[OBSERVER_ENV]);
}

const KEY = 'memory_worker';

/**
 * Longer than one provider call can live (100s deadline plus the kill grace),
 * and renewed before every job and while a call runs, so a live worker never
 * lapses.
 */
export const WORKER_LEASE_MS = 180_000;

/**
 * An expired lease whose recorded processes still answer `kill(pid, 0)` is not
 * taken over — a replacement beside a live provider tree is the overlap this
 * file forbids. Past this long, a pid that still answers is assumed reused.
 *
 * ponytail: pid liveness, not process identity. Compare process start times if
 * a reused pid ever holds a reservation for fifteen minutes.
 */
const TAKEOVER_CEILING_MS = 15 * 60_000;

export interface WorkerHolder {
  token: string;
  /** The worker process, once it has adopted the reservation. */
  pid: number | null;
  /** The provider's process-group leader, while a call is running. */
  child: number | null;
  job: number | null;
  until: string;
  heartbeat: string;
}

function read(db: DB): WorkerHolder | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as WorkerHolder;
  } catch {
    return null;
  }
}

function write(db: DB, holder: WorkerHolder): void {
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(KEY, JSON.stringify(holder));
}

function alive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether `holder` still owns the slot at `now`. */
function held(holder: WorkerHolder | null, now: number): boolean {
  if (!holder) return false;
  const until = Date.parse(holder.until);
  if (until > now) return true;
  if (now - until > TAKEOVER_CEILING_MS) return false;
  return alive(holder.pid) || alive(holder.child);
}

/**
 * Takes the one worker slot, or returns null when someone holds it. Atomic
 * across processes: IMMEDIATE takes the write lock before the read, so two
 * callers cannot both see the slot free.
 */
export function reserveWorker(db: DB, pid: number | null = null, now = Date.now()): string | null {
  return db.transaction(() => {
    if (held(read(db), now)) return null;
    const token = crypto.randomUUID();
    const stamp = new Date(now).toISOString();
    write(db, {
      token,
      pid,
      child: null,
      job: null,
      until: new Date(now + WORKER_LEASE_MS).toISOString(),
      heartbeat: stamp,
    });
    return token;
  }).immediate();
}

/**
 * Extends the lease and records what the worker is doing. False when the slot
 * is no longer this token's — the caller must stop, not carry on beside the
 * worker that replaced it.
 */
export function renewWorker(
  db: DB,
  token: string,
  patch: Partial<Pick<WorkerHolder, 'pid' | 'child' | 'job'>> = {},
  now = Date.now(),
): boolean {
  return db.transaction(() => {
    const holder = read(db);
    if (!holder || holder.token !== token) return false;
    write(db, {
      ...holder,
      ...patch,
      until: new Date(now + WORKER_LEASE_MS).toISOString(),
      heartbeat: new Date(now).toISOString(),
    });
    return true;
  }).immediate();
}

/** Gives the slot back. A no-op unless `token` holds it. */
export function releaseWorker(db: DB, token: string): void {
  try {
    db.prepare("DELETE FROM meta WHERE key = ? AND json_extract(value, '$.token') = ?").run(KEY, token);
  } catch {
    /* The lease expires on its own. */
  }
}

/** The current holder, for `memory status` and `doctor`. Null when the slot is free. */
export function workerStatus(db: DB, now = Date.now()): WorkerHolder | null {
  const holder = read(db);
  return held(holder, now) ? holder : null;
}
