import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
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
 *
 * Who holds the slot is decided by process identity — a pid *and* the time
 * that process started — never by the clock alone. A lease that ran out says
 * the holder stopped renewing, not that it stopped running: taking over beside
 * a live but wedged worker is the overlap this file forbids. So an expired
 * lease whose processes are still alive triggers recovery (they are signalled,
 * TERM then KILL) and the slot is taken only once they are gone. A holder whose
 * processes are dead, or whose pid now belongs to a different process, frees
 * the slot at once, lease or no lease.
 */

export const OBSERVER_ENV = 'EKLAVYA_INTERNAL_OBSERVER';

export function isInternalObserver(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[OBSERVER_ENV]);
}

const KEY = 'memory_worker';

/**
 * Longer than one provider call can live (100s deadline plus the kill grace),
 * and renewed before every job and every few seconds while a call runs, so a
 * healthy worker never lapses. It bounds one thing on its own: a launch that
 * reserved the slot and never recorded a process.
 */
export const WORKER_LEASE_MS = 180_000;

/** Past this long expired, recovery stops asking and sends SIGKILL. */
export const RECOVERY_KILL_MS = 30_000;

/**
 * How many workers may hand the slot on, one to the next, from a single launch.
 * Each takes up to four jobs, so one seam can drain a hundred batches without a
 * second seam; the cap is what keeps a queue that somehow refills as fast as it
 * drains from becoming a worker that never ends.
 */
export const MAX_GENERATIONS = 25;

export interface WorkerHolder {
  token: string;
  /** The worker process, once it has adopted the reservation. */
  pid: number | null;
  /** `pid`'s start time as `ps` reports it: pid plus this is the identity. */
  pidStart?: string | null;
  /** The provider's process-group leader, while a call is running or its tree is not yet reaped. */
  child: number | null;
  childStart?: string | null;
  job: number | null;
  /** When the current job was claimed. */
  jobStarted?: string | null;
  /** When this reservation was first taken — kept across hand-offs. */
  started?: string;
  /** 0 for a launch from a seam or the CLI, +1 per hand-off. */
  generation?: number;
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

const posix = process.platform !== 'win32';

function alive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether any process is still in group `pgid`. Windows has no groups: the leader alone. */
export function groupAlive(pgid: number | null | undefined): boolean {
  if (!pgid) return false;
  if (!posix) return alive(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * When `pid` started, as `ps` prints it, or null when no such process is
 * running. Opaque: it is only ever compared with an earlier reading of itself.
 *
 * ponytail: null on Windows, where there is no `ps`; identity there falls back
 * to liveness alone, which never takes over a live pid — `eklavya memory stop`
 * is the way out if a reused one ever holds the slot.
 */
export function startStamp(pid: number | null | undefined): string | null {
  if (!pid || !posix) return null;
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 2_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Whether `pid` is still the process that was recorded, not a stranger that inherited the number. */
function isSame(pid: number | null | undefined, start: string | null | undefined): boolean {
  if (!alive(pid)) return false;
  if (!start) return true;
  // A live pid `ps` cannot read is ps failing, not proof of reuse: keep it.
  const now = startStamp(pid);
  return now === null || now === start;
}

/**
 * Whether the provider tree recorded under `pgid` is still there. The group
 * outlives its leader when `claude` exits before what it started; a pid is
 * never handed out while a group of that number exists, so a live group whose
 * leader is gone is still ours. A live leader has to match its stamp.
 */
function ownsGroup(pgid: number | null | undefined, start: string | null | undefined): boolean {
  if (!groupAlive(pgid)) return false;
  if (!alive(pgid) || !start) return true;
  const now = startStamp(pgid);
  return now === null || now === start;
}

/** What the recorded processes are doing, which is what decides the slot. */
function processesAlive(holder: WorkerHolder): boolean {
  return isSame(holder.pid, holder.pidStart) || ownsGroup(holder.child, holder.childStart);
}

type SlotState = 'free' | 'live' | 'stale';

function stateOf(holder: WorkerHolder | null, now: number): SlotState {
  if (!holder) return 'free';
  const current = Date.parse(holder.until) > now;
  // Reserved, not yet adopted: a launch in flight, and the lease is all there is.
  if (!holder.pid && !holder.child) return current ? 'live' : 'free';
  if (!processesAlive(holder)) return 'free';
  return current ? 'live' : 'stale';
}

function signalGroup(pgid: number, sig: NodeJS.Signals): void {
  try {
    if (posix) process.kill(-pgid, sig);
    else process.kill(pgid, sig);
  } catch {
    /* Already gone. */
  }
}

function signalPid(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(pid, sig);
  } catch {
    /* Already gone. */
  }
}

/**
 * Signals only what the holder still owns — verified by identity, so a pid the
 * system has since handed to someone else is never touched. The worker is
 * signalled by pid, not group: a manual `memory process` shares its terminal's
 * group.
 */
function signalOwned(holder: WorkerHolder, sig: NodeJS.Signals): void {
  if (holder.child && ownsGroup(holder.child, holder.childStart)) signalGroup(holder.child, sig);
  if (holder.pid && holder.pid !== process.pid && isSame(holder.pid, holder.pidStart)) signalPid(holder.pid, sig);
}

/** A stale holder: it stopped renewing while its processes kept running. */
function recover(holder: WorkerHolder, now: number): void {
  const overdue = now - Date.parse(holder.until);
  signalOwned(holder, overdue > RECOVERY_KILL_MS ? 'SIGKILL' : 'SIGTERM');
}

/**
 * Takes the one worker slot, or returns null when someone holds it. Atomic
 * across processes: IMMEDIATE takes the write lock before the read, so two
 * callers cannot both see the slot free.
 *
 * A stale holder is recovered, not replaced: this call signals it and returns
 * null, and a later call takes the slot once it has gone.
 */
export function reserveWorker(db: DB, pid: number | null = null, now = Date.now()): string | null {
  const pidStart = startStamp(pid);
  const outcome = db.transaction(() => {
    const holder = read(db);
    const state = stateOf(holder, now);
    if (state !== 'free') return { token: null, stale: state === 'stale' ? holder : null };
    const token = crypto.randomUUID();
    const stamp = new Date(now).toISOString();
    write(db, {
      token,
      pid,
      pidStart,
      child: null,
      childStart: null,
      job: null,
      jobStarted: null,
      started: stamp,
      generation: 0,
      until: new Date(now + WORKER_LEASE_MS).toISOString(),
      heartbeat: stamp,
    });
    return { token, stale: null };
  }).immediate();
  // Outside the transaction: signalling is slow next to a write lock.
  if (outcome.stale) recover(outcome.stale, now);
  return outcome.token;
}

/**
 * Extends the lease and records what the worker is doing. False when the slot
 * is no longer this token's — the caller must stop, not carry on beside the
 * worker that replaced it. Throws on a database error: the caller decides.
 */
export function renewWorker(
  db: DB,
  token: string,
  patch: Partial<Pick<WorkerHolder, 'pid' | 'child' | 'job'>> = {},
  now = Date.now(),
): boolean {
  const current = read(db);
  // Stamps are read before the write lock, and only when a process changes.
  const pidStart = 'pid' in patch && patch.pid !== current?.pid ? startStamp(patch.pid) : undefined;
  const childStart = 'child' in patch && patch.child !== current?.child ? startStamp(patch.child) : undefined;
  return db.transaction(() => {
    const holder = read(db);
    if (!holder || holder.token !== token) return false;
    const stamp = new Date(now).toISOString();
    write(db, {
      ...holder,
      ...patch,
      ...(pidStart !== undefined && { pidStart }),
      ...(childStart !== undefined && { childStart }),
      ...('job' in patch && patch.job !== holder.job && { jobStarted: patch.job ? stamp : null }),
      until: new Date(now + WORKER_LEASE_MS).toISOString(),
      heartbeat: stamp,
    });
    return true;
  }).immediate();
}

/**
 * Gives the slot back. A no-op unless `token` holds it, and never throws: false
 * means the database refused, and the caller may try again. If nobody does,
 * the slot is still held on paper by processes that are about to be gone, and
 * the next `reserveWorker` finds them dead and takes it.
 */
export function releaseWorker(db: DB, token: string): boolean {
  try {
    db.prepare("DELETE FROM meta WHERE key = ? AND json_extract(value, '$.token') = ?").run(KEY, token);
    return true;
  } catch {
    return false;
  }
}

/**
 * Passes the slot to a successor instead of releasing it, when `more()` says
 * there is still work. Atomic with the check: a seam that queued a batch and
 * lost the reservation to this worker is either seen here, or finds the slot
 * free a moment later and launches its own. Either way the batch is not left
 * waiting for a seam that may never come.
 *
 * True means the caller must now launch the successor (`launchWorker`) with the
 * same token. The holder is reset to "launch in flight", so a successor that
 * never starts frees the slot when the lease lapses.
 */
export function handOffWorker(db: DB, token: string, more: () => boolean, now = Date.now()): boolean {
  return db.transaction(() => {
    const holder = read(db);
    if (!holder || holder.token !== token) return false;
    const generation = (holder.generation ?? 0) + 1;
    if (generation >= MAX_GENERATIONS || !more()) {
      db.prepare('DELETE FROM meta WHERE key = ?').run(KEY);
      return false;
    }
    write(db, {
      ...holder,
      pid: null,
      pidStart: null,
      child: null,
      childStart: null,
      job: null,
      jobStarted: null,
      generation,
      until: new Date(now + WORKER_LEASE_MS).toISOString(),
      heartbeat: new Date(now).toISOString(),
    });
    return true;
  }).immediate();
}

/**
 * Starts `eklavya memory process --no-resume` detached under `token`, which the
 * child adopts rather than competing for. Releases the slot if it cannot start.
 * `--no-resume` leaves paused jobs paused: un-pausing stays an explicit act.
 */
export function launchWorker(db: DB, token: string): boolean {
  try {
    const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
    const child = spawn(process.execPath, [cli, 'memory', 'process', '--no-resume', '--max', '4', '--worker-token', token], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.on('error', () => releaseWorker(db, token));
    if (!child.pid) {
      releaseWorker(db, token);
      return false;
    }
    child.unref();
    try {
      renewWorker(db, token, { pid: child.pid });
    } catch {
      // The child adopts the slot itself with its own pid; this was the early copy.
    }
    return true;
  } catch {
    releaseWorker(db, token);
    return false;
  }
}

/** The current holder, for `memory status` and `doctor`. Null when the slot is free. */
export function workerStatus(db: DB, now = Date.now()): (WorkerHolder & { stale: boolean }) | null {
  const holder = read(db);
  const state = stateOf(holder, now);
  return state === 'free' ? null : { ...holder!, stale: state === 'stale' };
}

export type StopOutcome =
  | { stopped: false }
  | { stopped: true; pid: number | null; child: number | null; forced: boolean; released: boolean };

/**
 * `eklavya memory stop`: ends the worker that holds the slot and the provider
 * tree under it, and nothing else — every signal goes through the identity
 * check. SIGTERM first, which the worker answers by cancelling its call (the
 * job goes back unspent), reaping the tree and releasing; SIGKILL for whatever
 * is still there after `graceMs`. The slot is released only once nothing it
 * recorded is alive.
 */
export async function stopWorker(db: DB, graceMs = 8_000): Promise<StopOutcome> {
  const holder = read(db);
  if (!holder || stateOf(holder, Date.now()) === 'free') {
    if (holder) releaseWorker(db, holder.token);
    return { stopped: false };
  }
  const wait = async (ms: number) => {
    const deadline = Date.now() + ms;
    while (processesAlive(holder) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  };
  // The worker first, and only the worker: it answers SIGTERM by cancelling
  // its own call, which hands the job back unspent. Signalling the provider
  // behind its back would make the call look like it failed. A worker that is
  // already gone leaves nobody to ask, so its tree is signalled directly.
  const worker = holder.pid && holder.pid !== process.pid && isSame(holder.pid, holder.pidStart);
  if (worker) signalPid(holder.pid!, 'SIGTERM');
  else signalOwned(holder, 'SIGTERM');
  await wait(graceMs);
  const forced = processesAlive(holder);
  if (forced) {
    signalOwned(holder, 'SIGKILL');
    await wait(2_000);
  }
  const released = !processesAlive(holder) && releaseWorker(db, holder.token);
  return { stopped: true, pid: holder.pid, child: holder.child, forced, released };
}
