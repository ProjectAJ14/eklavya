import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The `doctor` lines for failures that are silent everywhere else — a runtime
 * the plugin has moved past, a commit gate missing the two tools it shells out
 * to, a config file that stopped parsing — and `memory export`'s refusal to
 * clobber a file. Driven through the built CLI against a fake install, with
 * every home pointed at a temp directory.
 */
const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(mcpRoot, 'dist', 'cli.js');

let tmp = '';
let home = '';
let claudeDir = '';
let runtimeDir = '';
let repo = '';
let bin = '';

function eklavya(args: string[], opts: { path?: string } = {}) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(opts.path ? { PATH: opts.path } : {}),
      EKLAVYA_HOME: home,
      EKLAVYA_DB: path.join(home, 'knowledge.db'),
      EKLAVYA_RUNTIME: runtimeDir,
      CLAUDE_CONFIG_DIR: claudeDir,
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/** Same fake install `cli.test.ts` builds, plus version files on both sides. */
function fakeInstall(runtime: string, plugin: string): void {
  const pkg = path.join(runtimeDir, 'node_modules', 'eklavya');
  fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'dist', 'server.js'), '');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'eklavya', version: runtime }));
  const driver = path.join(runtimeDir, 'node_modules', 'better-sqlite3');
  fs.mkdirSync(driver, { recursive: true });
  fs.writeFileSync(path.join(driver, 'package.json'), '{"main":"index.js"}');
  fs.writeFileSync(path.join(driver, 'index.js'), '');

  const market = path.join(claudeDir, 'plugins', 'marketplaces', 'eklavya');
  fs.mkdirSync(path.join(market, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(market, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: plugin }));
  fs.writeFileSync(
    path.join(claudeDir, 'plugins', 'installed_plugins.json'),
    JSON.stringify({ version: 2, plugins: { 'eklavya@eklavya': [{ scope: 'user', installPath: market }] } }),
  );
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'eklavya@eklavya': true } }));
  for (const name of ['eklavya', 'eklavya-artifacts']) {
    const skill = path.join(claudeDir, 'skills', name);
    fs.mkdirSync(skill, { recursive: true });
    fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: ${name}\n---\n`);
  }
}

/** A PATH holding node, git and exactly the extra tools named — nothing from /usr/bin. */
function pathWith(tools: string[]): string {
  fs.mkdirSync(bin, { recursive: true });
  const git = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nexec "${git}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  for (const tool of tools) {
    fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, tool), 0o755);
  }
  return [bin, path.dirname(process.execPath)].join(path.delimiter);
}

function installGateHook(): string {
  spawnSync('git', ['init', '-q'], { cwd: repo });
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\n# >>> eklavya gate >>>\nexec /x/cli/eklavya-gate\n# <<< eklavya gate <<<\n');
  return hook;
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-doctor-')));
  home = path.join(tmp, 'home');
  claudeDir = path.join(tmp, 'claude');
  runtimeDir = path.join(tmp, 'runtime');
  repo = path.join(tmp, 'repo');
  bin = path.join(tmp, 'bin');
  for (const d of [home, claudeDir, runtimeDir, repo]) fs.mkdirSync(d, { recursive: true });
  fakeInstall('2.0.0', '2.0.0');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('doctor: runtime and plugin versions', () => {
  it('says they match when they do', () => {
    const res = eklavya(['doctor']);
    expect(res.stdout).toMatch(/versions\s+runtime and plugin both 2\.0\.0/);
    expect(res.status).toBe(0);
  });

  it('fails when the runtime is behind the plugin, and says the next session heals it', () => {
    fakeInstall('1.9.0', '2.0.0');
    const res = eklavya(['doctor']);
    expect(res.stdout).toMatch(/versions\s+FAILED — runtime 1\.9\.0 is behind plugin 2\.0\.0/);
    expect(res.status).toBe(1);
  });

  it('fails when the runtime is ahead, and names the plugin update', () => {
    fakeInstall('2.1.0', '2.0.0');
    const res = eklavya(['doctor']);
    expect(res.stdout).toMatch(/versions\s+FAILED — runtime 2\.1\.0 is ahead of plugin 2\.0\.0 .*\/plugin update/);
    expect(res.status).toBe(1);
  });
});

describe.skipIf(process.platform === 'win32')('doctor: what the terminal commit gate needs', () => {
  it('fails when the gate is installed here and jq and sqlite3 are missing', () => {
    installGateHook();
    const res = eklavya(['doctor'], { path: pathWith([]) });
    expect(res.stdout).toMatch(/gate\s+FAILED — jq and sqlite3 not on PATH/);
    expect(res.status).toBe(1);
  });

  it('names just the one that is missing', () => {
    installGateHook();
    const res = eklavya(['doctor'], { path: pathWith(['jq']) });
    expect(res.stdout).toMatch(/gate\s+FAILED — sqlite3 not on PATH/);
  });

  it('is quiet about it when both are there', () => {
    const hook = installGateHook();
    const res = eklavya(['doctor'], { path: pathWith(['jq', 'sqlite3']) });
    expect(res.stdout).toContain(hook);
    expect(res.stdout).not.toMatch(/gate\s+FAILED/);
    expect(res.status).toBe(0);
  });

  it('only warns under enforced mode with no terminal gate installed', () => {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ quiz: { enabled: true, enforced: true } }));
    const res = eklavya(['doctor'], { path: pathWith([]) });
    expect(res.stdout).toMatch(/gate\s+jq and sqlite3 not on PATH/);
    expect(res.stdout).not.toMatch(/gate\s+FAILED/);
  });

  it('says nothing about jq when there is no gate and no enforcement', () => {
    const res = eklavya(['doctor'], { path: pathWith([]) });
    expect(res.stdout).not.toMatch(/jq/);
  });
});

describe('doctor: config files', () => {
  it('fails on a global config that will not parse, naming the file', () => {
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, '{"focus": "learn",}');
    const res = eklavya(['doctor']);
    expect(res.stdout).toContain(file);
    expect(res.stdout).toMatch(/config\s+FAILED/);
    expect(res.status).toBe(1);
  });
});

describe('doctor: the database line', () => {
  it('says it created the database instead of calling it "not created yet"', () => {
    const res = eklavya(['doctor']);
    expect(fs.existsSync(path.join(home, 'knowledge.db'))).toBe(true);
    expect(res.stdout).not.toMatch(/not created yet/);
    expect(res.stdout).toMatch(/database\s+.*created now/);
  });

  it('says nothing extra about a database that was already there', () => {
    eklavya(['doctor']);
    expect(eklavya(['doctor']).stdout).not.toMatch(/created now/);
  });
});

describe('memory export', () => {
  it('writes a file only its owner can read', () => {
    const out = path.join(tmp, 'export.json');
    expect(eklavya(['memory', 'export', out]).status).toBe(0);
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing file, and leaves it as it was', () => {
    const out = path.join(tmp, 'export.json');
    fs.writeFileSync(out, 'precious');
    const res = eklavya(['memory', 'export', out]);
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/--force/);
    expect(fs.readFileSync(out, 'utf8')).toBe('precious');
  });

  it('overwrites with --force, and tightens the mode of the file it replaced', () => {
    const out = path.join(tmp, 'export.json');
    fs.writeFileSync(out, 'old', { mode: 0o644 });
    expect(eklavya(['memory', 'export', out, '--force']).status).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, 'utf8')).entries).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(out).mode & 0o777).toBe(0o600);
  });
});
