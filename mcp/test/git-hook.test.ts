import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

/**
 * The installed git hook and the gate it runs, driven through real git in
 * throwaway repositories.
 *
 * The invariant every case here defends: the hook may hold a commit for one
 * reason only -- an enforced project whose session quiz has not passed. A moved
 * plugin, a missing tool, a broken file, a locked database: each lets the
 * commit through. A learning tool that bricks `git commit` gets uninstalled.
 */

const root = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const INSTALLER = path.join(root, 'scripts', 'install-git-hook.sh');
const GATE = path.join(root, 'cli', 'eklavya-gate');

// dash is the strictest POSIX sh commonly installed; use it when present so a
// bashism in either script fails here rather than on somebody's Debian box.
const SH = ['/bin/dash', '/usr/bin/dash'].find((p) => fs.existsSync(p)) ?? '/bin/sh';
const HAS_TOOLS = ['jq', 'sqlite3'].every((t) => spawnSync('sh', ['-c', `command -v ${t}`]).status === 0);

let scratch = '';
let home = '';
let repo = '';
let plugin = '';

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    EKLAVYA_HOME: home,
    EKLAVYA_DB: path.join(home, 'knowledge.db'),
    EKLAVYA_RUNTIME: path.join(home, 'runtime'),
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(home, 'gitconfig'),
    ...extra,
  };
}

function run(cmd: string, args: string[], cwd: string, extra: Record<string, string> = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env(extra) });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const git = (cwd: string, ...args: string[]) => run('git', args, cwd);
const install = (target: string, ...flags: string[]) =>
  run(SH, [path.join(plugin, 'scripts', 'install-git-hook.sh'), ...flags, target], scratch);

function newRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir);
  git(real, 'init', '-q');
  git(real, 'config', 'user.email', 't@t');
  git(real, 'config', 'user.name', 't');
  git(real, 'config', 'commit.gpgsign', 'false');
  return real;
}

function commit(cwd: string, file = 'f.txt') {
  fs.writeFileSync(path.join(cwd, file), String(Math.random()));
  git(cwd, 'add', file);
  return git(cwd, 'commit', '-q', '-m', 'x');
}

const hooks = (r: string) => path.join(r, '.git', 'hooks');

/** Enforced project config plus an unpassed gate row: the one state that blocks. */
function enforceAndOpenGate(r: string, passed = 0): void {
  const slug = r.replace(/[/\\:]/g, '-');
  const cfg = path.join(home, 'projects', slug, 'config.json');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ project: r, quiz: { enforced: true } }));
  const db = new Database(path.join(home, 'knowledge.db'));
  db.exec('CREATE TABLE IF NOT EXISTS gates (repo TEXT, passed INT, required INT, answered INT, updated_at TEXT)');
  db.prepare('INSERT INTO gates VALUES (?, ?, 2, 0, ?)').run(r, passed, new Date().toISOString());
  db.close();
}

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-githook-')));
  home = path.join(scratch, 'home');
  fs.mkdirSync(home);
  // A copy of the plugin layout, so a test can delete it the way an update does.
  plugin = path.join(scratch, 'plugin 1.0');
  fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(plugin, 'cli'), { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(plugin, 'scripts', 'install-git-hook.sh'));
  fs.copyFileSync(GATE, path.join(plugin, 'cli', 'eklavya-gate'));
  fs.chmodSync(path.join(plugin, 'cli', 'eklavya-gate'), 0o755);
  repo = newRepo(path.join(scratch, 'repo'));
});

afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('install-git-hook.sh', () => {
  it('installs an executable hook in an ordinary repository, and a commit runs through it', () => {
    const res = install(repo);
    expect(res.status).toBe(0);
    const hook = path.join(hooks(repo), 'pre-commit');
    expect(fs.statSync(hook).mode & 0o111).toBeGreaterThan(0);
    expect(fs.readFileSync(hook, 'utf8')).toContain('# >>> eklavya gate >>>');
    expect(commit(repo).status).toBe(0);
  });

  // The launch blocker: the hook exec'd an absolute path into a versioned
  // plugin directory, so the next plugin update made every commit fail with
  // "No such file or directory".
  it('lets commits through once the plugin directory it was installed from is gone', () => {
    expect(install(repo).status).toBe(0);
    fs.rmSync(plugin, { recursive: true, force: true });

    const res = commit(repo);
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/commit gate not found/);
  });

  it('still gates after the plugin directory is gone, when the installed runtime has the gate', () => {
    expect(install(repo).status).toBe(0);
    fs.rmSync(plugin, { recursive: true, force: true });
    const runtimeGate = path.join(home, 'runtime', 'node_modules', 'eklavya', 'dist', 'plugin', 'cli', 'eklavya-gate');
    fs.mkdirSync(path.dirname(runtimeGate), { recursive: true });
    fs.copyFileSync(GATE, runtimeGate);

    enforceAndOpenGate(repo);
    const res = commit(repo);
    if (HAS_TOOLS) {
      expect(res.status).not.toBe(0);
      expect(res.stderr).toMatch(/holding this commit/);
    } else {
      expect(res.status).toBe(0);
    }
  });

  it('prefers the installed runtime over the path it was installed from', () => {
    expect(install(repo).status).toBe(0);
    const runtimeGate = path.join(home, 'runtime', 'node_modules', 'eklavya', 'dist', 'plugin', 'cli', 'eklavya-gate');
    fs.mkdirSync(path.dirname(runtimeGate), { recursive: true });
    // Not executable on purpose: npm does not promise to keep the bit.
    fs.writeFileSync(runtimeGate, 'echo "runtime gate ran" >&2\nexit 0\n', { mode: 0o644 });
    expect(commit(repo).stderr).toMatch(/runtime gate ran/);
  });

  it('works in a repository whose path has spaces in it', () => {
    const spaced = newRepo(path.join(scratch, 'my repo', 'with spaces'));
    expect(install(spaced).status).toBe(0);
    expect(fs.existsSync(path.join(hooks(spaced), 'pre-commit'))).toBe(true);
    expect(commit(spaced).status).toBe(0);
    fs.rmSync(plugin, { recursive: true, force: true });
    expect(commit(spaced).status).toBe(0);
  });

  it('embeds an installer path holding shell metacharacters without breaking the hook', () => {
    const odd = path.join(scratch, 'we"ird $HOME `x` \\dir');
    fs.renameSync(plugin, odd);
    plugin = odd;
    fs.writeFileSync(path.join(plugin, 'cli', 'eklavya-gate'), 'echo "odd gate ran" >&2\nexit 0\n');
    expect(install(repo).status).toBe(0);
    const c = commit(repo);
    expect(c.status).toBe(0);
    expect(c.stderr).toMatch(/odd gate ran/);
  });

  // `.git` is a file in a linked worktree; `$REPO/.git/hooks` does not exist.
  it('installs into the shared hooks directory when run from a linked worktree', () => {
    commit(repo);
    const wt = path.join(scratch, 'wt');
    expect(git(repo, 'worktree', 'add', '-q', wt).status).toBe(0);

    const res = install(wt);
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(hooks(repo), 'pre-commit'))).toBe(true);
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);

    // The hook runs for a commit made in the worktree...
    fs.rmSync(plugin, { recursive: true, force: true });
    const c = commit(fs.realpathSync(wt));
    expect(c.status).toBe(0);
    expect(c.stderr).toMatch(/commit gate not found/);

    // ...and uninstalling from the worktree removes it.
    fs.mkdirSync(path.join(plugin, 'scripts'), { recursive: true });
    fs.copyFileSync(INSTALLER, path.join(plugin, 'scripts', 'install-git-hook.sh'));
    expect(install(wt, '--uninstall').stdout).toMatch(/Removed the Eklavya gate/);
    expect(fs.existsSync(path.join(hooks(repo), 'pre-commit'))).toBe(false);
  });

  it('refuses under core.hooksPath, writes nothing, and says how to call the gate', () => {
    git(repo, 'config', 'core.hooksPath', '.husky');
    fs.mkdirSync(path.join(repo, '.husky'));

    const res = install(repo);
    expect(res.status).toBe(2);
    expect(res.stdout).not.toMatch(/Installed/);
    expect(res.stderr).toMatch(/core\.hooksPath/);
    expect(res.stderr).toContain('dist/plugin/cli/eklavya-gate');
    expect(fs.existsSync(path.join(hooks(repo), 'pre-commit'))).toBe(false);
    expect(fs.readdirSync(path.join(repo, '.husky'))).toEqual([]);
  });

  it('prints a hook-manager line that fails open when the gate is missing, and still holds when it says no', () => {
    git(repo, 'config', 'core.hooksPath', '.husky');
    const res = install(repo);
    const line = res.stderr.split('\n').find((l) => l.includes('eklavya-gate'))?.trim();
    expect(line).toBeTruthy();

    // Pasted as the LAST line of a manager's hook, under `sh -e` as husky runs it.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-mgr-'));
    const hook = (tail: string) => ['-e', '-c', `echo before\n${line}\n${tail}`];
    const runHook = (tail = '') => spawnSync(SH, hook(tail), { encoding: 'utf8', env: { PATH: process.env.PATH, EKLAVYA_HOME: home } });

    const missing = runHook();
    expect(missing.status).toBe(0);

    const gate = path.join(home, 'runtime', 'node_modules', 'eklavya', 'dist', 'plugin', 'cli', 'eklavya-gate');
    fs.mkdirSync(path.dirname(gate), { recursive: true });
    fs.writeFileSync(gate, 'exit 1\n');
    expect(runHook().status).toBe(1);

    // A passing gate lets the rest of the manager's hook run.
    fs.writeFileSync(gate, 'exit 0\n');
    const pass = runHook('echo after');
    expect(pass.status).toBe(0);
    expect(pass.stdout).toMatch(/after/);
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('moves an existing hook aside and runs it first, including when it fails', () => {
    const hook = path.join(hooks(repo), 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "existing hook ran" >&2\n', { mode: 0o755 });
    expect(install(repo).status).toBe(0);
    expect(fs.readFileSync(path.join(hooks(repo), 'pre-commit.local'), 'utf8')).toMatch(/existing hook ran/);

    const ok = commit(repo);
    expect(ok.status).toBe(0);
    expect(ok.stderr).toMatch(/existing hook ran/);

    fs.writeFileSync(path.join(hooks(repo), 'pre-commit.local'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    expect(commit(repo).status).not.toBe(0);
  });

  it('refuses, and moves nothing, when both pre-commit and pre-commit.local already exist', () => {
    const hook = path.join(hooks(repo), 'pre-commit');
    const local = path.join(hooks(repo), 'pre-commit.local');
    fs.writeFileSync(hook, '#!/bin/sh\necho one\n', { mode: 0o755 });
    fs.writeFileSync(local, '#!/bin/sh\necho two\n', { mode: 0o755 });

    const res = install(repo);
    expect(res.status).toBe(1);
    expect(fs.readFileSync(hook, 'utf8')).toBe('#!/bin/sh\necho one\n');
    expect(fs.readFileSync(local, 'utf8')).toBe('#!/bin/sh\necho two\n');
  });

  it('keeps a pre-commit.local that is already there on its own, and chains it', () => {
    const local = path.join(hooks(repo), 'pre-commit.local');
    fs.writeFileSync(local, '#!/bin/sh\necho "local ran" >&2\n', { mode: 0o755 });
    expect(install(repo).status).toBe(0);
    expect(fs.readFileSync(local, 'utf8')).toMatch(/local ran/);
    expect(commit(repo).stderr).toMatch(/local ran/);
  });

  it('moves a dangling symlink aside rather than writing through it', () => {
    const hook = path.join(hooks(repo), 'pre-commit');
    const target = path.join(scratch, 'nowhere', 'hook');
    fs.symlinkSync(target, hook);
    expect(install(repo).status).toBe(0);
    expect(fs.lstatSync(path.join(hooks(repo), 'pre-commit.local')).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.lstatSync(hook).isSymbolicLink()).toBe(false);
  });

  it('is idempotent', () => {
    install(repo);
    const before = fs.readFileSync(path.join(hooks(repo), 'pre-commit'), 'utf8');
    const second = install(repo);
    expect(second.status).toBe(0);
    expect(second.stdout).toMatch(/already installed/);
    expect(fs.readFileSync(path.join(hooks(repo), 'pre-commit'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(hooks(repo), 'pre-commit.local'))).toBe(false);
  });

  // Every hook installed before this fix is the old one-line `exec` form.
  it('upgrades an old-format hook in place, keeping the chained hook', () => {
    const hook = path.join(hooks(repo), 'pre-commit');
    const local = path.join(hooks(repo), 'pre-commit.local');
    fs.writeFileSync(local, '#!/bin/sh\necho "mine" >&2\n', { mode: 0o755 });
    fs.writeFileSync(
      hook,
      [
        '#!/bin/sh',
        '# >>> eklavya gate >>>',
        '# Installed by Eklavya. Remove with scripts/install-git-hook.sh --uninstall',
        '',
        'if [ -x "$(dirname "$0")/pre-commit.local" ]; then',
        '  "$(dirname "$0")/pre-commit.local" "$@" || exit $?',
        'fi',
        '',
        'exec "/gone/plugins/cache/eklavya/1.0.0/cli/eklavya-gate"',
        '# <<< eklavya gate <<<',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    expect(commit(repo).status).not.toBe(0); // the bug, as shipped

    const res = install(repo);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/Updated/);
    expect(fs.readFileSync(hook, 'utf8')).not.toContain('/gone/');
    expect(fs.readFileSync(local, 'utf8')).toMatch(/mine/);
    const c = commit(repo);
    expect(c.status).toBe(0);
    expect(c.stderr).toMatch(/mine/);
  });

  it('restores the previous hook on uninstall', () => {
    const hook = path.join(hooks(repo), 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "existing hook ran"\n', { mode: 0o755 });
    install(repo);
    const res = install(repo, '--uninstall');
    expect(res.stdout).toMatch(/restored your previous/);
    expect(fs.readFileSync(hook, 'utf8')).toMatch(/existing hook ran/);
    expect(fs.existsSync(path.join(hooks(repo), 'pre-commit.local'))).toBe(false);
  });

  it('uninstall leaves a foreign hook alone', () => {
    const hook = path.join(hooks(repo), 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho mine\n', { mode: 0o755 });
    const res = install(repo, '--uninstall');
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/No Eklavya gate/);
    expect(fs.readFileSync(hook, 'utf8')).toBe('#!/bin/sh\necho mine\n');
  });

  it('fails with a clear message for a path that is not a repository', () => {
    const res = install(path.join(scratch, 'home'));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/not inside a git repository/);
  });

  it('the generated hook itself is POSIX sh', () => {
    install(repo);
    fs.rmSync(plugin, { recursive: true, force: true });
    const res = run(SH, [path.join(hooks(repo), 'pre-commit')], repo);
    expect(res.status).toBe(0);
  });
});

describe('eklavya-gate fails open on every broken dependency', () => {
  const gate = (extra: Record<string, string> = {}) => run(SH, [GATE], repo, extra);

  /** A PATH holding only the named tools, so one can be taken away. */
  function pathWith(tools: string[]): string {
    const bin = path.join(scratch, `bin-${tools.join('-')}`);
    fs.mkdirSync(bin, { recursive: true });
    for (const tool of tools) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found) fs.symlinkSync(found, path.join(bin, tool));
    }
    return bin;
  }
  const BASE = ['git', 'tr', 'cut', 'sed', 'cat', 'dirname'];

  it.runIf(HAS_TOOLS)('blocks in the one state it is meant to (the control for every case below)', () => {
    enforceAndOpenGate(repo);
    expect(gate().status).toBe(1);
  });

  it.runIf(HAS_TOOLS)('passes a gate that has been passed', () => {
    enforceAndOpenGate(repo, 1);
    expect(gate().status).toBe(0);
  });

  it('exits 0 without jq, and says why', () => {
    enforceAndOpenGate(repo);
    const res = gate({ PATH: pathWith([...BASE, 'sqlite3']) });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/jq not found/);
  });

  it('exits 0 without sqlite3, and says why', () => {
    enforceAndOpenGate(repo);
    const res = gate({ PATH: pathWith([...BASE, 'jq']) });
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/sqlite3 not found/);
  });

  it('exits 0 without git', () => {
    enforceAndOpenGate(repo);
    expect(gate({ PATH: pathWith(['jq', 'sqlite3', 'tr', 'cut', 'sed']) }).status).toBe(0);
  });

  it.runIf(HAS_TOOLS)('exits 0 when the database file is missing', () => {
    enforceAndOpenGate(repo);
    expect(gate({ EKLAVYA_DB: path.join(scratch, 'missing.db') }).status).toBe(0);
  });

  it.runIf(HAS_TOOLS)('exits 0 when the database is not a database', () => {
    enforceAndOpenGate(repo);
    const junk = path.join(scratch, 'junk.db');
    fs.writeFileSync(junk, 'this is not sqlite'.repeat(100));
    expect(gate({ EKLAVYA_DB: junk }).status).toBe(0);
  });

  it.runIf(HAS_TOOLS)('exits 0 when the database has no gates table', () => {
    enforceAndOpenGate(repo);
    const empty = path.join(scratch, 'empty.db');
    new Database(empty).close();
    expect(gate({ EKLAVYA_DB: empty }).status).toBe(0);
  });

  it.runIf(HAS_TOOLS)('exits 0 when the database stays locked past its timeout', () => {
    enforceAndOpenGate(repo);
    const db = new Database(path.join(home, 'knowledge.db'));
    db.pragma('locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    try {
      expect(gate().status).toBe(0);
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
  }, 15_000);

  it.runIf(HAS_TOOLS)('exits 0 when the project config is garbage', () => {
    enforceAndOpenGate(repo);
    const slug = repo.replace(/[/\\:]/g, '-');
    fs.writeFileSync(path.join(home, 'projects', slug, 'config.json'), '{ "quiz": { "enforced": true, ');
    expect(gate().status).toBe(0);
  });

  it.runIf(HAS_TOOLS)('exits 0 when the global config it has to consult is garbage', () => {
    enforceAndOpenGate(repo);
    fs.writeFileSync(path.join(home, 'config.json'), 'not json');
    expect(gate().status).toBe(0);
  });

  it('exits 0 with HOME and EKLAVYA_HOME unset', () => {
    const res = spawnSync(SH, [GATE], { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(res.status).toBe(0);
  });
});
