import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { projectKey } from '../src/store.js';
import { appendEvent, batchSession } from '../src/memory/store.js';
import { eventUid } from '../src/memory/identity.js';
import { processPending, queueDepth } from '../src/memory/worker.js';
import { runClaude, ProviderError } from '../src/memory/provider.js';
import {
  OBSERVER_ENV,
  WORKER_LEASE_MS,
  releaseWorker,
  renewWorker,
  reserveWorker,
  workerStatus,
} from '../src/memory/reservation.js';
import type { EklavyaConfig } from '../src/config.js';
import { loadConfig } from '../src/config.js';

/**
 * The 2026-09-23 incident, as tests. The observer's `claude -p` ran the plugin's
 * hooks despite `disableAllHooks`, each helper's seam started another worker,
 * and a 16 GB Mac ended the day with 165 workers and 169 Haiku processes.
 *
 * Every stand-in `claude` here is hostile on purpose — it runs the hooks it was
 * told not to — because "Claude Code honours the flag" is the assumption that
 * failed. No real model is called. POSIX only: the stand-ins are shell scripts
 * and the tree-kill tests need process groups.
 */

const mcpDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const hooksDir = path.join(mcpDir, 'dist', 'hooks');
const RUN = path.join(path.dirname(mcpDir), 'hooks', 'run.mjs');
const posix = process.platform !== 'win32';

let dbFile = '';
let db: DB;
let home = '';
let repo = '';
let project = '';
let bin = '';
let log = '';

const envelope = JSON.stringify({
  subtype: 'success',
  is_error: false,
  structured_output: {
    observations: [{ title: 'Rotated refresh tokens', type: 'feature', narrative: 'n', facts: [], files: [], tags: [] }],
  },
});

/**
 * A `claude` that logs each call, runs every Eklavya hook through the real
 * launcher (as 2.1.280 did), optionally sleeps, then answers.
 */
function hostileClaude(opts: { sleep?: number; reply?: string } = {}): void {
  const hooks = ['session-start', 'prompt-submit-nudge', 'capture-tool', 'stop-quiz-check']
    .map(
      (h) =>
        `echo '{"session_id":"helper","cwd":"${repo}","prompt":"summarise this","tool_name":"Bash","tool_input":{"command":"ls"}}' | node "${RUN}" ${h} >/dev/null 2>&1`,
    )
    .join('\n');
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `#!/bin/sh
cat >/dev/null
echo "start $$ $(date +%s%N)" >> "${log}"
${hooks}
${opts.sleep ? `sleep ${opts.sleep}` : ''}
echo "end $$ $(date +%s%N)" >> "${log}"
echo '${opts.reply ?? envelope}'
`,
    { mode: 0o755 },
  );
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    EKLAVYA_DB: dbFile,
    EKLAVYA_HOME: home,
    EKLAVYA_RUNTIME: mcpDir,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    ...extra,
  };
}

function hook(name: string, input: Record<string, unknown>, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, [path.join(hooksDir, `${name}.js`)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: env(extra),
  });
}

const session = (sid: string) => {
  hook('session-start', { session_id: sid, cwd: repo, source: 'startup' });
  hook('prompt-submit-nudge', { session_id: sid, cwd: repo, prompt: 'Add refresh token rotation to the auth middleware' });
  hook('capture-tool', { session_id: sid, cwd: repo, tool_name: 'Bash', tool_input: { command: 'npm test' } });
};

const calls = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

/** No worker holds the slot and no job is claimed: everything that started has finished. */
const quiet = () => !workerStatus(db) && queueDepth(db).pending === 0;

function configure(extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ min_minutes_between_quizzes: 0, providers: { observer: { kind: 'anthropic', model: 'm' } }, ...extra }),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-guard-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-guard-repo-'));
  bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-guard-bin-'));
  log = path.join(bin, 'calls.log');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  project = projectKey(fs.realpathSync(repo));
  dbFile = tempDbPath('guard');
  db = openDb(dbFile);
  configure();
});

afterEach(async () => {
  // A worker still running would write into a deleted database.
  await until(() => !workerStatus(db), 10_000);
  db.close();
  cleanup(dbFile);
  for (const dir of [home, repo, bin]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('the worker reservation', () => {
  // These hold the slot with this test's own pid, which never lapses.
  afterEach(() => {
    db.prepare("DELETE FROM meta WHERE key = 'memory_worker'").run();
  });

  it('has exactly one holder, and a released slot can be taken again', () => {
    const first = reserveWorker(db, process.pid);
    expect(first).toBeTruthy();
    expect(reserveWorker(db)).toBeNull();
    expect(renewWorker(db, 'not-the-token')).toBe(false);
    expect(renewWorker(db, first!, { child: 42 })).toBe(true);
    expect(workerStatus(db)?.child).toBe(42);
    releaseWorker(db, first!);
    expect(reserveWorker(db)).toBeTruthy();
  });

  it('is not taken over while the lapsed holder is still alive, and is once it is dead', () => {
    const t = Date.now();
    expect(reserveWorker(db, process.pid, t)).toBeTruthy();
    // Lapsed, but this process is alive: taking over now is the overlap.
    expect(reserveWorker(db, null, t + WORKER_LEASE_MS + 1)).toBeNull();

    releaseWorker(db, workerStatus(db, t)!.token);
    const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    expect(reserveWorker(db, Number(dead.stdout), t)).toBeTruthy();
    expect(reserveWorker(db, null, t + WORKER_LEASE_MS + 1)).toBeTruthy();
  });

  it('a launch that never started frees itself when the lease lapses', () => {
    const t = Date.now();
    expect(reserveWorker(db, null, t)).toBeTruthy();
    expect(reserveWorker(db, null, t + 1000)).toBeNull();
    expect(reserveWorker(db, null, t + WORKER_LEASE_MS + 1)).toBeTruthy();
  });

  it.skipIf(!posix)('has one winner when a dozen processes race for it', async () => {
    const script = `
      import Database from 'better-sqlite3';
      import { reserveWorker } from ${JSON.stringify(path.join(mcpDir, 'dist', 'memory', 'reservation.js'))};
      const db = new Database(process.env.EKLAVYA_DB);
      db.pragma('busy_timeout = 5000');
      process.stdout.write(reserveWorker(db, process.pid) ? 'won' : 'lost');
    `;
    const racers = Array.from(
      { length: 12 },
      () =>
        new Promise<string>((resolve) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: env(), cwd: mcpDir });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('close', () => resolve(out));
        }),
    );
    const results = await Promise.all(racers);
    expect(results.filter((r) => r === 'won')).toHaveLength(1);
    expect(results.filter((r) => r === 'lost')).toHaveLength(11);
  });
});

describe.skipIf(!posix)('inside the observer, Eklavya is inert', () => {
  it('every hook, launched directly or through run.mjs, records nothing and starts nothing', () => {
    hostileClaude();
    const inside = { [OBSERVER_ENV]: '1' };
    const input = { session_id: 'helper', cwd: repo, source: 'startup', prompt: 'p', tool_name: 'Bash', tool_input: { command: 'ls' } };
    for (const name of ['session-start', 'prompt-submit-nudge', 'subagent-start', 'pre-tool-gate', 'capture-tool', 'checkpoint-quiz', 'stop-quiz-check']) {
      const direct = hook(name, input, inside);
      expect(direct.status).toBe(0);
      expect(direct.stdout).toBe('');
      const launched = spawnSync(process.execPath, [RUN, name], { input: JSON.stringify(input), encoding: 'utf8', env: env(inside) });
      expect(launched.status).toBe(0);
      expect(launched.stdout).toBe('');
    }
    expect((db.prepare('SELECT count(*) n FROM evidence_events').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT count(*) n FROM memory_jobs').get() as { n: number }).n).toBe(0);
    expect(workerStatus(db)).toBeNull();
    expect(calls()).toHaveLength(0);
  });

  it('`memory process` refuses to start inside the observer', () => {
    session('s1');
    hook('stop-quiz-check', { session_id: 's1', cwd: repo }, { [OBSERVER_ENV]: '1' });
    const res = spawnSync(process.execPath, [path.join(mcpDir, 'dist', 'cli.js'), 'memory', 'process'], {
      encoding: 'utf8',
      env: env({ [OBSERVER_ENV]: '1' }),
      cwd: repo,
    });
    expect(res.status).toBe(0);
    expect(calls()).toHaveLength(0);
  });

  it('a helper that runs every hook anyway produces no events, no jobs and no second worker', async () => {
    hostileClaude();
    session('s1');
    hook('stop-quiz-check', { session_id: 's1', cwd: repo });
    await until(() => calls().length >= 2 && quiet());

    // One batch, one call: the helper's own SessionStart/Stop started nothing.
    expect(calls().filter((c) => c.startsWith('start'))).toHaveLength(1);
    expect((db.prepare("SELECT count(*) n FROM evidence_events WHERE session_id = 'helper'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT count(*) n FROM memory_entries WHERE title = 'Rotated refresh tokens'").get() as { n: number }).n).toBe(1);
    // Give anything the helper might have started a moment to show itself.
    await new Promise((r) => setTimeout(r, 1000));
    expect(calls().filter((c) => c.startsWith('start'))).toHaveLength(1);
  });
});

describe.skipIf(!posix)('one worker, one provider call, machine-wide', () => {
  it('six seams closing at once never run two provider calls together', async () => {
    hostileClaude({ sleep: 1 });
    const sids = ['a', 'b', 'c', 'd', 'e', 'f'];
    for (const sid of sids) session(sid);
    await Promise.all(
      sids.map(
        (sid) =>
          new Promise<void>((resolve) => {
            const child = spawn(process.execPath, [path.join(hooksDir, 'stop-quiz-check.js')], { env: env() });
            child.stdin.end(JSON.stringify({ session_id: sid, cwd: repo }));
            child.on('close', () => resolve());
          }),
      ),
    );
    await until(quiet, 30_000);
    // Replay the log: at no instant were two calls between start and end.
    let running = 0;
    let peak = 0;
    for (const line of calls()) {
      running += line.startsWith('start') ? 1 : -1;
      peak = Math.max(peak, running);
    }
    expect(peak).toBe(1);
    expect(calls().filter((c) => c.startsWith('start')).length).toBeGreaterThanOrEqual(1);
  }, 40_000);

  it('a manual `memory process` beside a running worker does not start a second one', async () => {
    hostileClaude({ sleep: 2 });
    session('s1');
    hook('stop-quiz-check', { session_id: 's1', cwd: repo });
    await until(() => calls().length >= 1);
    const manual = spawnSync(process.execPath, [path.join(mcpDir, 'dist', 'cli.js'), 'memory', 'process'], {
      encoding: 'utf8',
      env: env(),
      cwd: repo,
    });
    expect(manual.stdout).toMatch(/another memory worker is running/);
    await until(quiet);
    expect(calls().filter((c) => c.startsWith('start'))).toHaveLength(1);
  }, 30_000);

  it('a rejected login pauses the queue once instead of relaunching on every seam', async () => {
    hostileClaude({ reply: JSON.stringify({ subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' }) });
    for (const sid of ['a', 'b', 'c']) {
      session(sid);
      hook('stop-quiz-check', { session_id: sid, cwd: repo });
      await until(() => !workerStatus(db));
    }
    expect(calls().filter((c) => c.startsWith('start'))).toHaveLength(1);
    expect(queueDepth(db).paused).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe.skipIf(!posix)('the provider process tree', () => {
  const origPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = origPath;
  });

  /** A `claude` that starts a grandchild, records its pid, and ignores SIGTERM. */
  function stubborn(): string {
    const pidFile = path.join(bin, 'grandchild.pid');
    fs.writeFileSync(
      path.join(bin, 'claude'),
      `#!/bin/sh\ntrap '' TERM\nsleep 60 &\necho $! > "${pidFile}"\ncat >/dev/null\nwait\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${origPath}`;
    return pidFile;
  }

  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('a hung call is ended, grandchildren included, within the deadline plus grace', async () => {
    const pidFile = stubborn();
    const t = Date.now();
    const err = await runClaude('m', 'x', { timeoutMs: 500, graceMs: 300 }).catch((e: unknown) => e);
    expect((err as ProviderError).errorClass).toBe('transient');
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(alive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(false);
  });

  it('turning memory off mid-call cancels it and leaves the evidence queued, attempt unspent', async () => {
    const pidFile = stubborn();
    appendEvent(db, {
      eventUid: eventUid({ host: 'claude-code', sessionId: 's1', kind: 'prompt', occurredAt: 'x', body: 'b' }),
      project,
      sessionId: 's1',
      kind: 'prompt',
      body: 'Add refresh token rotation',
    });
    batchSession(db, { project, sessionId: 's1', reason: 'session_seam' });
    const config = loadConfig(repo).config as EklavyaConfig;
    const cancel = new AbortController();
    setTimeout(() => cancel.abort(), 500);
    const result = await processPending(db, config, { signal: cancel.signal });
    expect(result.processed).toBe(0);
    expect(result.failed).toBe(0);
    const job = db.prepare('SELECT status, attempts FROM memory_jobs').get() as { status: string; attempts: number };
    expect(job).toEqual({ status: 'pending', attempts: 0 });
    expect((db.prepare("SELECT count(*) n FROM evidence_events WHERE status = 'batched' OR status = 'accepted'").get() as { n: number }).n).toBe(1);
    await until(() => !alive(Number(fs.readFileSync(pidFile, 'utf8'))), 8_000);
    expect(alive(Number(fs.readFileSync(pidFile, 'utf8')))).toBe(false);
  }, 15_000);

  it('a worker whose job was taken while it waited cannot commit its late answer', async () => {
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\ncat >/dev/null\nsleep 1\necho '${envelope}'\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${origPath}`;
    appendEvent(db, {
      eventUid: eventUid({ host: 'claude-code', sessionId: 's1', kind: 'prompt', occurredAt: 'y', body: 'b' }),
      project,
      sessionId: 's1',
      kind: 'prompt',
      body: 'Add refresh token rotation',
    });
    batchSession(db, { project, sessionId: 's1', reason: 'session_seam' });
    const config = loadConfig(repo).config as EklavyaConfig;
    setTimeout(() => db.prepare("UPDATE memory_jobs SET lease_owner = 'someone-else'").run(), 300);
    const result = await processPending(db, config, { owner: 'stale' });
    expect(result.processed).toBe(0);
    expect((db.prepare('SELECT count(*) n FROM memory_entries').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT lease_owner FROM memory_jobs').get() as { lease_owner: string }).lease_owner).toBe('someone-else');
  });
});
