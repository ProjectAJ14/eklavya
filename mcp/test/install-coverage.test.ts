/**
 * The installer's less-travelled paths (`install.ts`): a runtime that will not
 * load, a git checkout that will not pull, a skill slot that is not a file,
 * Claude Mem data that cannot be moved, and the health checks `doctor` prints.
 *
 * Spawned against the built CLI with a temp `CLAUDE_CONFIG_DIR`, `EKLAVYA_HOME`
 * and a PATH this file controls: fake `npm`, `git` and `claude` scripts go in
 * `bin`, so nothing here reaches the network or the real Claude Code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { buildSource } from './claude-mem-fixture.js';

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// The built module, not `src/`: `install` copies the plugin payload that sits
// beside it, and only `dist/` has one (`pretest` builds it).
const { claudeHome: claudeHomeFn, commandOnPath, gateHookFailsOpen, health, install } = (await import(
  pathToFileURL(path.join(mcpRoot, 'dist', 'install.js')).href
)) as typeof import('../src/install.js');
const CLI = path.join(mcpRoot, 'dist', 'cli.js');
const posix = process.platform !== 'win32';

let tmp = '';
let claudeHome = '';
let eklavyaHome = '';
let runtime = '';
let claudeMemHome = '';
let bin = '';

const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));

function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: claudeHome,
    EKLAVYA_HOME: eklavyaHome,
    EKLAVYA_DB: path.join(eklavyaHome, 'knowledge.db'),
    EKLAVYA_RUNTIME: runtime,
    CLAUDE_MEM_DATA_DIR: claudeMemHome,
    NO_COLOR: '1',
    PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter),
    ...extra,
  };
}

function run(args: string[], extra: NodeJS.ProcessEnv = {}, cwd?: string) {
  const res = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, env: env(extra), timeout: 30_000 });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const script = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

/** A config file, so install shows the settings instead of walking them. */
const configured = () => fs.writeFileSync(path.join(eklavyaHome, 'config.json'), '{}');

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-install-cov-')));
  claudeHome = path.join(tmp, 'claude');
  eklavyaHome = path.join(tmp, 'eklavya');
  runtime = path.join(eklavyaHome, 'runtime');
  claudeMemHome = path.join(tmp, 'no-claude-mem');
  bin = path.join(tmp, 'bin');
  for (const d of [claudeHome, eklavyaHome, bin]) fs.mkdirSync(d, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!posix)('the runtime step', () => {
  it('waits for a runtime install it cannot name the owner of', () => {
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, '.installing'), new Date().toISOString());
    const res = run(['install']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/another Eklavya install is running — let it finish/);
  });

  it('stops when npm reported success but left no compiled server', () => {
    script('npm', 'exit 0');
    const res = run(['install']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(`${path.join(runtime, 'node_modules', 'eklavya', 'dist', 'server.js')} is missing`);
  });

  it('stops when the SQLite driver installed but will not load, naming the error line', () => {
    const mods = path.join(runtime, 'node_modules');
    script(
      'npm',
      [
        `mkdir -p "${mods}/eklavya/dist" "${mods}/better-sqlite3"`,
        `: > "${mods}/eklavya/dist/server.js"`,
        `echo "throw new TypeError('wrong ABI')" > "${mods}/better-sqlite3/index.js"`,
      ].join('\n'),
    );
    const res = run(['install']);
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/will not load:\nTypeError: wrong ABI\n/);
  });

  it('marks the runtime it installed as applied and announced, so the next session says nothing', () => {
    const mods = path.join(runtime, 'node_modules');
    const version = readJson(path.join(mcpRoot, 'package.json')).version as string;
    script(
      'npm',
      [
        `mkdir -p "${mods}/eklavya/dist" "${mods}/better-sqlite3"`,
        `: > "${mods}/eklavya/dist/server.js"`,
        `echo 'module.exports = {}' > "${mods}/better-sqlite3/index.js"`,
        `echo '{"version":"${version}"}' > "${mods}/eklavya/package.json"`,
      ].join('\n'),
    );
    configured();
    const res = run(['install']);
    expect(res.status).toBe(0);
    expect(readJson(path.join(eklavyaHome, 'update.json'))).toMatchObject({ applied: version, announced: version });
  });
});

describe.skipIf(!posix)('a marketplace directory git manages', () => {
  const marketplace = () => path.join(claudeHome, 'plugins', 'marketplaces', 'eklavya');
  beforeEach(() => {
    fs.mkdirSync(path.join(marketplace(), '.git'), { recursive: true });
    configured();
  });

  it('is left alone when git cannot say where HEAD is, or is not installed at all', () => {
    script('git', '[ "$1" = --version ] && exit 0\nexit 1');
    expect(run(['install', '--skip-runtime']).stdout).toMatch(/git checkout — could not pull, left as it is/);

    fs.rmSync(path.join(bin, 'git'));
    const res = run(['install', '--skip-runtime'], { PATH: bin });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/could not pull/);
    expect(res.stdout).toMatch(/git\s+not found/);
  });

  it("passes on git's reason when the pull fails, and says nothing it does not have", () => {
    const fake = (pull: string) =>
      script('git', `case "$1" in\n  rev-parse) echo abc ;;\n  status) ;;\n  pull) ${pull} ;;\nesac\nexit 0`);
    fake('echo "fatal: no such remote" >&2; exit 1');
    const loud = run(['install', '--skip-runtime']);
    expect(loud.stderr).toContain('fatal: no such remote');
    expect(loud.stdout).toMatch(/pulling it failed/);

    fake('exit 1');
    const quiet = run(['install', '--skip-runtime']);
    expect(quiet.stdout).toMatch(/could not pull/);
    expect(quiet.stderr).toBe('');
  });
});

describe('what install leaves alone', () => {
  it('treats a skill slot it cannot read as somebody else’s', () => {
    configured();
    fs.mkdirSync(path.join(claudeHome, 'skills', 'eklavya', 'SKILL.md'), { recursive: true });
    const res = run(['install', '--skip-runtime']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/skipped — .*eklavya\/SKILL\.md is not ours/);
  });

  it('says why a retired Claude Mem database could not be re-checked, and carries on', () => {
    configured();
    fs.mkdirSync(`${claudeMemHome}.retired`);
    fs.writeFileSync(path.join(`${claudeMemHome}.retired`, 'claude-mem.db'), 'not a database');
    const res = run(['install', '--skip-runtime']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/could not check .*claude-mem\.db/);
  });

  it('looks for no retired database when Claude Mem’s folder has no parent', () => {
    configured();
    const res = run(['install', '--skip-runtime'], { CLAUDE_MEM_DATA_DIR: path.join(tmp, 'missing', 'deeper', '.claude-mem') });
    expect(res.status).toBe(0);
    expect(res.stdout).not.toMatch(/claude-mem/);
  });

  it('names the file when one turns unreadable halfway through, and stops', () => {
    configured();
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'claude-mem@x': true } }));
    // `claude plugin uninstall` fails -- after an editor saved a typo into settings.json.
    script('claude', `echo '{ broken' > "$CLAUDE_CONFIG_DIR/settings.json"; exit 1`);
    const res = run(['install', '--skip-runtime', '--memory', 'eklavya']);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain(path.join(claudeHome, 'settings.json'));
  });

  it('lets any other failure surface as itself', () => {
    configured();
    // A directory where the database should be: SQLite cannot open it.
    const res = run(['install', '--skip-runtime'], { EKLAVYA_DB: tmp });
    expect(res.status).not.toBe(0);
    expect(res.stderr).not.toBe('');
  });
});

describe.skipIf(!posix)('handing over from Claude Mem', () => {
  beforeEach(() => {
    configured();
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify({ enabledPlugins: { 'claude-mem@x': true } }));
    script('claude', 'exit 1');
  });

  it('leaves a data folder with no database where it is, and says so', () => {
    fs.mkdirSync(claudeMemHome);
    const res = run(['install', '--skip-runtime', '--memory', 'eklavya']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/plugin disabled/);
    expect(res.stdout).toContain(`data left at ${claudeMemHome}`);
    expect(fs.existsSync(claudeMemHome)).toBe(true);
  });

  it('warns, and keeps the data, when the folder cannot be moved', () => {
    const parent = path.join(tmp, 'ro');
    claudeMemHome = path.join(parent, 'mem');
    fs.mkdirSync(claudeMemHome, { recursive: true });
    const db = path.join(claudeMemHome, 'claude-mem.db');
    buildSource(db);
    // Out of WAL, so a read-only open needs no -shm file beside it.
    const src = new Database(db);
    src.pragma('journal_mode = DELETE');
    src.close();
    fs.chmodSync(parent, 0o555);
    try {
      const res = run(['install', '--skip-runtime', '--memory', 'eklavya']);
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/could not move it/);
      // Still there, so the next install checks it again: all here, nothing new.
      expect(run(['install', '--skip-runtime', '--memory', 'eklavya']).stdout).toMatch(/all here — nothing new/);
    } finally {
      fs.chmodSync(parent, 0o755);
    }
    expect(fs.existsSync(db)).toBe(true);
  });

  it('stops after the plugin when Claude Mem left no data folder', () => {
    const res = run(['install', '--skip-runtime', '--memory', 'eklavya']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/plugin disabled/);
    expect(res.stdout).not.toMatch(/data (left|moved)/);
  });

  it('lists the first four projects it could not place, and says there are more', () => {
    fs.mkdirSync(claudeMemHome);
    const db = path.join(claudeMemHome, 'claude-mem.db');
    buildSource(db);
    const src = new Database(db);
    const add = src.prepare(
      `INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
       SELECT memory_session_id, ?, 'change', 'extra', 'n', created_at, created_at_epoch FROM observations LIMIT 1`,
    );
    for (const p of ['p1', 'p2', 'p3', 'p4', 'p5']) add.run(p);
    src.close();
    const res = run(['install', '--skip-runtime', '--memory', 'eklavya']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/unplaced\s+\d+ project\(s\) — [^\n]*, …/);
  });
});

describe('uninstall, the rest of what it says', () => {
  it('deletes nothing it cannot list under --purge, and names project installs it cannot place', () => {
    run(['install', '--skip-runtime'], {});
    const installedPath = path.join(claudeHome, 'plugins', 'installed_plugins.json');
    const installed = readJson(installedPath);
    installed.plugins['eklavya@eklavya'].push({ scope: 'project' });
    fs.writeFileSync(installedPath, JSON.stringify(installed));
    fs.rmSync(eklavyaHome, { recursive: true, force: true });

    const res = run(['uninstall', '--purge']);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/runtime\s+removed — --purge asked for everything/);
    expect(res.stdout).toContain(`deleted ${eklavyaHome}`);
    expect(res.stdout).toContain('unknown project (?)');
  });

  it('has nothing to deregister from a machine it was never installed on', () => {
    const res = run(['uninstall']);
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(claudeHome, 'plugins', 'known_marketplaces.json'))).toBe(false);
  });

  it.skipIf(!posix)('gives the command that restores a chained hook', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(repo);
    spawnSync('git', ['init', '-q'], { cwd: repo });
    const hooks = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\n# >>> eklavya gate >>>\n# <<< eklavya gate <<<\n');
    fs.writeFileSync(path.join(hooks, 'pre-commit.local'), '#!/bin/sh\n');
    const res = run(['uninstall'], {}, repo);
    expect(res.stdout).toContain(`mv "${path.join(hooks, 'pre-commit.local')}" "${path.join(hooks, 'pre-commit')}"`);

    // Somebody else's pre-commit hook is not a gate to warn about.
    fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\nnpm test\n');
    expect(run(['uninstall'], {}, repo).stdout).not.toMatch(/commit gate/);
  });
});

describe('health', () => {
  const saved = { ...process.env };
  const mods = () => path.join(runtime, 'node_modules');
  const driver = (body: string) => {
    fs.mkdirSync(path.join(mods(), 'eklavya', 'dist'), { recursive: true });
    fs.writeFileSync(path.join(mods(), 'eklavya', 'dist', 'server.js'), '');
    fs.mkdirSync(path.join(mods(), 'better-sqlite3'), { recursive: true });
    fs.writeFileSync(path.join(mods(), 'better-sqlite3', 'index.js'), body);
  };
  const find = (name: string) => health().find((c) => c.name === name);

  beforeEach(() => {
    process.env.CLAUDE_CONFIG_DIR = claudeHome;
    process.env.EKLAVYA_HOME = eklavyaHome;
    process.env.EKLAVYA_RUNTIME = runtime;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('reports a driver failure by its last word, or as unknown when it says nothing', () => {
    driver("process.stderr.write('boom\\n'); process.exit(1)");
    expect(find('driver')).toMatchObject({ ok: false, detail: expect.stringMatching(/— boom$/) });
    driver('process.exit(1)');
    expect(find('driver')?.detail).toMatch(/— unknown error$/);
  });

  it('names an unreadable registry file, and an entry or switch that is missing', () => {
    const plugins = path.join(claudeHome, 'plugins');
    fs.mkdirSync(path.join(plugins, 'marketplaces', 'eklavya'), { recursive: true });
    fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), '{ nope');
    expect(find('plugin')?.detail).toMatch(/installed_plugins\.json is not valid JSON/);

    fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), '{}');
    expect(find('plugin')?.detail).toMatch(/on disk but not registered/);

    fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'eklavya@eklavya': [{ scope: 'user' }] } }));
    fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{}');
    expect(find('plugin')?.detail).toBe('registered but not enabled in settings.json');

    fs.writeFileSync(path.join(claudeHome, 'settings.json'), '{ nope');
    expect(find('plugin')?.detail).toMatch(/settings\.json is not valid JSON/);
  });

  it('compares the runtime with the plugin where Claude Code installed it', () => {
    driver('');
    fs.writeFileSync(path.join(mods(), 'eklavya', 'package.json'), JSON.stringify({ version: '2.0.0' }));
    const cache = path.join(tmp, 'cache', 'eklavya');
    fs.mkdirSync(path.join(cache, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(cache, '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '1.0.0' }));
    fs.mkdirSync(path.join(claudeHome, 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(claudeHome, 'plugins', 'installed_plugins.json'),
      JSON.stringify({ plugins: { 'eklavya@eklavya': [{ scope: 'project' }, { scope: 'user', installPath: cache }] } }),
    );
    expect(find('versions')?.detail).toMatch(/runtime 2\.0\.0 is ahead of plugin 1\.0\.0/);

    fs.writeFileSync(path.join(claudeHome, 'plugins', 'installed_plugins.json'), '{ nope');
    expect(find('versions')).toBeUndefined();
  });
});

describe('the small helpers', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('finds a command that is a file or a link, never a directory, and nothing without PATH', () => {
    const a = path.join(tmp, 'a');
    fs.mkdirSync(path.join(a, 'tool'), { recursive: true });
    process.env.PATH = a;
    expect(commandOnPath('tool')).toBe(false);
    fs.rmSync(path.join(a, 'tool'), { recursive: true });
    fs.symlinkSync(tmp, path.join(a, 'tool')); // a link, even to a directory, is taken as the command
    expect(commandOnPath('tool')).toBe(true);
    delete process.env.PATH;
    expect(commandOnPath('tool')).toBe(false);
  });

  it('defaults Claude Code’s home to ~/.claude', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(claudeHomeFn()).toBe(path.join(os.homedir(), '.claude'));
  });

  it('calls a hook it cannot read not fail-open', () => {
    expect(gateHookFailsOpen(path.join(tmp, 'gone'))).toBe(false);
  });
});

describe.skipIf(!posix)('install in a terminal', () => {
  const saved = { ...process.env };
  const real = {
    stdin: Object.getOwnPropertyDescriptor(process, 'stdin')!,
    stdout: Object.getOwnPropertyDescriptor(process, 'stdout')!,
  };
  let out = '';
  let input: PassThrough & { isTTY: boolean; setRawMode: (on: boolean) => unknown };

  beforeEach(() => {
    out = '';
    input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => input });
    const output = Object.assign(
      new Writable({
        write(chunk, _enc, cb) {
          out += String(chunk);
          cb();
        },
      }),
      { isTTY: true, columns: 100 },
    );
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    Object.defineProperty(process, 'stdout', { value: output, configurable: true });
    Object.assign(process.env, {
      CLAUDE_CONFIG_DIR: claudeHome,
      EKLAVYA_HOME: eklavyaHome,
      EKLAVYA_DB: path.join(eklavyaHome, 'knowledge.db'),
      EKLAVYA_RUNTIME: runtime,
      CLAUDE_MEM_DATA_DIR: claudeMemHome,
      PATH: [bin, '/usr/bin', '/bin'].join(path.delimiter),
    });
  });
  afterEach(() => {
    Object.defineProperty(process, 'stdin', real.stdin);
    Object.defineProperty(process, 'stdout', real.stdout);
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  async function until(check: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  }

  it('asks which checkout a Claude Mem project belongs to when two carry its name', async () => {
    configured();
    fs.mkdirSync(claudeMemHome);
    buildSource(path.join(claudeMemHome, 'claude-mem.db'));
    const a = path.join(tmp, 'work', 'local', 'demo-repo');
    const b = path.join(tmp, 'work', 'other', 'demo-repo');
    for (const d of [a, b]) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
    const gone = path.join(tmp, 'work', 'Personal', 'demo-repo');
    const transcripts = path.join(claudeHome, 'projects', gone.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(transcripts, { recursive: true });
    fs.writeFileSync(path.join(transcripts, 'content-1.jsonl'), `${JSON.stringify({ cwd: gone })}\n`);

    const done = install(['--skip-runtime', '--memory', 'eklavya']);
    await until(() => out.includes('checkouts carry this name'));
    input.write('2');
    await done;
    const db = new Database(path.join(eklavyaHome, 'knowledge.db'), { readonly: true });
    const projects = db.prepare('SELECT DISTINCT project FROM memory_entries').all() as { project: string }[];
    db.close();
    expect(projects.map((p) => p.project)).toContain(b);
    expect(fs.existsSync(`${claudeMemHome}.retired`)).toBe(true);
  }, 20_000);

  it('rethrows a failure that is not an unreadable file', async () => {
    input.setRawMode = () => {
      throw new Error('no raw mode');
    };
    await expect(install(['--skip-runtime', '--settings'])).rejects.toThrow('no raw mode');
  });
});
