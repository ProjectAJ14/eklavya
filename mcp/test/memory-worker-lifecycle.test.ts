import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { projectKey } from '../src/store.js';
import {
  appendEvent,
  backlogSummary,
  batchSession,
  claimJob,
  discardBacklog,
  failJob,
  hasClaimableJob,
  quarantineBacklog,
  restoreBacklog,
} from '../src/memory/store.js';
import { eventUid } from '../src/memory/identity.js';
import { queueDepth, superviseWorker } from '../src/memory/worker.js';
import { runClaude, ProviderError } from '../src/memory/provider.js';
import {
  MAX_GENERATIONS,
  WORKER_LEASE_MS,
  handOffWorker,
  launchWorker,
  releaseWorker,
  renewWorker,
  reserveWorker,
  startStamp,
  stopWorker,
  workerStatus,
} from '../src/memory/reservation.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';

/**
 * The failure paths PR #24 left open, as tests: a busy database under the
 * heartbeat, a provider that exits cleanly and leaves children behind, a
 * worker that crashes mid-call, a reservation whose lease ran out while its
 * holder was still alive, the observer switched off under a manual run, and a
 * queue deeper than one worker's four jobs.
 *
 * Every `claude` here is a shell script — no model is called — and every
 * process one starts is recorded, so each test can prove the whole tree is
 * gone rather than only the process it happened to hold. POSIX only: the
 * process-group guarantees are what is under test.
 */

const mcpDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(mcpDir, 'dist', 'cli.js');
const HOOKS = path.join(mcpDir, 'dist', 'hooks');
const posix = process.platform !== 'win32';

/** In-process runs get this, never `loadConfig`: only spawned children see `EKLAVYA_HOME`. */
const OBSERVED: EklavyaConfig = {
  ...DEFAULT_CONFIG,
  providers: { ...DEFAULT_CONFIG.providers, observer: { kind: 'anthropic', model: 'm' } },
};
const UNOBSERVED: EklavyaConfig = { ...OBSERVED, providers: { ...OBSERVED.providers, observer: null } };

const envelope = JSON.stringify({
  subtype: 'success',
  is_error: false,
  structured_output: {
    observations: [{ title: 'Rotated refresh tokens', type: 'feature', narrative: 'n', facts: [], files: [], tags: [] }],
  },
});

let dbFile = '';
let db: DB;
let home = '';
let repo = '';
let project = '';
let bin = '';
let log = '';
let kids = '';
const origPath = process.env.PATH;
const strays: ChildProcess[] = [];

/**
 * A stand-in `claude`. Logs `start`/`end` with its pid; `leave` starts a
 * grandchild that inherits stdout (the worst case: it holds the pipe open) and
 * records its pid; `trap` ignores SIGTERM; `flood` prints without end.
 */
function fakeClaude(opts: { sleep?: number; leave?: boolean; trap?: boolean; reply?: string; flood?: boolean } = {}): void {
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh
${opts.trap ? "trap '' TERM" : ''}
cat >/dev/null
echo "start $$" >> "${log}"
${opts.leave ? `sleep 60 &\necho $! >> "${kids}"` : ''}
${opts.flood ? 'while :; do echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx; done' : ''}
${opts.sleep ? `sleep ${opts.sleep}` : ''}
echo "end $$" >> "${log}"
echo '${opts.reply ?? envelope}'
`,
    { mode: 0o755 },
  );
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const lines = (file: string): string[] =>
  fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
const calls = () => lines(log).filter((l) => l.startsWith('start'));
const callPids = () => calls().map((l) => Number(l.split(' ')[1]));
const kidPids = () => lines(kids).map(Number);
const noneAlive = () => [...callPids(), ...kidPids()].every((pid) => !alive(pid));

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
}

/** A live process nothing else knows about, to stand in for a worker or a provider leader. */
function sleeper(detached = false): ChildProcess {
  const child = spawn('sleep', ['60'], { detached, stdio: 'ignore' });
  strays.push(child);
  return child;
}

function queue(n: number, prefix = 's'): void {
  for (let i = 0; i < n; i++) {
    const sid = `${prefix}${i}`;
    appendEvent(db, {
      eventUid: eventUid({ host: 'claude-code', sessionId: sid, kind: 'prompt', occurredAt: `t${i}`, body: sid }),
      project,
      sessionId: sid,
      kind: 'prompt',
      body: `Add refresh token rotation, part ${i}`,
    });
    batchSession(db, { project, sessionId: sid, reason: 'session_seam' });
  }
}

const jobs = () =>
  db.prepare('SELECT id, status, attempts FROM memory_jobs ORDER BY id').all() as {
    id: number;
    status: string;
    attempts: number;
  }[];

/** Writes a holder by hand, for identities a real worker could not produce. */
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

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    EKLAVYA_DB: dbFile,
    EKLAVYA_HOME: home,
    EKLAVYA_RUNTIME: mcpDir,
    PATH: `${bin}${path.delimiter}${origPath}`,
    ...extra,
  };
}

function configure(observer: boolean): void {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({
      min_minutes_between_quizzes: 0,
      providers: { observer: observer ? { kind: 'anthropic', model: 'm' } : null },
    }),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-life-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-life-repo-'));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-life-bin-'));
  log = path.join(bin, 'calls.log');
  kids = path.join(bin, 'kids.log');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  project = projectKey(fs.realpathSync(repo));
  dbFile = tempDbPath('life');
  db = openDb(dbFile);
  configure(true);
  process.env.PATH = `${bin}${path.delimiter}${origPath}`;
});

afterEach(async () => {
  process.env.PATH = origPath;
  for (const child of strays.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const pid of [...callPids(), ...kidPids()]) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  // A spawned worker still running would write into a deleted database; a
  // hand-written or in-process holder never goes by itself, so it is cleared.
  await until(() => !workerStatus(db) || !workerStatus(db)!.pid || workerStatus(db)!.pid === process.pid, 8_000);
  db.prepare("DELETE FROM meta WHERE key = 'memory_worker'").run();
  db.close();
  cleanup(dbFile);
  for (const dir of [home, repo, bin]) fs.rmSync(dir, { recursive: true, force: true });
}, 20_000);

describe.skipIf(!posix)('the reservation goes by process identity, not by the clock', () => {
  it('never hands a live holder\'s slot to another worker, however long its lease has been out', async () => {
    const worker = sleeper(true);
    const t = Date.now();
    expect(reserveWorker(db, worker.pid!, t)).toBeTruthy();
    // Well past the old fifteen-minute takeover ceiling.
    expect(reserveWorker(db, null, t + WORKER_LEASE_MS + 60 * 60_000)).toBeNull();
    // That call was recovery, not a shrug: the wedged holder was signalled.
    await until(() => !alive(worker.pid!) || worker.exitCode !== null || worker.signalCode !== null);
    expect(worker.signalCode).not.toBeNull();
    expect(reserveWorker(db, null, t + WORKER_LEASE_MS + 60 * 60_000)).toBeTruthy();
  });

  it('a lapsed lease is recovered with SIGTERM first, and the slot waits until the holder is gone', async () => {
    const worker = spawn('sh', ['-c', "trap 'exit 0' TERM; while :; do sleep 0.05; done"], { detached: true, stdio: 'ignore' });
    strays.push(worker);
    await until(() => startStamp(worker.pid!) !== null);
    const t = Date.now();
    expect(reserveWorker(db, worker.pid!, t)).toBeTruthy();
    expect(reserveWorker(db, null, t + WORKER_LEASE_MS + 1_000)).toBeNull();
    await until(() => worker.exitCode !== null);
    expect(worker.exitCode).toBe(0);
    expect(reserveWorker(db, null, t + WORKER_LEASE_MS + 1_000)).toBeTruthy();
  });

  it('a live lease whose holder is still running is never touched', () => {
    const worker = sleeper();
    expect(reserveWorker(db, worker.pid!)).toBeTruthy();
    expect(reserveWorker(db)).toBeNull();
    expect(alive(worker.pid!)).toBe(true);
    expect(workerStatus(db)?.pidStart).toBe(startStamp(worker.pid!));
  });

  it('a worker that crashed frees the slot at once, without waiting out its lease', () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    holder({ pid: Number(dead.stdout), pidStart: 'Thu Jan  1 00:00:00 1970' });
    expect(reserveWorker(db)).toBeTruthy();
  });

  it('a pid that now belongs to somebody else is not the holder, and is never signalled', () => {
    const stranger = sleeper();
    holder({ pid: stranger.pid, pidStart: 'Thu Jan  1 00:00:00 1970' });
    expect(workerStatus(db)).toBeNull();
    expect(reserveWorker(db, null, Date.now() + 10 * WORKER_LEASE_MS)).toBeTruthy();
    expect(alive(stranger.pid!)).toBe(true);
  });

  it('a crashed worker whose provider tree survived keeps the slot until recovery has ended that tree', async () => {
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    const provider = sleeper(true);
    await until(() => startStamp(provider.pid!) !== null);
    holder({ pid: Number(dead.stdout), pidStart: 'gone', child: provider.pid, childStart: startStamp(provider.pid!) });
    const lapsed = Date.now() + WORKER_LEASE_MS + 1_000;
    expect(reserveWorker(db)).toBeNull();
    expect(alive(provider.pid!)).toBe(true);
    expect(reserveWorker(db, null, lapsed)).toBeNull();
    await until(() => provider.signalCode !== null);
    expect(provider.signalCode).toBe('SIGTERM');
    expect(reserveWorker(db, null, lapsed)).toBeTruthy();
  });

  it('a launch that never recorded a process frees itself when the lease lapses', () => {
    const t = Date.now();
    expect(reserveWorker(db, null, t)).toBeTruthy();
    expect(reserveWorker(db, null, t + 1_000)).toBeNull();
    expect(reserveWorker(db, null, t + WORKER_LEASE_MS + 1)).toBeTruthy();
  });
});

describe('handing the slot on', () => {
  afterEach(() => {
    db.prepare("DELETE FROM meta WHERE key = 'memory_worker'").run();
  });

  it('passes the slot on when there is more to do, releases it when there is not', () => {
    const token = reserveWorker(db)!;
    const next = handOffWorker(db, token, () => true);
    expect(next).toBeTruthy();
    expect(workerStatus(db)).toMatchObject({ token: next, pid: null, child: null, generation: 1 });
    expect(handOffWorker(db, next!, () => false)).toBeNull();
    expect(workerStatus(db)).toBeNull();
  });

  it('is bounded: the chain from one launch ends at MAX_GENERATIONS', () => {
    let token: string | null = reserveWorker(db)!;
    let hops = 0;
    while ((token = handOffWorker(db, token, () => true))) hops++;
    expect(hops).toBe(MAX_GENERATIONS - 1);
    expect(workerStatus(db)).toBeNull();
  });

  /**
   * A launcher whose registration runs late — after its worker has already
   * adopted the slot, finished and handed it on — must not write its dead
   * worker's pid over the successor's. With one token for the whole chain it
   * did, and a dead pid with no provider made an occupied slot read as free.
   * Every step is an explicit call in order, so no timing is involved.
   */
  it.skipIf(!posix)('a stale launcher cannot register over, release or hand off a successor\'s slot', async () => {
    const first = reserveWorker(db)!;
    // The old worker, which has since exited: its pid is dead.
    const old = spawn('true', [], { stdio: 'ignore' });
    await new Promise((r) => old.on('close', r));
    const successor = sleeper();

    // The old worker adopts, then hands off; the successor adopts its slot.
    expect(renewWorker(db, first, { pid: old.pid! })).toBe(true);
    handOffWorker(db, first, () => true);
    const next = workerStatus(db)!.token;
    expect(renewWorker(db, next, { pid: successor.pid! })).toBe(true);
    const adopted = workerStatus(db);
    expect(adopted).toMatchObject({ pid: successor.pid, generation: 1 });

    // The paused registration resumes, and the old worker's cleanup runs.
    expect(renewWorker(db, first, { pid: old.pid! })).toBe(false);
    expect(releaseWorker(db, first)).toBe(true);
    expect(handOffWorker(db, first, () => true)).toBeFalsy();
    // The real launcher, arriving late with the stale token.
    const priorDb = process.env.EKLAVYA_DB;
    process.env.EKLAVYA_DB = dbFile;
    try {
      launchWorker(db, first);
    } finally {
      if (priorDb === undefined) delete process.env.EKLAVYA_DB;
      else process.env.EKLAVYA_DB = priorDb;
    }

    expect(workerStatus(db)).toEqual(adopted);
    expect(reserveWorker(db)).toBeNull();
  });

  it('gives every generation its own token', () => {
    const first = reserveWorker(db)!;
    handOffWorker(db, first, () => true);
    const second = workerStatus(db)!.token;
    expect(second).not.toBe(first);
    handOffWorker(db, second, () => true);
    expect(workerStatus(db)!.token).not.toBe(second);
  });

  it('cannot be used by a token that no longer holds the slot', () => {
    reserveWorker(db);
    expect(handOffWorker(db, 'not-mine', () => true)).toBeNull();
    expect(workerStatus(db)).not.toBeNull();
  });
});

describe.skipIf(!posix)('every way out of a provider call reaps the whole tree', () => {
  it('a clean exit that leaves a child holding stdout: resolves promptly, child gone, pid cleared last', async () => {
    fakeClaude({ leave: true });
    const seen: (number | null)[] = [];
    const t = Date.now();
    const out = await runClaude('m', 'x', { graceMs: 300, onSpawn: (pid) => seen.push(pid) });
    expect(JSON.parse(out).subtype).toBe('success');
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(kidPids()).toHaveLength(1);
    expect(noneAlive()).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeNull();
  });

  it('an error envelope with a child left behind: rejects, and the child is gone', async () => {
    fakeClaude({ leave: true, reply: JSON.stringify({ subtype: 'success', is_error: true, result: 'Not logged in' }) });
    const out = await runClaude('m', 'x', { graceMs: 300 });
    // The envelope is the caller's to classify; the tree is ours to end.
    expect(JSON.parse(out).is_error).toBe(true);
    expect(noneAlive()).toBe(true);
  });

  it('a timeout ends a tree that ignores SIGTERM', async () => {
    fakeClaude({ leave: true, trap: true, sleep: 60 });
    const err = await runClaude('m', 'x', { timeoutMs: 400, graceMs: 300 }).catch((e: unknown) => e);
    expect((err as ProviderError).errorClass).toBe('transient');
    expect(noneAlive()).toBe(true);
  });

  it('a cancel ends the tree and says cancelled', async () => {
    fakeClaude({ leave: true, sleep: 60 });
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 300);
    const err = await runClaude('m', 'x', { signal: cancel.signal, graceMs: 300 }).catch((e: unknown) => e);
    expect((err as ProviderError).errorClass).toBe('cancelled');
    expect(noneAlive()).toBe(true);
  });

  it('a provider killed by somebody else is a retryable failure, never a malformed one', async () => {
    fakeClaude({ sleep: 60 });
    const call = runClaude('m', 'x', { graceMs: 300 }).catch((e: unknown) => e);
    await until(() => calls().length === 1);
    process.kill(callPids()[0]!, 'SIGTERM');
    const err = await call;
    expect((err as ProviderError).errorClass).toBe('transient');
    expect((err as ProviderError).message).toMatch(/stopped by SIGTERM/);
  });

  it('a registration callback that throws cancels the call it just started', async () => {
    fakeClaude({ leave: true, sleep: 60 });
    const t = Date.now();
    const err = await runClaude('m', 'x', {
      graceMs: 300,
      onSpawn: (pid) => {
        if (pid !== null) throw new Error('SQLITE_BUSY: database is locked');
      },
    }).catch((e: unknown) => e);
    expect((err as ProviderError).errorClass).toBe('cancelled');
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(noneAlive()).toBe(true);
  });

  it('output past the cap stops being kept at once, and the flooding tree is ended', async () => {
    fakeClaude({ trap: true, flood: true });
    const err = await runClaude('m', 'x', { maxOutput: 64 * 1024, graceMs: 1_000 }).catch((e: unknown) => e);
    expect((err as ProviderError).errorClass).toBe('malformed');
    expect(noneAlive()).toBe(true);
  });

  it('a worker that crashes mid-call takes its provider tree with it', async () => {
    fakeClaude({ leave: true, trap: true, sleep: 60 });
    const script = `
      import fs from 'node:fs';
      import { runClaude } from ${JSON.stringify(path.join(mcpDir, 'dist', 'memory', 'provider.js'))};
      runClaude('m', 'x').catch(() => {});
      // Crash once the provider tree is fully up, grandchild included.
      setInterval(() => {
        if (fs.existsSync(${JSON.stringify(kids)})) throw new Error('the worker crashed');
      }, 20);
    `;
    const crashed = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: env(), encoding: 'utf8' });
    expect(crashed.status).not.toBe(0);
    expect(kidPids()).toHaveLength(1);
    await until(noneAlive, 3_000);
    expect(calls()).toHaveLength(1);
    expect(noneAlive()).toBe(true);
  });
});

describe.skipIf(!posix)('a supervised worker run', () => {
  it('database contention under the heartbeat: cancels the call, reaps the tree, requeues the job, frees the slot', async () => {
    fakeClaude({ leave: true, sleep: 60 });
    queue(1);
    db.pragma('busy_timeout = 300');
    const token = reserveWorker(db)!;
    const blocker = new Database(dbFile);

    const run = superviseWorker(db, token, OBSERVED, { maxJobs: 4, loadConfig: () => OBSERVED, heartbeatMs: 100, launch: () => false });
    await until(() => kidPids().length === 1);
    blocker.exec('BEGIN IMMEDIATE');
    await until(noneAlive, 5_000);
    blocker.exec('COMMIT');
    const result = await run;
    blocker.close();

    expect(noneAlive()).toBe(true);
    expect(result.stopped).toBe('cancelled');
    expect(jobs()).toEqual([expect.objectContaining({ status: 'pending', attempts: 0 })]);
    expect(result.released).toBe(true);
    expect(workerStatus(db)).toBeNull();
  }, 20_000);

  it('a database it cannot write to at the start: no provider call at all, and the job is kept', async () => {
    fakeClaude();
    queue(1);
    db.pragma('busy_timeout = 50');
    const token = reserveWorker(db)!;
    const blocker = new Database(dbFile);
    blocker.exec('BEGIN IMMEDIATE');
    const run = superviseWorker(db, token, OBSERVED, { maxJobs: 4, loadConfig: () => OBSERVED, launch: () => false });
    setTimeout(() => blocker.exec('COMMIT'), 200);
    const result = await run;
    blocker.close();
    expect(result.stopped).toBe('refused');
    expect(calls()).toHaveLength(0);
    expect(jobs()).toEqual([expect.objectContaining({ status: 'pending', attempts: 0 })]);
  });

  it('a clean call that leaves a child behind releases the slot only after the child is gone', async () => {
    fakeClaude({ leave: true });
    queue(1);
    const token = reserveWorker(db)!;
    let childAliveAtRelease: boolean | null = null;
    const original = db.prepare.bind(db);
    // Watch the release statement: the moment it runs, the tree must be gone.
    (db as unknown as { prepare: typeof db.prepare }).prepare = ((sql: string) => {
      if (sql.startsWith('DELETE FROM meta')) childAliveAtRelease = kidPids().some(alive);
      return original(sql);
    }) as typeof db.prepare;
    const result = await superviseWorker(db, token, OBSERVED, { maxJobs: 4, loadConfig: () => OBSERVED, launch: () => false });
    (db as unknown as { prepare: typeof db.prepare }).prepare = original;
    expect(result.processed).toBe(1);
    expect(childAliveAtRelease).toBe(false);
    expect(noneAlive()).toBe(true);
    expect(workerStatus(db)).toBeNull();
  });

  it('clearing providers.observer mid-call cancels it, starts nothing more, and keeps every job', async () => {
    fakeClaude({ leave: true, sleep: 60 });
    queue(3);
    const token = reserveWorker(db)!;
    let current = OBSERVED;
    const run = superviseWorker(db, token, OBSERVED, {
      maxJobs: 10,
      loadConfig: () => current,
      heartbeatMs: 100,
      launch: () => false,
    });
    await until(() => kidPids().length === 1);
    current = UNOBSERVED;
    const result = await run;
    expect(result.stopped).toBe('cancelled');
    expect(calls()).toHaveLength(1);
    expect(noneAlive()).toBe(true);
    expect(jobs().map((j) => [j.status, j.attempts])).toEqual([
      ['pending', 0],
      ['pending', 0],
      ['pending', 0],
    ]);
    expect(workerStatus(db)).toBeNull();
  });

  it('switching to a different observer model stops the run the same way', async () => {
    fakeClaude({ sleep: 60 });
    queue(1);
    const token = reserveWorker(db)!;
    let current = OBSERVED;
    const run = superviseWorker(db, token, OBSERVED, { maxJobs: 4, loadConfig: () => current, heartbeatMs: 100, launch: () => false });
    await until(() => calls().length === 1);
    current = { ...OBSERVED, providers: { ...OBSERVED.providers, observer: { kind: 'anthropic', model: 'other' } } };
    const result = await run;
    expect(result.stopped).toBe('cancelled');
    expect(jobs()[0]).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('at its four-job limit with more queued, hands the slot to a successor instead of dropping it', async () => {
    fakeClaude();
    queue(6);
    const token = reserveWorker(db)!;
    const launched: string[] = [];
    const result = await superviseWorker(db, token, OBSERVED, {
      maxJobs: 4,
      loadConfig: () => OBSERVED,
      launch: (_db, t) => (launched.push(t), true),
    });
    expect(result).toMatchObject({ processed: 4, stopped: 'limit', handedOff: true, released: false });
    // The successor is launched under its own token, not this run's.
    expect(launched).toHaveLength(1);
    expect(launched[0]).not.toBe(token);
    expect(workerStatus(db)).toMatchObject({ token: launched[0], generation: 1, pid: null });
  });

  it('a successor that cannot start leaves the slot free, under its own token', async () => {
    fakeClaude();
    queue(6);
    const token = reserveWorker(db)!;
    const result = await superviseWorker(db, token, OBSERVED, { maxJobs: 4, loadConfig: () => OBSERVED, launch: () => false });
    expect(result).toMatchObject({ processed: 4, handedOff: false, released: true });
    expect(workerStatus(db)).toBeNull();
  });

  it('does not hand off when it was told to stop after its last job', async () => {
    fakeClaude();
    queue(6);
    const token = reserveWorker(db)!;
    const stop = new AbortController();
    const launched: string[] = [];
    const result = await superviseWorker(db, token, OBSERVED, {
      maxJobs: 4,
      signal: stop.signal,
      // The terminal closes once the fourth job is committed, before the hand-off.
      loadConfig: () => {
        if (jobs().filter((j) => j.status === 'done').length === 4) stop.abort();
        return OBSERVED;
      },
      launch: (_db, t) => (launched.push(t), true),
    });
    expect(result).toMatchObject({ processed: 4, stopped: 'limit', handedOff: false, released: true });
    expect(launched).toEqual([]);
    expect(workerStatus(db)).toBeNull();
  });

  it('does not hand off past a paused queue', async () => {
    fakeClaude();
    queue(6);
    const paused = claimJob(db, 'x')!;
    failJob(db, paused.id, 'x', 'auth', 'Not logged in');
    const token = reserveWorker(db)!;
    const result = await superviseWorker(db, token, OBSERVED, { maxJobs: 4, loadConfig: () => OBSERVED, launch: () => true });
    expect(result).toMatchObject({ processed: 4, handedOff: false, released: true });
  });

  it('does not hand off when all that is left is waiting out a retry delay', async () => {
    fakeClaude();
    queue(5);
    const later = claimJob(db, 'x')!;
    failJob(db, later.id, 'x', 'transient', 'timed out', 5, () => 1);
    const token = reserveWorker(db)!;
    const result = await superviseWorker(db, token, OBSERVED, { maxJobs: 4, loadConfig: () => OBSERVED, launch: () => true });
    expect(result.processed).toBe(4);
    expect(hasClaimableJob(db)).toBe(false);
    expect(result).toMatchObject({ handedOff: false, released: true });
  });
});

describe.skipIf(!posix)('end to end, through the hooks and the CLI', () => {
  const stopHook = (sid: string) =>
    new Promise<void>((resolve) => {
      const child = spawn(process.execPath, [path.join(HOOKS, 'stop-quiz-check.js')], { env: env() });
      child.stdin.end(JSON.stringify({ session_id: sid, cwd: repo }));
      child.on('close', () => resolve());
    });

  it('ten queued batches and one seam: every one is summarised, one call at a time, by a bounded chain', async () => {
    fakeClaude({ sleep: 0.2 });
    queue(10);
    await stopHook('seam');
    await until(() => queueDepth(db).pending === 0 && !workerStatus(db), 60_000);

    expect(queueDepth(db).pending).toBe(0);
    expect((db.prepare("SELECT count(*) n FROM memory_jobs WHERE status = 'done'").get() as { n: number }).n).toBe(10);
    let running = 0;
    let peak = 0;
    for (const line of lines(log)) {
      running += line.startsWith('start') ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(1);
    expect(calls()).toHaveLength(10);
  }, 70_000);

  it('a manual `memory process` stops mid-call when the observer is cleared, and leaves the job queued', async () => {
    fakeClaude({ leave: true, sleep: 60 });
    queue(2);
    const manual = spawn(process.execPath, [CLI, 'memory', 'process'], { env: env(), cwd: repo, stdio: 'ignore' });
    await until(() => kidPids().length === 1);
    configure(false);
    const code = await new Promise<number | null>((resolve) => manual.on('close', resolve));
    expect(code).toBe(0);
    expect(noneAlive()).toBe(true);
    expect(calls()).toHaveLength(1);
    expect(jobs().map((j) => j.status)).toEqual(['pending', 'pending']);
    expect(workerStatus(db)).toBeNull();
  }, 20_000);

  it('`memory stop` ends the worker and its call, and the job goes back', async () => {
    fakeClaude({ leave: true, sleep: 60 });
    queue(1);
    await stopHook('seam');
    await until(() => kidPids().length === 1 && Boolean(workerStatus(db)?.child));
    const status = spawnSync(process.execPath, [CLI, 'memory', 'status'], { env: env(), cwd: repo, encoding: 'utf8' });
    expect(status.stdout).toMatch(/worker:\s+pid \d+ · up \d+s · claude pid \d+ · job #\d+ for \d+s/);

    const stopped = spawnSync(process.execPath, [CLI, 'memory', 'stop'], { env: env(), cwd: repo, encoding: 'utf8' });
    expect(stopped.stdout).toMatch(/stopped the memory worker \(pid \d+\) and its claude call/);
    expect(stopped.stdout).toMatch(/providers.observer null/);
    expect(noneAlive()).toBe(true);
    expect(workerStatus(db)).toBeNull();
    expect(jobs()[0]).toMatchObject({ status: 'pending', attempts: 0 });
  }, 30_000);

  it('`memory stop` never signals a process it did not start', () => {
    const stranger = sleeper();
    holder({ pid: stranger.pid, pidStart: 'Thu Jan  1 00:00:00 1970' });
    const stopped = spawnSync(process.execPath, [CLI, 'memory', 'stop'], { env: env(), cwd: repo, encoding: 'utf8' });
    expect(stopped.stdout).toMatch(/no memory worker is running/);
    expect(alive(stranger.pid!)).toBe(true);
  });

  it('`memory status` names why the queue is paused', () => {
    queue(1);
    const job = claimJob(db, 'x')!;
    failJob(db, job.id, 'x', 'quota', 'You have hit your usage limit');
    const status = spawnSync(process.execPath, [CLI, 'memory', 'status'], { env: env(), cwd: repo, encoding: 'utf8' });
    expect(status.stdout).toMatch(/paused:\s+1 on quota \(usage limit reached\)/);
    expect(status.stdout).not.toMatch(/You have hit/);
  });
});

describe('recovering an incident backlog', () => {
  /** A batch as a recursive helper session left it: the summariser's own input, captured as a prompt. */
  function helperBatch(sid: string): void {
    appendEvent(db, {
      eventUid: eventUid({ host: 'claude-code', sessionId: sid, kind: 'prompt', occurredAt: sid, body: sid }),
      project: '*',
      sessionId: sid,
      kind: 'prompt',
      body: `<evidence project="*" session="${sid}">\n<event kind="lifecycle">source=startup</event>\n</evidence>`,
    });
    batchSession(db, { project: '*', sessionId: sid, reason: 'session_seam' });
  }

  it('tells helper sessions apart from real work', () => {
    queue(2);
    for (const sid of ['h1', 'h2', 'h3']) helperBatch(sid);
    const groups = backlogSummary(db);
    expect(groups.find((g) => g.helper)).toMatchObject({ project: '*', batches: 3, status: 'pending' });
    expect(groups.find((g) => !g.helper)).toMatchObject({ project, batches: 2 });
  });

  it('quarantine sets them aside where no worker will claim them, and restore brings them back', () => {
    for (const sid of ['h1', 'h2']) helperBatch(sid);
    queue(1);
    expect(quarantineBacklog(db, { helpers: true })).toBe(2);
    expect(queueDepth(db)).toMatchObject({ pending: 1, quarantined: 2 });
    const next = claimJob(db, 'w')!;
    expect(next).not.toBeNull();
    expect(claimJob(db, 'w')).toBeNull();

    expect(restoreBacklog(db, { helpers: true })).toBe(2);
    expect(queueDepth(db)).toMatchObject({ quarantined: 0 });
    expect(hasClaimableJob(db)).toBe(true);
  });

  it('discard deletes the selected batches and their evidence, and nothing else', () => {
    for (const sid of ['h1', 'h2']) helperBatch(sid);
    queue(1);
    expect(discardBacklog(db, { helpers: true })).toEqual({ batches: 2, events: 2 });
    expect(jobs()).toHaveLength(1);
    expect((db.prepare("SELECT count(*) n FROM evidence_events WHERE project = '*'").get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) n FROM evidence_events WHERE project = ?').get(project) as { n: number }).n).toBe(1);
  });

  it('selects by batch, session or project as well', () => {
    queue(3);
    const [a, b] = jobs();
    const batchOf = (id: number) => (db.prepare('SELECT batch_id FROM memory_jobs WHERE id = ?').get(id) as { batch_id: number }).batch_id;
    expect(quarantineBacklog(db, { batch: batchOf(a!.id) })).toBe(1);
    expect(quarantineBacklog(db, { session: 's1' })).toBe(1);
    expect(jobs().map((j) => j.status)).toEqual(['quarantined', 'quarantined', 'pending']);
    expect(b).toBeDefined();
    expect(discardBacklog(db, { project })).toEqual({ batches: 3, events: 3 });
  });

  it.skipIf(!posix)('the CLI refuses to change anything without a selector', () => {
    helperBatch('h1');
    const res = spawnSync(process.execPath, [CLI, 'memory', 'backlog', 'discard'], { env: env(), cwd: repo, encoding: 'utf8' });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/needs --helpers/);
    expect(jobs()).toHaveLength(1);
    const list = spawnSync(process.execPath, [CLI, 'memory', 'backlog'], { env: env(), cwd: repo, encoding: 'utf8' });
    expect(list.stdout).toMatch(/1 pending\s+\*\s+\[observer helper sessions\]/);
  });

  it('stopping when nothing runs says so, and clears a launch that never started', async () => {
    expect(await stopWorker(db)).toEqual({ stopped: false });
    holder({ until: new Date(Date.now() - 1).toISOString() });
    expect(await stopWorker(db)).toEqual({ stopped: false });
    expect(db.prepare("SELECT 1 FROM meta WHERE key = 'memory_worker'").get()).toBeUndefined();
    expect(releaseWorker(db, 'nobody')).toBe(true);
  });
});
