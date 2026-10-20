import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { leadingCd, noteBashEdit, noteBuilder, noteEdit, recordBaseline, sessionChangedCode, treeFingerprint } from '../src/hooks/changes-lib.js';
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
/** Moves an absolute path's mtime clearly past any baseline stamped before it: filesystems keep coarser time than `Date.now()`. */
const later = (abs: string) => {
  const t = Date.now() / 1000 + 5;
  fs.utimesSync(abs, t, t);
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

  it('counts an edit-tool write into any git tree, including a sibling worktree', () => {
    // The OIP layout: started in the main checkout, editing a sibling worktree
    // by absolute path. This tree never moves; the session still wrote code.
    const sibling = `${repo}-worktrees/feat`;
    git('worktree', 'add', '-q', '-b', 'feat', sibling);
    try {
      recordBaseline(db, 's1', repo);
      recordBaseline(db, 's2', repo);
      expect(sessionChangedCode(db, 's1', repo)).toBe(false);
      fs.writeFileSync(path.join(sibling, 'b.ts'), 'b\n');
      noteEdit(db, 's1', path.join(sibling, 'b.ts'));
      expect(sessionChangedCode(db, 's1', repo)).toBe(true);
      // Another session's edit is not this one's.
      expect(sessionChangedCode(db, 's2', repo)).toBe(false);
    } finally {
      fs.rmSync(`${repo}-worktrees`, { recursive: true, force: true });
    }
  });

  it('counts a Bash edit in the tree a leading cd names, and nothing before the session began', () => {
    const sibling = `${repo}-worktrees/feat`;
    git('worktree', 'add', '-q', '-b', 'feat', sibling);
    try {
      // Dirty before the session, and untouched since: not this session's work.
      fs.writeFileSync(path.join(sibling, 'old.ts'), 'o\n');
      const past = Date.now() / 1000 - 60;
      fs.utimesSync(path.join(sibling, 'old.ts'), past, past);
      recordBaseline(db, 's1', repo);
      recordBaseline(db, 's2', repo);
      noteBashEdit(db, 's1', repo, `cd ${sibling} && git status`);
      expect(sessionChangedCode(db, 's1', repo)).toBe(false);
      // No leading cd: the session's own tree, which the fingerprint covers.
      fs.writeFileSync(path.join(sibling, 'b.ts'), 'b\n');
      noteBashEdit(db, 's1', repo, `sed -i '' s/a/b/ ${sibling}/b.ts`);
      expect(sessionChangedCode(db, 's1', repo)).toBe(false);
      noteBashEdit(db, 's1', repo, `cd "${sibling}"; sed -i '' s/a/b/ b.ts`);
      expect(sessionChangedCode(db, 's1', repo)).toBe(true);
      expect(sessionChangedCode(db, 's2', repo)).toBe(false);
    } finally {
      fs.rmSync(`${repo}-worktrees`, { recursive: true, force: true });
    }
  });

  it('does not count a deletion there, which has no mtime to date it, and stops looking once marked', () => {
    const sibling = `${repo}-worktrees/feat`;
    git('worktree', 'add', '-q', '-b', 'feat', sibling);
    try {
      recordBaseline(db, 's1', repo);
      fs.rmSync(path.join(sibling, 'a.ts'));
      noteBashEdit(db, 's1', repo, `cd ${sibling} && rm a.ts`);
      expect(sessionChangedCode(db, 's1', repo)).toBe(false);
      fs.writeFileSync(path.join(sibling, 'b.ts'), 'b\n');
      noteBashEdit(db, 's1', repo, `cd ${sibling} && true`);
      noteBashEdit(db, 's1', repo, `cd ${sibling} && true`);
      expect(sessionChangedCode(db, 's1', repo)).toBe(true);
    } finally {
      fs.rmSync(`${repo}-worktrees`, { recursive: true, force: true });
    }
  });

  it('marks nothing from a Bash edit without a baseline, or outside any tree', () => {
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-plain-')));
    try {
      edit();
      noteBashEdit(db, 's1', repo, `cd ${repo} && true`);
      recordBaseline(db, 's2', repo);
      fs.writeFileSync(path.join(plain, 'x.ts'), 'x\n');
      noteBashEdit(db, 's2', repo, `cd ${plain} && true`);
      noteBashEdit(db, 's2', repo, 'cd $HOME && true');
      expect(db.prepare(`SELECT count(*) AS n FROM meta WHERE key LIKE 'code_edit:%'`).get()).toEqual({ n: 0 });
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('does not count research writes outside any tree, or ignored files', () => {
    const notes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-notes-')));
    try {
      write('.gitignore', 'dist/\n');
      git('add', '.gitignore');
      git('commit', '-qm', 'ignore');
      recordBaseline(db, 's1', repo);
      recordBaseline(db, 's3', repo);
      fs.writeFileSync(path.join(notes, 'memory.md'), 'n\n');
      noteEdit(db, 's1', path.join(notes, 'memory.md'));
      write('dist/out.js', 'x\n');
      noteEdit(db, 's3', file('dist/out.js'));
      expect(sessionChangedCode(db, 's1', repo)).toBe(false);
      expect(sessionChangedCode(db, 's3', repo)).toBe(false);
    } finally {
      fs.rmSync(notes, { recursive: true, force: true });
    }
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

  it('answers from the edit marker alone outside a git repository, recording only the start time', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-plain-'));
    try {
      recordBaseline(db, 's1', plain);
      expect(db.prepare(`SELECT value FROM meta WHERE key = 'tree_fp:s1'`).get()).toEqual({
        value: expect.stringMatching(/\|@/),
      });
      expect(sessionChangedCode(db, 's1', plain)).toBe(false);
      noteEdit(db, 's1', file('a.ts'));
      expect(sessionChangedCode(db, 's1', plain)).toBe(true);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('still asks in a repository git refuses to read, such as one owned by another user', (ctx) => {
    // Git's own switch for its safe.directory check (git 2.35.2+), with the
    // global and system config shut out: CI runners trust every directory
    // there (`safe.directory = *`), which would skip the check entirely.
    const saved = { ...process.env };
    process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
    process.env.GIT_CONFIG_GLOBAL = path.join(repo, 'no-global-config');
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    try {
      if (treeFingerprint(repo) !== null) ctx.skip();
      // No baseline either: git failed inside a repository, which is not "outside".
      recordBaseline(db, 's1', repo);
      expect(db.prepare(`SELECT count(*) AS n FROM meta WHERE key = 'tree_fp:s1'`).get()).toEqual({ n: 0 });
      expect(sessionChangedCode(db, 's1', repo)).toBe(true);
    } finally {
      process.env = saved;
    }
  });

  it('stays quiet inside .git, where git answers that there is no working tree', () => {
    expect(sessionChangedCode(db, 's1', path.join(repo, '.git'))).toBe(false);
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

describe('HEAD moves (issue 228)', () => {
  it('does not count a checkout or a fast-forward pull', () => {
    git('branch', 'other');
    recordBaseline(db, 's1', repo);
    git('checkout', '-q', 'other');
    expect(sessionChangedCode(db, 's1', repo)).toBe(false);
    // A fast-forward: another clone's commit arrives.
    const clone = `${repo}-clone`;
    git('clone', '-q', repo, clone);
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'up'], { cwd: clone });
    spawnSync('git', ['pull', '-q', '--ff-only', clone, 'HEAD'], { cwd: repo });
    fs.rmSync(clone, { recursive: true, force: true });
    expect(sessionChangedCode(db, 's1', repo)).toBe(false);
  });

  it('counts a commit after a Bash edit', () => {
    recordBaseline(db, 's1', repo);
    edit();
    git('commit', '-qam', 'work');
    expect(sessionChangedCode(db, 's1', repo)).toBe(true);
  });

  it('counts a merge, a cherry-pick and an amend, and not a reset', () => {
    const base = fs.readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim().replace('ref: refs/heads/', '');
    for (const b of ['side', 'side2']) {
      git('checkout', '-q', '-b', b, base);
      write(`${b}.ts`, 's\n');
      git('add', '.');
      git('commit', '-qm', `${b} work`);
    }
    git('checkout', '-q', base);
    const cases: Array<[string, () => void, boolean]> = [
      ['cherry-pick', () => git('cherry-pick', 'side2'), true],
      ['merge', () => git('merge', '-q', '--no-ff', '-m', 'm', 'side'), true],
      ['amend', () => git('commit', '-q', '--amend', '--allow-empty', '-m', 'again'), true],
      ['reset', () => git('reset', '-q', '--hard', 'HEAD~1'), false],
    ];
    for (const [name, move, counts] of cases) {
      recordBaseline(db, name, repo);
      move();
      expect(sessionChangedCode(db, name, repo), name).toBe(counts);
      git('checkout', '-q', '-B', 'main-' + name, 'HEAD');
    }
  });

  it('asks when the reflog cannot say, such as a baseline commit it no longer lists', () => {
    recordBaseline(db, 's1', repo);
    git('commit', '-q', '--allow-empty', '-m', 'x');
    fs.rmSync(path.join(repo, '.git', 'logs'), { recursive: true, force: true });
    expect(sessionChangedCode(db, 's1', repo)).toBe(true);
  });

  it('counts a status change even when HEAD also moved by pull', () => {
    recordBaseline(db, 's1', repo);
    git('checkout', '-q', '-b', 'other');
    edit();
    expect(sessionChangedCode(db, 's1', repo)).toBe(true);
  });

  it('takes a pre-split baseline (no head part) as changed', () => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('tree_fp:old', `${new Date().toISOString()}|${'a'.repeat(40)}`);
    expect(sessionChangedCode(db, 'old', repo)).toBe(true);
  });

  it('counts a commit made before the baseline as nothing', () => {
    edit();
    git('commit', '-qam', 'earlier');
    recordBaseline(db, 's1', repo);
    git('checkout', '-q', '-b', 'x');
    expect(sessionChangedCode(db, 's1', repo)).toBe(false);
  });
});

describe('a session started in a folder of repositories', () => {
  let parent: string;
  beforeEach(() => {
    // The shared `repo` moves inside the folder the session starts in.
    const old = repo;
    parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-parent-')));
    repo = path.join(parent, 'inner');
    spawnSync('git', ['clone', '-q', old, repo]);
    fs.rmSync(old, { recursive: true, force: true });
    recordBaseline(db, 's1', parent);
  });
  afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));
  const marked = () => sessionChangedCode(db, 's1', parent);

  it('counts a Bash edit named by absolute path, relative path, git -C or the current folder', () => {
    const run = (cwd: string, command: string) => noteBashEdit(db, 's1', cwd, command);
    for (const [cwd, command] of [
      [parent, `sed -i '' s/a/b/ ${file('a.ts')}`],
      [path.dirname(repo), `sed -i '' s/a/b/ ${path.basename(repo)}/a.ts`],
      [parent, `git -C ${repo} apply x.patch`],
      [repo, `sed -i '' s/a/b/ a.ts`],
    ] as const) {
      db.prepare(`DELETE FROM meta WHERE key LIKE 'code_edit:%'`).run();
      fs.rmSync(file('n.ts'), { force: true });
      run(cwd, command);
      expect(marked(), command).toBe(false);
      write('n.ts', 'n\n');
      later(file('n.ts'));
      run(cwd, command);
      expect(marked(), command).toBe(true);
    }
  });

  it('resolves quoted and home-relative paths, and ignores URLs, variables and flags', () => {
    const sp = path.join(parent, 'my repo');
    fs.mkdirSync(sp);
    spawnSync('git', ['init', '-q'], { cwd: sp });
    fs.writeFileSync(path.join(sp, 'x.ts'), 'x\n');
    later(path.join(sp, 'x.ts'));
    noteBashEdit(db, 's1', parent, 'curl https://example.com/a/b -o $HOME/x --flag=/nope');
    expect(marked()).toBe(false);
    noteBashEdit(db, 's1', parent, `sed -i '' s/a/b/ "${sp}/x.ts"`);
    expect(marked()).toBe(true);
  });

  it('does not count a file that was already modified before the session began', () => {
    const old = path.join(parent, 'old-repo');
    fs.mkdirSync(old);
    spawnSync('git', ['init', '-q'], { cwd: old });
    fs.writeFileSync(path.join(old, 'o.ts'), 'o\n');
    const past = Date.now() / 1000 - 3600;
    fs.utimesSync(path.join(old, 'o.ts'), past, past);
    noteBashEdit(db, 's1', parent, `cat ${old}/o.ts`);
    expect(marked()).toBe(false);
  });

  it('does not count research output under artifacts/ or reports/', () => {
    write('artifacts/page.html', '<p>x</p>\n');
    write('docs/reports/r.md', 'r\n');
    noteEdit(db, 's1', file('artifacts/page.html'));
    noteEdit(db, 's1', file('docs/reports/r.md'));
    noteBashEdit(db, 's1', parent, `git -C ${repo} status`);
    expect(marked()).toBe(false);
    write('src/real.ts', 'r\n');
    noteEdit(db, 's1', file('src/real.ts'));
    expect(marked()).toBe(true);
  });
});

describe('leadingCd', () => {
  it('follows only a leading cd, resolving it against cwd and home', () => {
    expect(leadingCd('cd ../wt && ls', '/r/main')).toBe('/r/wt');
    expect(leadingCd("cd '/a b'; ls", '/r')).toBe('/a b');
    expect(leadingCd('cd ~/x', '/r')).toBe(path.join(os.homedir(), 'x'));
    expect(leadingCd('ls && cd /a', '/r')).toBeNull();
    expect(leadingCd('cd $DIR && ls', '/r')).toBeNull();
  });
});

describe('noteBuilder', () => {
  it('counts a session that started a builder as having changed code, before its first edit', () => {
    git('init', '-q');
    write('a.ts', 'a');
    recordBaseline(db, 's1', repo);
    expect(sessionChangedCode(db, 's1', repo)).toBe(false);
    noteBuilder(db, 's1');
    expect(sessionChangedCode(db, 's1', repo)).toBe(true);
    expect(sessionChangedCode(db, 's2', repo)).toBe(false);
  });

  it('fails silently on a database it cannot write', () => {
    db.exec('DROP TABLE meta');
    expect(() => noteBuilder(db, 's1')).not.toThrow();
  });
});

describe('a repository that names a command in its own config', () => {
  it.skipIf(process.platform === 'win32')('never runs core.fsmonitor from it', () => {
    const marker = path.join(repo, '..', `fsmonitor-ran-${process.pid}`);
    const hook = path.join(repo, 'fsm.sh');
    fs.writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git('config', 'core.fsmonitor', hook);
    treeFingerprint(repo);
    noteBashEdit(db, 's1', repo, `cd ${repo} && true`);
    try {
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(marker, { force: true });
    }
  });
});

describe('a repository outside the folder the session started in', () => {
  it.skipIf(process.platform === 'win32')('is never asked through the words of a command, so its filter and fsmonitor never run', () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-parent-')));
    const marker = path.join(parent, 'ran');
    try {
      write('.gitattributes', '*.ts filter=spy\n');
      git('config', 'filter.spy.clean', `touch ${marker}; cat`);
      git('add', '.gitattributes');
      git('commit', '-qm', 'attrs');
      fs.rmSync(marker, { force: true }); // setup's own git calls may have run it on a racy file
      recordBaseline(db, 's1', parent);
      edit(); // same size: git must run the filter to compare content
      for (const command of [`git -C ${repo} status`, `sed -i '' s/a/b/ ${file('a.ts')}`]) {
        noteBashEdit(db, 's1', parent, command);
        noteBashEdit(db, 's1', repo, 'sed -i x a.ts'); // cwd moved out of the folder
      }
      expect(fs.existsSync(marker)).toBe(false);
      expect(sessionChangedCode(db, 's1', parent)).toBe(false);
      // Control: git itself does run the filter on this tree.
      spawnSync('git', ['status', '--porcelain'], { cwd: repo });
      expect(fs.existsSync(marker)).toBe(true);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe('the trust root cannot be widened by the repository itself', () => {
  let parent: string;
  beforeEach(() => {
    parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-parent-')));
    recordBaseline(db, 's1', parent);
  });
  afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

  it('does not follow a symlink inside the folder to a repository outside it', () => {
    edit();
    fs.symlinkSync(repo, path.join(parent, 'link'));
    noteBashEdit(db, 's1', parent, `sed -i '' s/a/b/ link/a.ts`);
    noteBashEdit(db, 's1', parent, `git -C ${path.join(parent, 'link')} status`);
    expect(sessionChangedCode(db, 's1', parent)).toBe(false);
  });

  it('does not trust a repository whose .git file points outside the folder', () => {
    const shell = path.join(parent, 'shell');
    fs.mkdirSync(shell);
    fs.writeFileSync(path.join(shell, '.git'), `gitdir: ${path.join(repo, '.git')}\n`);
    fs.writeFileSync(path.join(shell, 'a.ts'), 'x\n');
    noteBashEdit(db, 's1', parent, `sed -i '' s/a/b/ ${shell}/a.ts`);
    expect(sessionChangedCode(db, 's1', parent)).toBe(false);
  });

  it('trusts nothing in a session started in the home directory', () => {
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(parent);
    try {
      const inner = path.join(parent, 'inner');
      spawnSync('git', ['clone', '-q', repo, inner]);
      recordBaseline(db, 's2', parent);
      fs.writeFileSync(path.join(inner, 'n.ts'), 'n\n');
      noteBashEdit(db, 's2', parent, `sed -i '' s/a/b/ ${inner}/n.ts`);
      expect(sessionChangedCode(db, 's2', parent)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('edges of the folder-of-repositories path', () => {
  let parent: string;
  beforeEach(() => {
    parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-parent-')));
    const old = repo;
    repo = path.join(parent, 'inner');
    spawnSync('git', ['clone', '-q', old, repo]);
    fs.rmSync(old, { recursive: true, force: true });
    recordBaseline(db, 's1', parent);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const marks = () => db.prepare(`SELECT count(*) AS n FROM meta WHERE key LIKE 'code_edit:%'`).get();

  it('leaves a session that started outside a repository alone once its cwd is inside one', () => {
    expect(sessionChangedCode(db, 's1', repo)).toBe(false);
  });

  it('asks when HEAD moved off an unborn baseline, which has no commit to walk from', () => {
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    git('init', '-q');
    recordBaseline(db, 'u', repo);
    git('commit', '-q', '--allow-empty', '-m', 'first');
    expect(sessionChangedCode(db, 'u', repo)).toBe(true);
  });

  it('marks nothing from a baseline whose time cannot be read, or an empty command', () => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('tree_fp:bad', `nope|@${parent}`);
    noteBashEdit(db, 'bad', parent, `sed -i x ${repo}/a.ts`);
    write('n.ts', 'n\n');
    noteBashEdit(db, 's1', parent, '');
    noteBashEdit(db, 's1', parent, 'cat ~/x/y');
    expect(marks()).toEqual({ n: 0 });
  });

  it('stops looking when the time budget is spent, before or after finding a tree', () => {
    write('n.ts', 'n\n');
    later(file('n.ts'));
    const real = Date.now.bind(Date);
    // The clock reads only changes-lib makes: `allowed` of them see the start, the rest see the budget gone.
    const spend = (allowed: number) => {
      let seen = 0;
      vi.spyOn(Date, 'now').mockImplementation(() =>
        /hooks\/changes-lib\.(ts|js)/.test(new Error().stack!) && ++seen > allowed ? real() + 10_000 : real(),
      );
    };
    spend(1);
    noteBashEdit(db, 's1', parent, `sed -i x ${repo}/n.ts`);
    expect(marks()).toEqual({ n: 0 });
    vi.restoreAllMocks();
    spend(3); // the start, then one check for each of the two trees named
    noteBashEdit(db, 's1', parent, `sed -i x ${repo}/n.ts`);
    expect(marks()).toEqual({ n: 0 });
    vi.restoreAllMocks();
    noteBashEdit(db, 's1', parent, `sed -i x ${repo}/n.ts`);
    expect(marks()).toEqual({ n: 1 });
  });

  it('trusts nothing when the start folder is gone', () => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('tree_fp:gone', `${new Date(0).toISOString()}|@${path.join(parent, 'deleted')}`);
    noteBashEdit(db, 'gone', parent, `sed -i x ${repo}/a.ts`);
    expect(db.prepare(`SELECT count(*) AS n FROM meta WHERE key = 'code_edit:gone'`).get()).toEqual({ n: 0 });
  });
});
