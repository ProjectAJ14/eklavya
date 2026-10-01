/**
 * The auto-updater, against a fake npm and a fake runtime under a temp
 * EKLAVYA_HOME. Nothing here touches the network or the real ~/.eklavya.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  OFFLINE_GRACE_MS,
  compareVersions,
  readState,
  runUpdate,
  runtimeVersion,
  startBackgroundUpdate,
  updateDue,
  updateNotice,
  writeState,
} from '../src/update.js';

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(mcpRoot, 'dist', 'cli.js');

let home = '';
let bin = '';
const saved = { home: process.env.EKLAVYA_HOME, runtime: process.env.EKLAVYA_RUNTIME, path: process.env.PATH };

/** A runtime at `version` whose cli.js records its argv and exits `code`. */
function fakeRuntime(version: string, code = 0): void {
  const pkg = path.join(home, 'runtime', 'node_modules', 'eklavya');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'eklavya', version }));
  fs.writeFileSync(
    path.join(pkg, 'dist', 'cli.js'),
    `require('fs').appendFileSync(${JSON.stringify(path.join(home, 'ran'))}, process.argv.slice(2).join(' ') + '\\n');` +
      `console.log('fake runtime ${version}'); process.exit(${code});`,
  );
}

/**
 * An `npm` on PATH: `view` prints `latest`, `install` lays down a runtime at
 * that version (copied from one `fakeRuntime` builds aside). `fail` makes the
 * named subcommand print `stderr` and exit 1.
 */
function fakeNpm(latest: string, fail?: { cmd: 'view' | 'install'; stderr: string }): void {
  const current = fs.existsSync(path.join(home, 'runtime')) ? fs.readdirSync(path.join(home, 'runtime')) : null;
  const real = path.join(home, 'runtime');
  const aside = path.join(home, 'next');
  // Build the release-to-be where fakeRuntime writes, then move it aside.
  fs.rmSync(aside, { recursive: true, force: true });
  if (current) fs.renameSync(real, `${real}.keep`);
  fakeRuntime(latest);
  fs.renameSync(real, aside);
  if (current) fs.renameSync(`${real}.keep`, real);
  const script = `#!/bin/sh
case "$1" in
  ${fail ? `${fail.cmd}) echo ${JSON.stringify(fail.stderr)} >&2; exit 1 ;;` : ''}
  view) echo ${latest} ;;
  install) mkdir -p "${real}" && cp -R "${aside}/." "${real}/" ;;
esac
`;
  fs.writeFileSync(path.join(bin, 'npm'), script, { mode: 0o755 });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-update-'));
  bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_RUNTIME;
  process.env.PATH = `${bin}${path.delimiter}${saved.path}`;
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  for (const [key, value] of [
    ['EKLAVYA_HOME', saved.home],
    ['EKLAVYA_RUNTIME', saved.runtime],
    ['PATH', saved.path],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const ran = () => (fs.existsSync(path.join(home, 'ran')) ? fs.readFileSync(path.join(home, 'ran'), 'utf8') : '');

describe('updateDue', () => {
  it('is never due without an installed runtime: that is the launcher heal, not an update', () => {
    expect(updateDue()).toBe(false);
  });

  it('is due for a runtime nothing has checked yet', () => {
    fakeRuntime('1.0.0');
    expect(updateDue()).toBe(true);
  });

  it('waits an hour after a check, unless the runtime moved without install following it', () => {
    fakeRuntime('1.0.0');
    const now = Date.now();
    writeState({ checked_at: new Date(now).toISOString(), applied: '1.0.0' });
    expect(updateDue(now + 1000)).toBe(false);
    expect(updateDue(now + 61 * 60 * 1000)).toBe(true);
    fakeRuntime('1.1.0'); // the launcher healed it to the plugin's pin
    expect(updateDue(now + 1000)).toBe(true);
  });

  it('waits the hour out after a failure too, so a broken npm is not retried every session', () => {
    fakeRuntime('1.1.0');
    writeState({ checked_at: new Date().toISOString(), applied: '1.0.0', error: 'npm not found on PATH' });
    expect(updateDue()).toBe(false);
  });

  it('is off with auto_update false, and under a pinned EKLAVYA_RUNTIME', () => {
    fakeRuntime('1.0.0');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ auto_update: false }));
    expect(updateDue()).toBe(false);
    fs.rmSync(path.join(home, 'config.json'));
    process.env.EKLAVYA_RUNTIME = path.join(home, 'elsewhere');
    expect(updateDue()).toBe(false);
  });
});

describe('runUpdate', () => {
  it('installs a newer release, then runs the NEW runtime with install --auto', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0');
    const result = await runUpdate({ background: false });
    expect(result).toEqual({ status: 'updated', from: '1.0.0', to: '1.2.0' });
    expect(runtimeVersion()).toBe('1.2.0');
    expect(ran()).toBe('install --auto\n');
    const state = readState();
    expect(state).toMatchObject({ applied: '1.2.0', latest: '1.2.0', error: null });
    expect(fs.existsSync(path.join(home, 'runtime', '.installing'))).toBe(false);
  });

  it('does not re-register when the runtime is current and install already ran for it', async () => {
    fakeRuntime('1.2.0');
    fakeNpm('1.2.0');
    writeState({ applied: '1.2.0' });
    expect(await runUpdate({ background: false })).toEqual({ status: 'current', version: '1.2.0' });
    expect(ran()).toBe('');
  });

  it('never downgrades a runtime that is ahead of npm', async () => {
    fakeRuntime('2.0.0');
    fakeNpm('1.9.0');
    writeState({ applied: '2.0.0' });
    expect(await runUpdate({ background: false })).toEqual({ status: 'current', version: '2.0.0' });
    expect(runtimeVersion()).toBe('2.0.0');
  });

  it('records a failed install as the reason, and the session line names the fix', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0', { cmd: 'install', stderr: 'npm error code EACCES' });
    const result = await runUpdate({ background: false });
    expect(result.status).toBe('failed');
    expect(readState()).toMatchObject({ error_class: 'npm' });
    expect(updateNotice()?.text).toMatch(/^Eklavya can't update itself · npm install failed: .*EACCES.* · run: eklavya update$/);
  });

  it('records a failing install --auto from the new runtime', async () => {
    fakeRuntime('1.2.0', 1);
    fakeNpm('1.2.0');
    const result = await runUpdate({ background: false });
    expect(result.status).toBe('failed');
    expect(readState().error_class).toBe('install');
  });

  it('keeps quiet about being offline for a week, then says so', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0', { cmd: 'view', stderr: 'npm error code ENOTFOUND registry.npmjs.org' });
    const now = Date.now();
    writeState({ ok_at: new Date(now).toISOString() });
    await runUpdate({ background: false });
    expect(readState().error_class).toBe('network');
    expect(updateNotice(now + 1000)).toBeNull();
    expect(updateNotice(now + OFFLINE_GRACE_MS + 1000)?.text).toMatch(/can't update itself/);
  });

  it('a success clears the failure', async () => {
    fakeRuntime('1.0.0');
    writeState({ error: 'npm not found on PATH', error_class: 'npm' });
    fakeNpm('1.2.0');
    await runUpdate({ background: false });
    expect(readState().error).toBeNull();
  });

  it('a manual update still runs with auto_update off', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ auto_update: false }));
    expect(updateDue()).toBe(false);
    expect(await runUpdate({ background: true })).toEqual({ status: 'skipped' });
    expect(await runUpdate({ background: false })).toMatchObject({ status: 'updated', to: '1.2.0' });
  });

  it('steps aside while a live install holds the claim', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0');
    fs.writeFileSync(path.join(home, 'runtime', '.installing'), String(process.pid));
    expect(await runUpdate({ background: false })).toEqual({ status: 'busy' });
    expect(runtimeVersion()).toBe('1.0.0');
  });

  it('does not wait out the hour on a claim nobody holds any more', async () => {
    const stamp = path.join(home, 'runtime', '.installing');
    const tenMinutesAgo = (Date.now() - 11 * 60 * 1000) / 1000;
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0');
    // The launcher heal's date stamp, which it never removes.
    fs.writeFileSync(stamp, new Date().toISOString());
    fs.utimesSync(stamp, tenMinutesAgo, tenMinutesAgo);
    expect((await runUpdate({ background: false })).status).toBe('updated');
    // A pid stamp whose process is gone.
    fakeNpm('1.3.0');
    const dead = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(stamp, dead);
    expect((await runUpdate({ background: false })).status).toBe('updated');
  });

  it('a background run that finds another in progress leaves that run\'s log alone', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0');
    fs.writeFileSync(path.join(home, 'update.log'), 'the real run\n');
    fs.writeFileSync(path.join(home, 'runtime', '.installing'), String(process.pid));
    expect(await runUpdate({ background: true })).toEqual({ status: 'busy' });
    expect(fs.readFileSync(path.join(home, 'update.log'), 'utf8')).toBe('the real run\n');
  });

  // A guard on the behaviour, not a reproduction of the race: process start-up
  // staggers these by milliseconds, so the old stat-then-write claim passes it
  // too. The exclusive create is what closes the microsecond window between.
  it('lets exactly one of several overlapping runs install', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0');
    // A slow `npm view`, so every run is inside its claim at the same time.
    const npmPath = path.join(bin, 'npm');
    fs.writeFileSync(npmPath, fs.readFileSync(npmPath, 'utf8').replace('view) echo', 'view) sleep 1; echo'));
    const { spawn } = await import('node:child_process');
    const runs = Array.from({ length: 6 }, () =>
      new Promise<string>((resolve) => {
        let out = '';
        const child = spawn(process.execPath, [cliPath, 'update'], {
          env: { ...process.env, EKLAVYA_HOME: home, NO_COLOR: '1' },
        });
        child.stdout.on('data', (d) => (out += d));
        child.on('close', () => resolve(out));
      }),
    );
    const outs = await Promise.all(runs);
    expect(outs.filter((o) => o.includes('already running'))).toHaveLength(5);
    expect(outs.filter((o) => o.includes('updated 1.0.0'))).toHaveLength(1);
  });

  it('refuses something from npm that is not a version', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('npm-warn-config');
    const result = await runUpdate({ background: false });
    expect(result.status).toBe('failed');
    expect(runtimeVersion()).toBe('1.0.0');
  });
});

/** Polls for `check`, up to two seconds: for what a detached child writes. */
async function eventually(check: () => boolean): Promise<boolean> {
  for (let i = 0; i < 40 && !check(); i++) await new Promise((r) => setTimeout(r, 50));
  return check();
}

describe('runUpdate, the paths that fail', () => {
  it('names a missing npm', async () => {
    fakeRuntime('1.0.0');
    process.env.PATH = bin;
    expect(await runUpdate({ background: false })).toEqual({ status: 'failed', error: 'npm not found on PATH' });
    expect(readState().error_class).toBe('npm');
  });

  it('says "unknown error" when npm view prints nothing at all', async () => {
    fakeRuntime('1.0.0');
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await runUpdate({ background: false })).toEqual({
      status: 'failed',
      error: 'npm view returned no version: unknown error',
    });
  });

  it('classes an install that could not even start by its reason', async () => {
    fakeNpm('1.2.0');
    // `view` answers, then takes its own execute bit away, so `install` cannot spawn.
    const npmPath = path.join(bin, 'npm');
    fs.writeFileSync(npmPath, fs.readFileSync(npmPath, 'utf8').replace('view) echo 1.2.0', `view) /bin/chmod -x "$0"; echo 1.2.0`));
    // Only the fake on PATH: a lookup that skips it must not reach a real npm.
    process.env.PATH = bin;
    const result = await runUpdate({ background: false });
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toMatch(/^npm install failed: /);
  });

  it('classes a network failure during install as network', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0', { cmd: 'install', stderr: 'npm error code ECONNRESET' });
    expect((await runUpdate({ background: false })).status).toBe('failed');
    expect(readState().error_class).toBe('network');
  });

  it('fails when npm install reported success but left no runtime', async () => {
    fs.writeFileSync(path.join(bin, 'npm'), '#!/bin/sh\n[ "$1" = view ] && echo 1.2.0\nexit 0\n', { mode: 0o755 });
    const lines: string[] = [];
    const result = await runUpdate({ background: false, say: (l) => lines.push(l) });
    expect(result).toEqual({ status: 'failed', error: 'the runtime is missing after npm install' });
    expect(lines[0]).toBe('latest 1.2.0, runtime not installed');
  });

  it('records a failure that is not an update error as an install failure, whatever was thrown', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.0.0');
    expect(
      await runUpdate({
        background: false,
        say: () => {
          throw new Error('say broke');
        },
      }),
    ).toEqual({ status: 'failed', error: 'say broke' });
    expect(readState().error_class).toBe('install');
    expect(
      await runUpdate({
        background: false,
        say: () => {
          throw 'plain string';
        },
      }),
    ).toEqual({ status: 'failed', error: 'plain string' });
    expect(fs.existsSync(path.join(home, 'runtime', '.installing'))).toBe(false);
  });

  it('logs a background run, and carries on when the log cannot be written', async () => {
    fakeRuntime('1.0.0');
    fakeNpm('1.2.0');
    expect(await runUpdate({ background: true })).toMatchObject({ status: 'updated', to: '1.2.0' });
    const logged = fs.readFileSync(path.join(home, 'update.log'), 'utf8');
    expect(logged).toMatch(/eklavya update\nlatest 1\.2\.0, runtime 1\.0\.0\n/);
    expect(logged).toContain('fake runtime 1.2.0');

    writeState({ checked_at: undefined });
    fs.rmSync(path.join(home, 'update.log'));
    fs.mkdirSync(path.join(home, 'update.log'));
    fakeNpm('1.3.0');
    expect(await runUpdate({ background: true })).toMatchObject({ status: 'updated', to: '1.3.0' });
  });

  it('restarts a dashboard it stopped for the install, on the new runtime', async () => {
    const { spawn } = await import('node:child_process');
    const net = await import('node:net');
    const port = await new Promise<number>((resolve) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => resolve(p));
      });
    });
    const savedPort = process.env.EKLAVYA_DASHBOARD_PORT;
    process.env.EKLAVYA_DASHBOARD_PORT = String(port);
    const src = `require('http').createServer((q, r) => r.end(JSON.stringify({ app: 'eklavya', version: '0.0.1', pid: process.pid, db: 'x' })))
      .listen(${port}, '127.0.0.1', () => console.log('up'));`;
    const dash = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise((r) => dash.stdout!.once('data', r));
      fakeRuntime('1.0.0');
      fakeNpm('1.2.0');
      expect(await runUpdate({ background: false })).toMatchObject({ status: 'updated', to: '1.2.0' });
      expect(await eventually(() => ran().includes('dashboard --serve'))).toBe(true);
    } finally {
      dash.kill('SIGKILL');
      if (savedPort === undefined) delete process.env.EKLAVYA_DASHBOARD_PORT;
      else process.env.EKLAVYA_DASHBOARD_PORT = savedPort;
    }
  });
});

describe('the small state helpers', () => {
  it('reads a runtime without a version, and a state file that is not an object, as nothing', () => {
    const pkg = path.join(home, 'runtime', 'node_modules', 'eklavya');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    expect(runtimeVersion()).toBeNull();
    fs.writeFileSync(path.join(home, 'update.json'), 'null');
    expect(readState()).toEqual({});
  });

  it('never throws when the state cannot be written', () => {
    const file = path.join(home, 'a-file');
    fs.writeFileSync(file, '');
    process.env.EKLAVYA_HOME = file;
    expect(() => writeState({ latest: '1.0.0' })).not.toThrow();
  });

  it('compares versions of different lengths, ignoring a prerelease tag', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBe(1);
    expect(compareVersions('1.2.0-beta.1', '1.3')).toBe(-1);
  });
});

describe('startBackgroundUpdate', () => {
  it('starts `update --background` from the runtime when one is due, and nothing when not', async () => {
    startBackgroundUpdate();
    expect(fs.existsSync(path.join(home, 'ran'))).toBe(false);
    fakeRuntime('1.0.0');
    startBackgroundUpdate();
    expect(await eventually(() => ran() === 'update --background\n')).toBe(true);
  });

  it('swallows a failure to start', () => {
    fakeRuntime('1.0.0');
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    try {
      expect(() => startBackgroundUpdate()).not.toThrow();
    } finally {
      mkdir.mockRestore();
    }
    expect(fs.existsSync(path.join(home, 'ran'))).toBe(false);
  });
});

describe('updateNotice', () => {
  it('says "updated" for a version once it is the runtime, and not again after it is marked shown', async () => {
    fakeRuntime('1.2.0');
    writeState({ applied: '1.2.0', announced: '1.0.0' });
    expect(updateNotice()).toEqual({ text: 'Eklavya updated to 1.2.0', announces: '1.2.0' });
    writeState({ announced: '1.2.0' });
    expect(updateNotice()).toBeNull();
  });
});

describe('the global eklavya command', () => {
  function cli(args: string[]) {
    return spawnSync(process.execPath, [cliPath, ...args], {
      encoding: 'utf8',
      env: { ...process.env, EKLAVYA_HOME: home, EKLAVYA_DB: path.join(home, 'k.db') },
    });
  }

  it('hands off to a newer runtime, so a stale npm -g install still runs current code', () => {
    fakeRuntime('999.0.0');
    const res = cli(['db-path']);
    expect(res.stdout).toContain('fake runtime 999.0.0');
    expect(ran()).toBe('db-path\n');
  });

  it('runs itself when the runtime is not newer', () => {
    fakeRuntime('0.0.1');
    const res = cli(['db-path']);
    expect(res.stdout.trim()).toBe(path.join(home, 'k.db'));
    expect(ran()).toBe('');
  });
});
