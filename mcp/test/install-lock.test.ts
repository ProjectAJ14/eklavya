/**
 * One lock on `~/.eklavya/runtime`, taken the same way by all three things
 * that run npm into it: `eklavya install`, the auto-updater and the launcher's
 * background heal. Driven through the real entry points — the built CLI and
 * `hooks/run.mjs` — against a fake `npm` that logs when each install starts and
 * ends, under a temp HOME. Nothing touches the network or the real ~/.eklavya.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claimInstall, releaseInstall } from '../src/install-lock.js';

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(mcpRoot, 'dist', 'cli.js');
const RUN = path.join(path.dirname(mcpRoot), 'hooks', 'run.mjs');
const posix = process.platform !== 'win32';

let tmp = '';
let home = '';
let eklavyaHome = '';
let runtime = '';
let stamp = '';
let pluginRoot = '';
let claudeDir = '';
let bin = '';
let log = '';
const strays: ChildProcess[] = [];

/** A runtime at `version` with one hook, `probe`, as the launcher sees it. */
function fakeRuntime(version: string): void {
  const pkg = path.join(runtime, 'node_modules', 'eklavya');
  fs.mkdirSync(path.join(pkg, 'dist', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'eklavya', version }));
  fs.writeFileSync(path.join(pkg, 'dist', 'hooks', 'probe.js'), '');
}

/**
 * `npm view` answers `latest`; `npm install` logs `start`/`end` with its pid
 * around a `sleep`, and runs `during` in between.
 */
function fakeNpm(opts: { latest?: string; sleep?: number; during?: string } = {}): void {
  fs.writeFileSync(
    path.join(bin, 'npm'),
    `#!/bin/sh
case "$1" in
  view) echo ${opts.latest ?? '9.9.9'} ;;
  install)
    echo "start $$ $(date +%s)" >> "${log}"
    ${opts.during ?? ''}
    sleep ${opts.sleep ?? 0}
    echo "end $$ $(date +%s)" >> "${log}" ;;
esac
`,
    { mode: 0o755 },
  );
}

/** Everything under the temp HOME, and no `EKLAVYA_RUNTIME`: the lock is on the real runtime path. */
function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    EKLAVYA_HOME: eklavyaHome,
    EKLAVYA_DB: path.join(eklavyaHome, 'knowledge.db'),
    CLAUDE_CONFIG_DIR: claudeDir,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_MEM_DATA_DIR: path.join(tmp, 'no-claude-mem'),
    NO_COLOR: '1',
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`,
  };
  delete e.EKLAVYA_RUNTIME;
  return e;
}

const cli = (args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], { env: env(), encoding: 'utf8', timeout: 30_000 });

function start(args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: env(), stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.end('{}');
    child.on('close', (code) => resolve(code ?? -1));
  });
}

const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const installs = () => lines().filter((l) => l.startsWith('start'));

/** At no instant were two installs between start and end. */
function peak(): number {
  let running = 0;
  let max = 0;
  for (const line of lines()) {
    running += line.startsWith('start') ? 1 : -1;
    max = Math.max(max, running);
  }
  return max;
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

function sleeper(): ChildProcess {
  const child = spawn('sleep', ['60'], { stdio: 'ignore' });
  strays.push(child);
  return child;
}

async function deadPid(): Promise<number> {
  const child = spawn('true', [], { stdio: 'ignore' });
  await new Promise((r) => child.on('close', r));
  return child.pid!;
}

const owner = () => fs.readFileSync(stamp, 'utf8');

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-lock-')));
  home = path.join(tmp, 'home');
  eklavyaHome = path.join(home, '.eklavya');
  runtime = path.join(eklavyaHome, 'runtime');
  stamp = path.join(runtime, '.installing');
  pluginRoot = path.join(tmp, 'plugin');
  claudeDir = path.join(tmp, 'claude');
  bin = path.join(tmp, 'bin');
  log = path.join(tmp, 'npm.log');
  for (const d of [runtime, pluginRoot, claudeDir, bin]) fs.mkdirSync(d, { recursive: true });
  // A config file exists, so `install` never stops to walk the settings.
  fs.writeFileSync(path.join(eklavyaHome, 'config.json'), '{}');
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '9.9.9' }));
});

afterEach(() => {
  for (const child of strays.splice(0)) child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!posix)('the runtime install lock, across every entry point', () => {
  it('never runs two npm installs at once when install, update and the launcher overlap', async () => {
    fakeRuntime('1.0.0');
    fakeNpm({ sleep: 1 });

    const codes = await Promise.all([
      start([CLI, 'install']),
      start([CLI, 'update']),
      start([RUN, 'probe']),
      start([CLI, 'update']),
      start([RUN, 'probe']),
    ]);
    // The launcher's npm is detached: wait for whatever it started to finish.
    await until(() => installs().length > 0 && lines().length === installs().length * 2);

    expect(codes.filter((c) => c === -1)).toEqual([]);
    expect(installs().length).toBeGreaterThanOrEqual(1);
    expect(peak()).toBe(1);
  }, 40_000);

  it('a live owner blocks the manual installer, and its claim is left exactly as it was', () => {
    fakeNpm();
    const holder = sleeper();
    for (const body of [JSON.stringify({ pid: holder.pid, token: 'theirs', at: new Date().toISOString() }), String(holder.pid)]) {
      fs.writeFileSync(stamp, body);
      const res = cli(['install']);
      expect(res.status).toBe(1);
      expect(res.stderr).toMatch(new RegExp(`another Eklavya install is running \\(pid ${holder.pid}\\)`));
      expect(installs()).toEqual([]);
      expect(owner()).toBe(body);
    }
  });

  it('a live owner blocks the updater', () => {
    fakeRuntime('1.0.0');
    fakeNpm();
    const holder = sleeper();
    fs.writeFileSync(stamp, JSON.stringify({ pid: holder.pid, token: 'theirs', at: new Date().toISOString() }));
    const res = cli(['update']);
    expect(res.stdout).toMatch(/already running/);
    expect(installs()).toEqual([]);
  });

  it('recovers a claim whose owner is dead, in every stamp format', async () => {
    fakeNpm();
    const dead = await deadPid();
    for (const body of [JSON.stringify({ pid: dead, token: 'gone', at: new Date().toISOString() }), String(dead)]) {
      fs.writeFileSync(stamp, body);
      cli(['install']);
      expect(installs()).toHaveLength(1);
      // Released on the way out: the next run finds no stamp at all.
      expect(fs.existsSync(stamp)).toBe(false);
      fs.rmSync(log, { force: true });
    }
  });

  it("a late cleanup never deletes the claim of whoever took over meanwhile", () => {
    fakeRuntime('1.0.0');
    const holder = sleeper();
    const theirs = JSON.stringify({ pid: holder.pid, token: 'successor', at: new Date().toISOString() });
    // Mid-install, the stamp is replaced by another owner's — what a stale
    // takeover looks like from the run that was taken over.
    fakeNpm({ during: `printf '%s' '${theirs}' > "${stamp}"` });

    cli(['install']);
    expect(installs()).toHaveLength(1);
    expect(owner()).toBe(theirs);

    fs.rmSync(log, { force: true });
    fs.rmSync(stamp);
    cli(['update']);
    expect(installs()).toHaveLength(1);
    expect(owner()).toBe(theirs);
  });

  it('the launcher records its detached npm as the owner, so the claim lives exactly as long as npm does', async () => {
    fakeRuntime('1.0.0');
    fakeNpm({ sleep: 2 });
    await start([RUN, 'probe']);
    await until(() => installs().length === 1);
    const npmPid = Number(installs()[0]!.split(' ')[1]);
    expect(JSON.parse(owner()).pid).toBe(npmPid);
    // While it runs, a manual install is refused rather than stacked on top.
    expect(cli(['install']).status).toBe(1);
    await until(() => lines().length === 2);
    expect(peak()).toBe(1);
  }, 20_000);
});

describe('claimInstall', () => {
  it('puts back a fresh claim that landed between judging a stale one and taking it', async () => {
    fs.writeFileSync(stamp, JSON.stringify({ pid: await deadPid(), token: 'stale', at: new Date().toISOString() }));
    const fresh = JSON.stringify({ pid: process.pid, token: 'fresh', at: new Date().toISOString() });
    const claim = claimInstall(runtime, {
      beforeTake: () => {
        // Another process broke the stale claim and took the lock first.
        fs.rmSync(stamp);
        fs.writeFileSync(stamp, fresh);
      },
    });
    expect(claim).toBeNull();
    expect(owner()).toBe(fresh);
    expect(fs.readdirSync(runtime)).toEqual(['.installing']);
  });

  it('releases only its own claim', () => {
    const claim = claimInstall(runtime)!;
    expect(claim).not.toBeNull();
    expect(claimInstall(runtime)).toBeNull();
    const theirs = JSON.stringify({ pid: process.pid, token: 'theirs', at: new Date().toISOString() });
    fs.writeFileSync(stamp, theirs);
    releaseInstall(claim);
    expect(owner()).toBe(theirs);
    fs.rmSync(stamp);
    releaseInstall(claim);
    expect(fs.existsSync(stamp)).toBe(false);
  });
});
