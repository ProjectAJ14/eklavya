import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { buildSource } from './claude-mem-fixture.js';
import { modelStep, press, RECOMMENDED_MODEL } from '../src/onboard.js';
import { DEFAULT_CONFIG } from '../src/config.js';

/**
 * `eklavya install` writes three files that belong to Claude Code, not to us:
 * known_marketplaces.json, installed_plugins.json and settings.json. There is no
 * public API for "install this plugin" from outside a session, so we reproduce
 * what `/plugin install` does — which means these tests are the only thing
 * standing between a bad edit and someone's Claude Code configuration.
 *
 * The install is driven through the built CLI rather than by importing it, so
 * what runs here is what a user runs.
 */
const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(mcpRoot, 'dist', 'cli.js');

let claudeHome = '';
let eklavyaHome = '';
// Claude Mem's data directory. Pointed at a temp path always: the developer
// running this suite may well have a real one, and it must never be seen.
let claudeMemHome = '';

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

function run(args: string[], cwd?: string) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeHome,
      EKLAVYA_HOME: eklavyaHome,
      EKLAVYA_DB: path.join(eklavyaHome, 'knowledge.db'),
      EKLAVYA_RUNTIME: path.join(eklavyaHome, 'runtime'),
      CLAUDE_MEM_DATA_DIR: claudeMemHome,
    },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

// `--skip-runtime` everywhere: the runtime step shells out to npm and would put
// a network fetch in the unit suite. What it does is verified by hand and by
// `verifyRuntime` at install time; what these tests own is the registry writing.
const install = () => run(['install', '--skip-runtime']);

/** Same install, but with a PATH we control, to pin what it says about the CLI. */
function installWithPath(dirs: string[]) {
  const res = spawnSync(process.execPath, [CLI, 'install', '--skip-runtime'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: dirs.join(path.delimiter),
      CLAUDE_CONFIG_DIR: claudeHome,
      EKLAVYA_HOME: eklavyaHome,
      EKLAVYA_DB: path.join(eklavyaHome, 'knowledge.db'),
      EKLAVYA_RUNTIME: path.join(eklavyaHome, 'runtime'),
      CLAUDE_MEM_DATA_DIR: claudeMemHome,
    },
  });
  return res.stdout ?? '';
}

beforeEach(() => {
  claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-claude-'));
  eklavyaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  claudeMemHome = path.join(eklavyaHome, 'no-claude-mem');
});

afterEach(() => {
  for (const dir of [claudeHome, eklavyaHome]) fs.rmSync(dir, { recursive: true, force: true });
});

describe('eklavya install', () => {
  it('registers the plugin the way /plugin install would', () => {
    expect(install().status).toBe(0);

    const marketplaces = readJson(path.join(claudeHome, 'plugins', 'known_marketplaces.json'));
    // The GitHub source is deliberate even though the files came from npm: it is
    // what lets Claude Code's own update path take over afterwards.
    expect(marketplaces.eklavya.source).toEqual({ source: 'github', repo: 'ProjectAJ14/eklavya' });
    expect(marketplaces.eklavya.autoUpdate).toBe(true);

    const installed = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
    expect(installed.version).toBe(2);
    expect(installed.plugins['eklavya@eklavya'][0].scope).toBe('user');

    const settings = readJson(path.join(claudeHome, 'settings.json'));
    expect(settings.enabledPlugins['eklavya@eklavya']).toBe(true);
  });

  it('puts the dials in the status bar, into an empty slot only', () => {
    install();
    const settings = readJson(path.join(claudeHome, 'settings.json'));
    expect(settings.statusLine.type).toBe('command');
    expect(settings.statusLine.command).toMatch(/dist\/cli\.js" statusline$/);
  });

  it('never writes over a status line somebody built themselves', () => {
    // `statusLine` holds one command, so "install ours" and "keep yours" cannot
    // both happen — and a status bar is a thing people build deliberately,
    // often with a script that took an afternoon.
    const settingsPath = path.join(claudeHome, 'settings.json');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'my-own-bar' } }));

    install();
    expect(readJson(settingsPath).statusLine.command).toBe('my-own-bar');
  });

  it('refreshes its own status line when the runtime path has moved', () => {
    const settingsPath = path.join(claudeHome, 'settings.json');
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(
      settingsPath,
      // Every Eklavya release wrote `…/node_modules/eklavya/dist/cli.js`.
      JSON.stringify({ statusLine: { type: 'command', command: 'node /somewhere/old/node_modules/eklavya/dist/cli.js statusline' } }),
    );

    install();
    const after = readJson(settingsPath).statusLine.command as string;
    expect(after).not.toContain('/somewhere/old/');
    expect(after).toMatch(/statusline$/);
  });

  it("leaves someone else's `node …/dist/cli.js statusline` alone", () => {
    const settingsPath = path.join(claudeHome, 'settings.json');
    fs.mkdirSync(claudeHome, { recursive: true });
    const theirs = 'node /Users/me/tools/mybar/dist/cli.js statusline';
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: theirs } }));

    install();
    expect(readJson(settingsPath).statusLine.command).toBe(theirs);
    run(['uninstall']);
    expect(readJson(settingsPath).statusLine.command).toBe(theirs);
  });

  it('copies a plugin Claude Code can actually load', () => {
    install();
    const dir = path.join(claudeHome, 'plugins', 'marketplaces', 'eklavya');
    for (const entry of ['.claude-plugin/plugin.json', '.mcp.json', 'hooks/run.mjs', 'hooks/hooks.json']) {
      expect(fs.existsSync(path.join(dir, entry)), `missing ${entry}`).toBe(true);
    }
  });

  it('creates and seeds the database, so `doctor` works before Claude Code is opened', () => {
    install();
    expect(fs.existsSync(path.join(eklavyaHome, 'knowledge.db'))).toBe(true);

    // These installs are `--skip-runtime`, so `doctor` is right to fail: what
    // this test owns is that it still *reports* — the registry writes above
    // landed, the database opened, and the one failure is the step we skipped.
    const res = run(['doctor']);
    expect(res.stdout).toMatch(/plugin\s.*registered, enabled/);
    expect(res.stdout).toMatch(/skill\s+\//);
    expect(res.stdout).toMatch(/concepts\s+\d+/);
    expect(res.stdout).toMatch(/runtime\s+FAILED/);
    expect(res.status).toBe(1);
  });

  it('is idempotent — running it twice is how you upgrade', () => {
    expect(install().status).toBe(0);
    const first = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
    const installedAt = first.plugins['eklavya@eklavya'][0].installedAt;

    expect(install().status).toBe(0);

    const second = readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
    const userEntries = second.plugins['eklavya@eklavya'].filter(
      (e: { scope: string }) => e.scope === 'user',
    );
    // One user entry, not two appended...
    expect(userEntries).toHaveLength(1);
    // ...and it reads as an upgrade rather than a fresh install.
    expect(userEntries[0].installedAt).toBe(installedAt);
  });

  it('keeps project-scoped installs of Eklavya itself', () => {
    // The value is an array, one entry per scope. Assigning a fresh array here
    // silently uninstalled the plugin from every project it had been added to.
    // That is data loss with no error and no warning, so it gets its own test.
    install();

    const installedPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
    const before = readJson(installedPath);
    before.plugins['eklavya@eklavya'].push({
      scope: 'local',
      projectPath: '/somewhere/else',
      version: '1.6.1',
    });
    fs.writeFileSync(installedPath, JSON.stringify(before));

    install();

    const after = readJson(installedPath).plugins['eklavya@eklavya'];
    const local = after.filter((e: { scope: string }) => e.scope === 'local');
    expect(local).toHaveLength(1);
    expect(local[0].projectPath).toBe('/somewhere/else');
    expect(local[0].version).toBe('1.6.1');
  });

  it('does not replace a marketplace directory git is managing', () => {
    // `/plugin marketplace add` clones the repo here and keeps it current, and
    // Eklavya's manifest lists its plugin at `./` -- so the checkout IS the
    // plugin. Replacing the directory would delete the clone and leave
    // autoUpdate pulling into nothing.
    install();

    const dir = path.join(claudeHome, 'plugins', 'marketplaces', 'eklavya');
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main');
    fs.writeFileSync(path.join(dir, 'LOCAL_EDIT'), 'x');

    const res = install();
    expect(res.status).toBe(0);

    expect(fs.existsSync(path.join(dir, '.git', 'HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'LOCAL_EDIT'))).toBe(true);
    // Not a real repository, so the pull cannot work -- and it says so rather
    // than looking like it did nothing.
    expect(res.stdout).toMatch(/could not pull/);
  });

  it('fast-forwards a clean marketplace checkout instead of leaving it stale', () => {
    // The upgrade path for someone who installed through `/plugin marketplace
    // add`: the files are a clone, so the way to move them to a new version is
    // a pull, and re-running the installer should do it.
    const origin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-origin-'));
    const g = (dir: string, ...args: string[]) =>
      spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

    g(origin, 'init', '-q', '-b', 'main');
    g(origin, 'config', 'user.email', 't@example.com');
    g(origin, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(origin, 'plugin.json'), '{"version":"1"}');
    g(origin, 'add', '-A');
    g(origin, 'commit', '-qm', 'one');

    const dir = path.join(claudeHome, 'plugins', 'marketplaces', 'eklavya');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    spawnSync('git', ['clone', '-q', origin, dir], { encoding: 'utf8' });

    fs.writeFileSync(path.join(origin, 'plugin.json'), '{"version":"2"}');
    g(origin, 'commit', '-qam', 'two');

    const res = install();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/pulled/);
    expect(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).toContain('"2"');

    // Second run has nothing to pull, and does not pretend otherwise.
    expect(install().stdout).toMatch(/already current/);

    // A dirty checkout is somebody's work in progress: left exactly as it is.
    fs.writeFileSync(path.join(dir, 'plugin.json'), '{"version":"mine"}');
    fs.writeFileSync(path.join(origin, 'plugin.json'), '{"version":"3"}');
    g(origin, 'commit', '-qam', 'three');

    const dirty = install();
    expect(dirty.stdout).toMatch(/local changes/);
    expect(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')).toContain('mine');

    fs.rmSync(origin, { recursive: true, force: true });
  });

  it('leaves other plugins and unrelated settings alone', () => {
    install();

    const settingsPath = path.join(claudeHome, 'settings.json');
    const settings = readJson(settingsPath);
    settings.enabledPlugins['other@else'] = true;
    settings.model = 'opus';
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    install();

    const after = readJson(settingsPath);
    expect(after.enabledPlugins['other@else']).toBe(true);
    expect(after.model).toBe('opus');
  });
});

describe('install with Claude Mem present', () => {
  // Two recorders means every session captured and recalled twice. Install asks
  // once which one keeps recording, and every path out of it leaves exactly one.
  let checkout = '';
  let memDir = '';

  beforeEach(() => {
    memDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cmem-'));
    claudeMemHome = memDir;
    buildSource(path.join(memDir, 'claude-mem.db'));

    // The fixture's one session is `content-1` in project `demo-repo`. Claude
    // Code's transcript for that session is what says where the checkout is.
    checkout = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'demo-repo-')));
    fs.mkdirSync(path.join(checkout, '.git'));
    const transcripts = path.join(claudeHome, 'projects', checkout.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, 'content-1.jsonl'), `${JSON.stringify({ cwd: checkout })}\n`);

    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(
      path.join(claudeHome, 'settings.json'),
      JSON.stringify({ enabledPlugins: { 'claude-mem@thedotmack': true } }),
    );
  });

  afterEach(() => {
    for (const dir of [memDir, `${memDir}.retired`, checkout]) fs.rmSync(dir, { recursive: true, force: true });
  });

  const memoryEnabled = () => {
    const file = path.join(eklavyaHome, 'config.json');
    return fs.existsSync(file) ? readJson(file).memory?.enabled : undefined;
  };

  it('choosing Eklavya imports the history under its checkout and retires Claude Mem', () => {
    // No `claude` on PATH, so the plugin is switched off rather than uninstalled
    // -- and the suite never runs the real Claude Code CLI.
    const res = spawnSync(process.execPath, [CLI, 'install', '--skip-runtime', '--memory', 'eklavya'], {
      encoding: 'utf8',
      env: {
        PATH: path.dirname(process.execPath),
        HOME: os.homedir(),
        CLAUDE_CONFIG_DIR: claudeHome,
        EKLAVYA_HOME: eklavyaHome,
        EKLAVYA_DB: path.join(eklavyaHome, 'knowledge.db'),
        EKLAVYA_RUNTIME: path.join(eklavyaHome, 'runtime'),
        CLAUDE_MEM_DATA_DIR: memDir,
      },
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/claude-mem\s+\d+ rows, all here — \d+ imported/);

    const settings = readJson(path.join(claudeHome, 'settings.json'));
    expect(settings.enabledPlugins['claude-mem@thedotmack']).toBe(false);
    // Switching it off is a write to the developer's settings, so it is backed
    // up like every other one; the backup still has Claude Mem switched on.
    const backup = readJson(path.join(claudeHome, 'settings.json.eklavya-bak'));
    expect(backup.enabledPlugins['claude-mem@thedotmack']).toBe(true);
    expect(fs.existsSync(memDir)).toBe(false);
    expect(fs.existsSync(path.join(`${memDir}.retired`, 'claude-mem.db'))).toBe(true);
    expect(memoryEnabled()).toBeUndefined();

    const db = new Database(path.join(eklavyaHome, 'knowledge.db'), { readonly: true });
    const projects = db.prepare('SELECT DISTINCT project FROM memory_entries').all() as { project: string }[];
    db.close();
    expect(projects.map((p) => p.project)).toContain(checkout);

    // The move is finished: a later install, with no terminal to ask, must not
    // see the switched-off plugin as Claude Mem still recording -- that path
    // picks "keep Claude Mem" and would turn Eklavya's memory back off. It
    // does re-check the retired copy, and finds nothing to add.
    const later = install();
    expect(later.stdout).not.toMatch(/Claude Mem is installed too/);
    expect(later.stdout).toMatch(/claude-mem\s+\d+ rows, all here — nothing new/);
    expect(later.stdout).toMatch(/memory\s+on/);
    expect(memoryEnabled()).toBeUndefined();
  });

  it('choosing Claude Mem turns Eklavya memory off and touches nothing of Claude Mem', () => {
    expect(run(['install', '--skip-runtime', '--memory', 'claude-mem']).status).toBe(0);
    expect(memoryEnabled()).toBe(false);
    expect(fs.existsSync(path.join(memDir, 'claude-mem.db'))).toBe(true);
    expect(readJson(path.join(claudeHome, 'settings.json')).enabledPlugins['claude-mem@thedotmack']).toBe(true);
  });

  it('--memory eklavya reopens an earlier "keep Claude Mem" and turns memory back on', () => {
    run(['install', '--skip-runtime', '--memory', 'claude-mem']);
    expect(memoryEnabled()).toBe(false);
    const res = run(['install', '--skip-runtime', '--memory', 'eklavya']);
    expect(res.stdout).toContain('imported');
    expect(memoryEnabled()).toBe(true);
  });

  it('asks nothing on a later install once Claude Mem was kept', () => {
    run(['install', '--skip-runtime', '--memory', 'claude-mem']);
    expect(install().stdout).not.toContain('Claude Mem is installed');
  });

  it('a source it cannot read keeps Claude Mem and leaves exactly one recorder', () => {
    fs.writeFileSync(path.join(memDir, 'claude-mem.db'), 'not a database');
    const res = run(['install', '--skip-runtime', '--memory', 'eklavya']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('import failed');
    expect(memoryEnabled()).toBe(false);
    expect(fs.existsSync(path.join(memDir, 'claude-mem.db'))).toBe(true);
    expect(readJson(path.join(claudeHome, 'settings.json')).enabledPlugins['claude-mem@thedotmack']).toBe(true);
  });

  it('with no terminal to ask, takes the choice that touches nothing of theirs', () => {
    expect(install().status).toBe(0);
    expect(memoryEnabled()).toBe(false);
    expect(fs.existsSync(path.join(memDir, 'claude-mem.db'))).toBe(true);
  });
});

describe('install with no Claude Mem', () => {
  it('asks nothing and leaves memory on', () => {
    const res = install();
    expect(res.stdout).not.toContain('Claude Mem');
    expect(fs.existsSync(path.join(eklavyaHome, 'config.json'))).toBe(false);
  });
});

describe('install walks the dials', () => {
  it('without a terminal, shows every setting and writes nothing', () => {
    const res = install();
    for (const row of [/quiz\s+on/, /focus\s+concept/, /cadence\s+interleaved/, /difficulty\s+auto/, /memory\s+on/]) {
      expect(res.stdout).toMatch(row);
    }
    expect(res.stdout).toContain('unchanged');
    expect(fs.existsSync(path.join(eklavyaHome, 'config.json'))).toBe(false);
  });

  it('shows what was chosen before, not the defaults', () => {
    fs.writeFileSync(
      path.join(eklavyaHome, 'config.json'),
      JSON.stringify({ quiz: { enabled: true, enforced: true }, focus: 'learn', focus_topic: 'oauth', cadence: 'end' }),
    );
    const out = install().stdout;
    expect(out).toMatch(/quiz\s+enforced/);
    expect(out).toMatch(/focus\s+learn · oauth/);
    expect(out).toMatch(/cadence\s+end/);
    expect(out).toContain('install-git-hook.sh');
  });

  it('says when the checkout it runs in overrides the global settings', () => {
    const repo = path.join(eklavyaHome, 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    expect(run(['config', 'set', 'focus', 'project', '--project'], repo).status).toBe(0);
    const out = run(['install', '--skip-runtime'], repo).stdout;
    expect(out).toMatch(/focus\s+concept/);
    expect(out).toMatch(/this checkout overrides focus/);
    expect(install().stdout).not.toContain('overrides');
  });

  it('refuses a --memory value it does not know, before touching anything', () => {
    const res = run(['install', '--skip-runtime', '--memory', 'both']);
    expect(res.status).toBe(1);
    expect(fs.existsSync(path.join(claudeHome, 'settings.json'))).toBe(false);
  });

  it('moves with the arrows, wraps at the ends, chooses on Enter, Space, → or a digit', () => {
    expect(press(0, 3, { name: 'down' })).toEqual({ at: 1, done: false });
    expect(press(0, 3, { name: 'up' })).toEqual({ at: 2, done: false });
    expect(press(2, 3, { name: 'down' })).toEqual({ at: 0, done: false });
    for (const name of ['return', 'space', 'right']) expect(press(1, 3, { name })).toEqual({ at: 1, done: true });
    expect(press(0, 3, { sequence: '3' })).toEqual({ at: 2, done: true });
    expect(press(0, 3, { sequence: '9' })).toBeNull();
    expect(press(0, 3, { name: 'x', sequence: 'x' })).toBeNull();
  });

  it('starts the model step on local, recommends one model, and keeps a hand-set one choosable', () => {
    const fresh = modelStep(DEFAULT_CONFIG);
    expect(fresh.current).toBe('local');
    expect(fresh.options.find((o) => o.value === RECOMMENDED_MODEL)?.detail).toMatch(/^recommended/);
    const custom = modelStep({
      ...DEFAULT_CONFIG,
      providers: { ...DEFAULT_CONFIG.providers, observer: { kind: 'anthropic', model: 'claude-x' } },
    });
    expect(custom.current).toBe('claude-x');
    expect(custom.options.map((o) => o.value)).toContain('claude-x');
  });
});

describe('what install says about the eklavya command', () => {
  // `npx eklavya install` leaves no `eklavya` on PATH, so promising one sends
  // the reader straight into `command not found` — which is exactly what it
  // used to do.
  it('does not promise a command that is not there', () => {
    const out = installWithPath([fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-nopath-'))]);
    expect(out).toContain('not on your PATH');
    expect(out).toContain('npm install -g eklavya');
    expect(out).not.toContain('`eklavya doctor` here');
  });

  it('offers the command when it really is on PATH', () => {
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-bin-'));
    const name = process.platform === 'win32' ? 'eklavya.cmd' : 'eklavya';
    fs.writeFileSync(path.join(binDir, name), '');
    const out = installWithPath([binDir]);
    expect(out).toContain('`eklavya doctor` checks the wiring');
    expect(out).not.toContain('not on your PATH');
  });
});

describe('the user-level skill', () => {
  const skill = () => path.join(claudeHome, 'skills', 'eklavya', 'SKILL.md');

  it('lands in the user skills directory', () => {
    install();
    expect(fs.existsSync(skill())).toBe(true);
    // The description is what the model matches on to decide whether to load
    // the skill at all, so an empty or renamed one makes the skill unreachable.
    const text = fs.readFileSync(skill(), 'utf8');
    expect(text).toMatch(/^name: eklavya$/m);
    expect(text).toMatch(/^description: /m);
  });

  it('is replaced rather than merged when installed twice', () => {
    install();
    fs.writeFileSync(path.join(claudeHome, 'skills', 'eklavya', 'stale.md'), 'from an older version');

    install();

    // Same rule as the plugin payload: a stale file left behind is worse than
    // a slow copy.
    expect(fs.existsSync(path.join(claudeHome, 'skills', 'eklavya', 'stale.md'))).toBe(false);
    expect(fs.existsSync(skill())).toBe(true);
  });

  it('refuses to overwrite a skill that is not ours', () => {
    // ~/.claude/skills is the user's own namespace. A name collision there is
    // somebody's hand-written skill, and taking it would be indistinguishable
    // from data loss.
    const theirs = '---\nname: my-eklavya-notes\ndescription: mine\n---\n\nDo not touch.\n';
    fs.mkdirSync(path.join(claudeHome, 'skills', 'eklavya'), { recursive: true });
    fs.writeFileSync(skill(), theirs);

    const res = install();

    expect(res.status).toBe(0);
    expect(fs.readFileSync(skill(), 'utf8')).toBe(theirs);
    // Silently skipping would leave them wondering why plain chat does nothing.
    expect(res.stdout).toMatch(/not ours/);
  });
});

describe('eklavya uninstall', () => {

  it('removes only the status line it wrote, and leaves anyone else\'s', () => {
    install();
    const settingsPath = path.join(claudeHome, 'settings.json');
    expect(readJson(settingsPath).statusLine).toBeTruthy();
    run(['uninstall']);
    expect(readJson(settingsPath).statusLine).toBeUndefined();

    // And the other way round: a line this installer did not write survives.
    fs.writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'my-own-bar' } }));
    run(['uninstall']);
    expect(readJson(settingsPath).statusLine.command).toBe('my-own-bar');
  });
  it('removes every trace of the registration', () => {
    install();
    expect(run(['uninstall']).status).toBe(0);

    expect(readJson(path.join(claudeHome, 'plugins', 'known_marketplaces.json')).eklavya).toBeUndefined();
    expect(
      readJson(path.join(claudeHome, 'plugins', 'installed_plugins.json')).plugins['eklavya@eklavya'],
    ).toBeUndefined();
    expect(
      readJson(path.join(claudeHome, 'settings.json')).enabledPlugins['eklavya@eklavya'],
    ).toBeUndefined();
    expect(fs.existsSync(path.join(claudeHome, 'plugins', 'marketplaces', 'eklavya'))).toBe(false);
    expect(fs.existsSync(path.join(claudeHome, 'skills', 'eklavya'))).toBe(false);
  });

  it('leaves a skill it did not install', () => {
    install();
    const skill = path.join(claudeHome, 'skills', 'eklavya', 'SKILL.md');
    const theirs = '---\nname: my-eklavya-notes\ndescription: mine\n---\n\nDo not touch.\n';
    fs.writeFileSync(skill, theirs);

    run(['uninstall']);

    expect(fs.readFileSync(skill, 'utf8')).toBe(theirs);
  });

  it('keeps the learning history unless asked to delete it', () => {
    install();
    const db = path.join(eklavyaHome, 'knowledge.db');
    expect(fs.existsSync(db)).toBe(true);

    run(['uninstall']);
    // Months of spaced repetition. An uninstall that takes this without being
    // asked is not an uninstall, it is data loss.
    expect(fs.existsSync(db)).toBe(true);
  });

  it('deletes the learning history on --purge, and only then', () => {
    install();
    run(['uninstall', '--purge']);
    expect(fs.existsSync(path.join(eklavyaHome, 'knowledge.db'))).toBe(false);
  });

  it('keeps the shared directory while a project still installs from it', () => {
    install();

    const installedPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
    const before = readJson(installedPath);
    before.plugins['eklavya@eklavya'].push({
      scope: 'local',
      projectPath: '/somewhere/else',
      version: '1.6.1',
    });
    fs.writeFileSync(installedPath, JSON.stringify(before));

    const res = run(['uninstall']);
    expect(res.status).toBe(0);

    // Deleting it would leave that project pointing at nothing.
    expect(fs.existsSync(path.join(claudeHome, 'plugins', 'marketplaces', 'eklavya'))).toBe(true);
    const after = readJson(installedPath).plugins['eklavya@eklavya'];
    expect(after).toHaveLength(1);
    expect(after[0].scope).toBe('local');
    // And the person is told, with the path, instead of it happening silently.
    expect(res.stdout).toMatch(/somewhere\/else/);
  });

  it('does not disturb a neighbouring plugin', () => {
    install();

    const settingsPath = path.join(claudeHome, 'settings.json');
    const settings = readJson(settingsPath);
    settings.enabledPlugins['other@else'] = true;
    fs.writeFileSync(settingsPath, JSON.stringify(settings));

    const marketplacesPath = path.join(claudeHome, 'plugins', 'known_marketplaces.json');
    const marketplaces = readJson(marketplacesPath);
    marketplaces['someone-else'] = { source: { source: 'github', repo: 'other/thing' } };
    fs.writeFileSync(marketplacesPath, JSON.stringify(marketplaces));

    run(['uninstall']);

    expect(readJson(settingsPath).enabledPlugins['other@else']).toBe(true);
    expect(readJson(marketplacesPath)['someone-else']).toBeDefined();
  });
});

describe('a file Eklavya cannot read is never overwritten', () => {
  // Eklavya once read an unparseable settings.json as `{}` and wrote its three
  // keys over the top: the developer's permissions, hooks and env, gone. A file
  // that is not a JSON object stops the command before anything is written --
  // not just that file, every file, so there is never a half-registration.
  const files = {
    settings: () => path.join(claudeHome, 'settings.json'),
    marketplaces: () => path.join(claudeHome, 'plugins', 'known_marketplaces.json'),
    installed: () => path.join(claudeHome, 'plugins', 'installed_plugins.json'),
  };
  const broken: Record<string, string> = {
    'a trailing comma': '{"model": "opus", "permissions": {"allow": ["Bash"]},}\n',
    'a comment': '{\n  // my settings\n  "model": "opus"\n}\n',
    'a truncated file': '{"model": "opus", "permissions": {"allow": ["Ba',
    'an array at the top level': '["model", "opus"]\n',
  };

  /** Every file under the Claude and Eklavya homes, with its bytes. */
  const snapshot = () => {
    const out: Record<string, string> = {};
    const walk = (dir: string) => {
      for (const e of fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else out[p] = fs.readFileSync(p, 'utf8');
      }
    };
    walk(claudeHome);
    walk(eklavyaHome);
    return out;
  };

  for (const [which, file] of Object.entries(files)) {
    for (const [what, text] of Object.entries(broken)) {
      it(`install stops on ${which} with ${what}, and changes nothing anywhere`, () => {
        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), text);
        const before = snapshot();

        const res = install();

        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain(file());
        expect(res.stderr).toMatch(/did not change/);
        expect(snapshot()).toEqual(before);
      });
    }

    it(`uninstall stops on an unreadable ${which}, and changes nothing anywhere`, () => {
      expect(install().status).toBe(0);
      fs.writeFileSync(file(), broken['a trailing comma']!);
      const before = snapshot();

      const res = run(['uninstall']);

      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain(file());
      expect(snapshot()).toEqual(before);
    });
  }

  it('an unreadable global Eklavya config also stops install before anything is written', () => {
    const config = path.join(eklavyaHome, 'config.json');
    fs.writeFileSync(config, '{"quiz": {"enabled": false},}');
    const before = snapshot();

    const res = install();

    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain(config);
    expect(snapshot()).toEqual(before);
  });

  it('an empty settings.json is treated as missing, not as broken', () => {
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(files.settings(), '');
    expect(install().status).toBe(0);
    expect(readJson(files.settings()).enabledPlugins['eklavya@eklavya']).toBe(true);
  });
});

describe('what install and uninstall back up', () => {
  const settingsPath = () => path.join(claudeHome, 'settings.json');
  const original = `${JSON.stringify({ model: 'opus', permissions: { allow: ['Bash(ls)'] } }, null, 4)}\n`;

  beforeEach(() => {
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(settingsPath(), original);
  });

  it('keeps the previous settings.json byte for byte, and says where', () => {
    const res = install();
    expect(res.status).toBe(0);
    expect(fs.readFileSync(`${settingsPath()}.eklavya-bak`, 'utf8')).toBe(original);
    expect(res.stdout).toContain(`${settingsPath()}.eklavya-bak`);
  });

  it('does not back up a file that did not exist', () => {
    install();
    expect(fs.existsSync(path.join(claudeHome, 'plugins', 'installed_plugins.json.eklavya-bak'))).toBe(false);
    expect(fs.existsSync(path.join(claudeHome, 'plugins', 'known_marketplaces.json.eklavya-bak'))).toBe(false);
  });

  it('a second install changes nothing, so the backup still holds the original', () => {
    install();
    const registry = ['settings.json', 'plugins/installed_plugins.json', 'plugins/known_marketplaces.json'].map(
      (f) => path.join(claudeHome, f),
    );
    const after = registry.map((f) => fs.readFileSync(f, 'utf8'));

    const res = install();

    expect(res.status).toBe(0);
    expect(registry.map((f) => fs.readFileSync(f, 'utf8'))).toEqual(after);
    expect(fs.readFileSync(`${settingsPath()}.eklavya-bak`, 'utf8')).toBe(original);
    expect(res.stdout).not.toMatch(/eklavya-bak/);
  });

  it('uninstall backs up what it edits, and says where', () => {
    install();
    const installed = fs.readFileSync(settingsPath(), 'utf8');

    const res = run(['uninstall']);

    expect(res.status).toBe(0);
    expect(fs.readFileSync(`${settingsPath()}.eklavya-bak`, 'utf8')).toBe(installed);
    expect(res.stdout).toContain(`${settingsPath()}.eklavya-bak`);
    // One write per file: a second write would roll the backup forward onto
    // Eklavya's own half-finished state.
    const left = readJson(settingsPath());
    expect(left.statusLine).toBeUndefined();
    expect(left.enabledPlugins['eklavya@eklavya']).toBeUndefined();
    expect(left.model).toBe('opus');
  });
});

describe('the status line command', () => {
  const settingsPath = () => path.join(claudeHome, 'settings.json');

  it('quotes the script path, so a home directory with a space still works', () => {
    install();
    const command = readJson(settingsPath()).statusLine.command as string;
    expect(command).toMatch(/^node ".+dist[\\/]cli\.js" statusline$/);
  });

  it('refreshes the old unquoted form, including one broken by a space', () => {
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(
      settingsPath(),
      JSON.stringify({ statusLine: { type: 'command', command: 'node /Users/Jo Doe/.eklavya/runtime/node_modules/eklavya/dist/cli.js statusline' } }),
    );
    install();
    expect(readJson(settingsPath()).statusLine.command).toMatch(/^node ".+" statusline$/);
  });

  it('leaves a status line somebody composed around ours', () => {
    const composed = 'my-bar; node /x/dist/cli.js statusline';
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ statusLine: { type: 'command', command: composed } }));
    install();
    expect(readJson(settingsPath()).statusLine.command).toBe(composed);
    run(['uninstall']);
    expect(readJson(settingsPath()).statusLine.command).toBe(composed);
  });

  it('uninstall removes ours in the old unquoted form too', () => {
    install();
    const settings = readJson(settingsPath());
    settings.statusLine.command = (settings.statusLine.command as string).replace(/"/g, '');
    fs.writeFileSync(settingsPath(), JSON.stringify(settings));
    run(['uninstall']);
    expect(readJson(settingsPath()).statusLine).toBeUndefined();
  });
});

describe('uninstall says what it leaves and what it deletes', () => {
  it('keeps the runtime while a project still installs Eklavya', () => {
    install();
    const runtime = path.join(eklavyaHome, 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    const installedPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
    const before = readJson(installedPath);
    before.plugins['eklavya@eklavya'].push({ scope: 'local', projectPath: '/somewhere/else', version: '1.6.1' });
    fs.writeFileSync(installedPath, JSON.stringify(before));

    const res = run(['uninstall']);

    expect(res.status).toBe(0);
    expect(fs.existsSync(runtime)).toBe(true);
    expect(res.stdout).toMatch(/runtime\s+kept/);
  });

  it('removes the runtime when nothing else uses it', () => {
    install();
    const runtime = path.join(eklavyaHome, 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    run(['uninstall']);
    expect(fs.existsSync(runtime)).toBe(false);
  });

  it('warns about a commit gate in this repository, with the exact command to remove it', () => {
    install();
    const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-gate-repo-')));
    spawnSync('git', ['init', '-q'], { cwd: repoDir });
    const hook = path.join(repoDir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, '#!/bin/sh\n# >>> eklavya gate >>>\nexec "/gone/cli/eklavya-gate"\n# <<< eklavya gate <<<\n');

    const res = run(['uninstall'], repoDir);

    expect(res.status).toBe(0);
    expect(res.stdout).toContain(hook);
    expect(res.stdout).toMatch(/rm /);
    // Warned, not removed: it is the developer's repository.
    expect(fs.existsSync(hook)).toBe(true);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('says an old-format hook fails every commit, and a fail-open one only warns', () => {
    install();
    const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-gate-repo-')));
    spawnSync('git', ['init', '-q'], { cwd: repoDir });
    const hook = path.join(repoDir, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hook), { recursive: true });

    fs.writeFileSync(hook, '#!/bin/sh\n# >>> eklavya gate >>>\nexec "/gone/cli/eklavya-gate"\n# <<< eklavya gate <<<\n');
    const old = run(['uninstall'], repoDir).stdout;
    expect(old).toMatch(/fails every commit/);
    expect(old).not.toMatch(/lets commits through/);

    install();
    // The real script's output, so this tracks whatever the installer writes today.
    const script = path.join(mcpRoot, '..', 'scripts', 'install-git-hook.sh');
    fs.rmSync(hook);
    expect(spawnSync('sh', [script, repoDir], { encoding: 'utf8', env: { ...process.env, HOME: repoDir } }).status).toBe(0);
    const current = run(['uninstall'], repoDir).stdout;
    expect(current).toMatch(/lets commits through/);
    expect(current).not.toMatch(/fails every commit/);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('says nothing about a gate in a repository that has none', () => {
    install();
    const repoDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-gate-repo-')));
    spawnSync('git', ['init', '-q'], { cwd: repoDir });
    expect(run(['uninstall'], repoDir).stdout).not.toMatch(/pre-commit/);
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('--purge lists what it deleted', () => {
    install();
    const res = run(['uninstall', '--purge']);
    expect(res.stdout).toContain(eklavyaHome);
    expect(res.stdout).toMatch(/knowledge\.db/);
  });
});
