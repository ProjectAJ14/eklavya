import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `hooks/run.mjs` choosing and refreshing the runtime, driven for real: a fake
 * home with a runtime at some version, a fake plugin root pinning another, and
 * fake `npm`/`npx` on PATH that record what they were asked to do. Nothing here
 * touches the network or the developer's `~/.eklavya`.
 */
const repoRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const RUN = path.join(repoRoot, 'hooks', 'run.mjs');

let tmp = '';
let home = '';
let pluginRoot = '';
let bin = '';
let log = '';

const runtimePkg = () => path.join(home, '.eklavya', 'runtime', 'node_modules', 'eklavya');

function pinPlugin(version: string): void {
  fs.mkdirSync(path.join(pluginRoot, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ version }));
}

/** A runtime at `version` whose one hook appends `ran` to the log. */
function installRuntime(version: string): void {
  fs.mkdirSync(path.join(runtimePkg(), 'dist', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(runtimePkg(), 'package.json'), JSON.stringify({ name: 'eklavya', version }));
  fs.writeFileSync(
    path.join(runtimePkg(), 'dist', 'hooks', 'probe.js'),
    `require('node:fs').appendFileSync(${JSON.stringify(log)}, 'ran\\n');`,
  );
}

/** A fake executable on PATH that logs its argv, then runs `body`. */
function fakeBin(name: string, body = ''): void {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

function launchEnv(PATH = `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin`) {
  return { PATH, HOME: home, USERPROFILE: home, CLAUDE_PLUGIN_ROOT: pluginRoot };
}

function launch(name: string, PATH?: string) {
  return spawnSync(process.execPath, [RUN, name], { env: launchEnv(PATH), encoding: 'utf8', input: '{}', timeout: 20_000 });
}

/** Start `n` launches at once, the way a session's hooks and server do. */
function launchTogether(name: string, n: number): Promise<number[]> {
  return Promise.all(
    Array.from({ length: n }, () =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [RUN, name], { env: launchEnv(), stdio: ['pipe', 'ignore', 'ignore'] });
        child.stdin.end('{}');
        child.on('close', (code) => resolve(code ?? -1));
      }),
    ),
  );
}

const logLines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

/** The heal is detached, so give it a moment to write before deciding it never ran. */
function waitForLog(pattern: RegExp, ms = 5000): boolean {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (logLines().some((l) => pattern.test(l))) return true;
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},100)']);
  }
  return false;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-launcher-')));
  home = path.join(tmp, 'home');
  pluginRoot = path.join(tmp, 'plugin');
  bin = path.join(tmp, 'bin');
  log = path.join(tmp, 'log');
  for (const d of [home, pluginRoot, bin]) fs.mkdirSync(d, { recursive: true });
  fakeBin('npm');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe.skipIf(process.platform === 'win32')('run.mjs keeps the runtime in step with the plugin', () => {
  it('runs a runtime behind the plugin this time, and refreshes it in the background', () => {
    pinPlugin('2.0.0');
    installRuntime('1.9.0');

    const res = launch('probe');

    expect(res.status).toBe(0);
    expect(logLines()).toContain('ran');
    expect(waitForLog(/^npm install eklavya@2\.0\.0 /)).toBe(true);
  });

  it('refreshes at most once an hour, however many hooks fire', () => {
    pinPlugin('2.0.0');
    installRuntime('1.9.0');

    launch('probe');
    waitForLog(/^npm install/);
    launch('probe');
    launch('probe');

    expect(logLines().filter((l) => l.startsWith('npm install'))).toHaveLength(1);
  });

  it('starts one refresh when a session\'s hooks and server launch at the same moment', async () => {
    pinPlugin('2.0.0');
    installRuntime('1.9.0');

    const codes = await launchTogether('probe', 8);

    expect(codes).toEqual(Array(8).fill(0));
    waitForLog(/^npm install/);
    expect(logLines().filter((l) => l.startsWith('npm install'))).toHaveLength(1);
  });

  it('takes over a claim older than an hour', () => {
    pinPlugin('2.0.0');
    installRuntime('1.9.0');
    const stamp = path.join(home, '.eklavya', 'runtime', '.installing');
    fs.writeFileSync(stamp, 'old');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(stamp, twoHoursAgo, twoHoursAgo);

    launch('probe');

    expect(waitForLog(/^npm install eklavya@2\.0\.0 /)).toBe(true);
  });

  describe('auto_update: false in the machine\'s config', () => {
    const globalConfig = (value: unknown) => {
      fs.mkdirSync(path.join(home, '.eklavya'), { recursive: true });
      fs.writeFileSync(path.join(home, '.eklavya', 'config.json'), JSON.stringify(value));
    };

    it('stops the launcher upgrading an older runtime', () => {
      pinPlugin('1.26.0');
      installRuntime('1.25.0');
      globalConfig({ auto_update: false });
      // A project file cannot opt the machine back in.
      fs.mkdirSync(path.join(home, '.eklavya', 'projects', 'demo'), { recursive: true });
      fs.writeFileSync(path.join(home, '.eklavya', 'projects', 'demo', 'config.json'), JSON.stringify({ auto_update: true }));

      const res = launch('probe');

      expect(res.status).toBe(0);
      expect(logLines()).toContain('ran');
      expect(waitForLog(/^npm install/, 1500)).toBe(false);
    });

    it('lets it upgrade when the setting is on', () => {
      pinPlugin('1.26.0');
      installRuntime('1.25.0');
      globalConfig({ auto_update: true });
      launch('probe');
      expect(waitForLog(/^npm install eklavya@1\.26\.0 /)).toBe(true);
    });

    it('still installs a runtime that is missing entirely: that is bootstrap, not an upgrade', () => {
      pinPlugin('1.26.0');
      globalConfig({ auto_update: false });
      launch('probe');
      expect(waitForLog(/^npm install eklavya@1\.26\.0 /)).toBe(true);
    });

    it('never touches a pinned EKLAVYA_RUNTIME, whatever the setting', () => {
      pinPlugin('1.26.0');
      installRuntime('1.25.0');
      globalConfig({ auto_update: true });
      const res = spawnSync(process.execPath, [RUN, 'probe'], {
        env: { ...launchEnv(), EKLAVYA_RUNTIME: runtimePkg() },
        encoding: 'utf8',
        input: '{}',
      });
      expect(res.status).toBe(0);
      expect(logLines()).toContain('ran');
      expect(waitForLog(/^npm install/, 1500)).toBe(false);
    });
  });

  it('still runs the hook when npm is not on PATH', () => {
    // The background refresh cannot start, and that must stay its problem:
    // an unheard spawn error would kill the hook this run goes on to import.
    pinPlugin('2.0.0');
    installRuntime('1.9.0');
    const noNpm = path.join(tmp, 'empty-bin');
    fs.mkdirSync(noNpm);

    const res = launch('probe', noNpm);

    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    expect(logLines()).toContain('ran');
  });

  it('leaves a matching runtime alone', () => {
    pinPlugin('2.0.0');
    installRuntime('2.0.0');

    expect(launch('probe').status).toBe(0);
    expect(logLines()).toContain('ran');
    expect(waitForLog(/^npm/, 1000)).toBe(false);
  });

  it('never downgrades a runtime that is ahead of the plugin', () => {
    // Migrations only go forward: the newer runtime may already have moved the
    // database past what the older one understands.
    pinPlugin('1.9.0');
    installRuntime('2.0.0');

    expect(launch('probe').status).toBe(0);
    expect(logLines()).toContain('ran');
    expect(waitForLog(/^npm/, 1000)).toBe(false);
  });

  it('compares versions as numbers, not strings', () => {
    pinPlugin('1.10.0');
    installRuntime('1.9.0');

    launch('probe');
    expect(waitForLog(/^npm install eklavya@1\.10\.0 /)).toBe(true);
  });

  it('runs anyway when the runtime has no readable version', () => {
    pinPlugin('2.0.0');
    installRuntime('2.0.0');
    fs.writeFileSync(path.join(runtimePkg(), 'package.json'), JSON.stringify({ name: 'eklavya' }));

    expect(launch('probe').status).toBe(0);
    expect(logLines()).toContain('ran');
    expect(waitForLog(/^npm/, 1000)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('the npx fallback survives a release still publishing', () => {
  // semantic-release pushes the bumped plugin.json in its prepare step and runs
  // `npm publish` after it, so for a minute or so a marketplace pull can pin a
  // version npm does not have yet.
  it('retries eklavya@latest when the pinned version is not on npm', () => {
    pinPlugin('9.9.9');
    fakeBin(
      'npx',
      'case "$*" in *eklavya@latest*) exit 0 ;; esac\necho "npm error code ETARGET" >&2\necho "npm error notarget No matching version found for eklavya@9.9.9." >&2\nexit 1',
    );

    const res = launch('server');

    expect(res.status).toBe(0);
    expect(logLines()).toEqual(['npx --yes eklavya@9.9.9 serve', 'npx --yes eklavya@latest serve']);
  });

  it('does not retry a server that ran and then failed for its own reasons', () => {
    pinPlugin('9.9.9');
    fakeBin('npx', 'echo "Error: something inside the server" >&2\nexit 3');

    const res = launch('server');

    expect(res.status).toBe(3);
    expect(logLines()).toEqual(['npx --yes eklavya@9.9.9 serve']);
  });
});
