import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordBaseline, sessionChangedCode, treeFingerprint } from '../src/hooks/changes-lib.js';
import { openDb, type DB } from '../src/db.js';
import { tempDbPath, cleanup } from './helpers.js';

// Real repositories throughout: the module shells out to git, so a mock would
// only test the mock.

let repo: string;
let dbFile: string;
let db: DB;

const git = (...args: string[]) => {
  const res = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`);
};
const file = (rel: string) => path.join(repo, rel);
const write = (rel: string, body: string) => {
  fs.mkdirSync(path.dirname(file(rel)), { recursive: true });
  fs.writeFileSync(file(rel), body);
};
/**
 * An edit that keeps the size, with an mtime moved explicitly. Two writes in
 * the same millisecond would otherwise leave the stamp alone and make a test
 * pass or fail on timing.
 */
const touch = (rel: string) => {
  const t = fs.statSync(file(rel)).mtimeMs / 1000 + 5;
  fs.utimesSync(file(rel), t, t);
};
/** A real content change to a clean tracked file. */
const edit = () => write('a.ts', 'export const a = 2;\n');
const fp = () => treeFingerprint(repo);

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-changes-')));
  git('init', '-q');
  write('a.ts', 'export const a = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'init');
  dbFile = tempDbPath('changes');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('treeFingerprint', () => {
  it('is null outside a git repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-plain-'));
    try {
      expect(treeFingerprint(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('is stable while nothing changes', () => {
    expect(fp()).not.toBeNull();
    expect(fp()).toBe(fp());
  });

  it('is the same from a subfolder as from the root', () => {
    write('sub/b.ts', 'b\n');
    expect(treeFingerprint(path.join(repo, 'sub'))).toBe(fp());
  });

  it('changes when a tracked file is edited', () => {
    const before = fp();
    edit();
    expect(fp()).not.toBe(before);
  });

  // git compares content, so touching a clean file is no change at all.
  it('ignores a clean file whose mtime moved but whose content did not', () => {
    const before = fp();
    touch('a.ts');
    expect(fp()).toBe(before);
  });

  it('changes again when an already-dirty file is edited', () => {
    edit();
    const before = fp();
    touch('a.ts');
    expect(fp()).not.toBe(before);
  });

  it('changes when a file is created', () => {
    const before = fp();
    write('new.ts', 'n\n');
    expect(fp()).not.toBe(before);
  });

  it('changes when a tracked file is deleted', () => {
    const before = fp();
    fs.rmSync(file('a.ts'));
    expect(fp()).not.toBe(before);
  });

  // The regression: without -uall git reports `?? newpkg/`, and the folder's
  // own mtime does not move when a file two levels down is edited.
  it('changes when a file inside an already-untracked folder is edited', () => {
    write('newpkg/src/x.ts', 'export const x = 1;\n');
    const before = fp();
    touch('newpkg/src/x.ts');
    expect(fp()).not.toBe(before);
  });

  it('changes when a commit moves HEAD, even though the tree ends clean', () => {
    edit();
    git('add', '.');
    const staged = fp();
    git('commit', '-qm', 'two');
    expect(fp()).not.toBe(staged);
  });

  // A rename entry is `R  new\0old\0`: the stamp must come from the new path,
  // and the old path must not be read as an entry of its own.
  it('stamps a staged rename by its new path', () => {
    git('mv', 'a.ts', 'b.ts');
    const before = fp();
    expect(fp()).toBe(before);
    touch('b.ts');
    expect(fp()).not.toBe(before);
  });

  it('ignores gitignored files', () => {
    write('.gitignore', 'dist/\n');
    git('add', '.');
    git('commit', '-qm', 'ignore');
    const before = fp();
    write('dist/out.js', 'built\n');
    expect(fp()).toBe(before);
  });

  it('works on an unborn branch', () => {
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    git('init', '-q');
    const before = fp();
    expect(before).not.toBeNull();
    write('new.ts', 'n\n');
    expect(fp()).not.toBe(before);
  });
});

describe('sessionChangedCode', () => {
  it('is false right after the baseline and true once the tree changes', () => {
    recordBaseline(db, 's1', repo);
    expect(sessionChangedCode(db, 's1', repo)).toBe(false);
    edit();
    expect(sessionChangedCode(db, 's1', repo)).toBe(true);
  });

  it('keeps the first baseline when recorded again, as on a resume', () => {
    recordBaseline(db, 's1', repo);
    edit();
    recordBaseline(db, 's1', repo);
    expect(sessionChangedCode(db, 's1', repo)).toBe(true);
  });

  it('keeps sessions apart', () => {
    recordBaseline(db, 's1', repo);
    edit();
    recordBaseline(db, 's2', repo);
    expect(sessionChangedCode(db, 's1', repo)).toBe(true);
    expect(sessionChangedCode(db, 's2', repo)).toBe(false);
  });

  it('takes a late baseline for a session without one, then counts changes after it', () => {
    expect(sessionChangedCode(db, 's1', repo)).toBe(false);
    expect(sessionChangedCode(db, 's1', repo)).toBe(false);
    edit();
    expect(sessionChangedCode(db, 's1', repo)).toBe(true);
  });

  it('answers true outside a git repository, and records nothing there', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-plain-'));
    try {
      recordBaseline(db, 's1', plain);
      expect(db.prepare(`SELECT count(*) AS n FROM meta WHERE key LIKE 'tree_fp:%'`).get()).toEqual({ n: 0 });
      expect(sessionChangedCode(db, 's1', plain)).toBe(true);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('prunes baselines older than a week and keeps recent ones', () => {
    const old = new Date(Date.now() - 8 * 86_400_000).toISOString();
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('tree_fp:stale', `${old}|x`);
    recordBaseline(db, 's1', repo);
    const keys = (db.prepare(`SELECT key FROM meta WHERE key LIKE 'tree_fp:%'`).all() as { key: string }[]).map(
      (r) => r.key,
    );
    expect(keys).toEqual(['tree_fp:s1']);
  });
});
