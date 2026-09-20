import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findRepoConfig, mainRepoRoot } from '../src/config.js';
import { GLOBAL_PROJECT, mergeWorktreeProjects, projectKey } from '../src/store.js';
import { openDb } from '../src/db.js';
import { dashboardState } from '../src/dashboard.js';

const trees: string[] = [];

/** A real repo with a real linked worktree — the `.git` file is the thing under test. */
function repoWithWorktree(): { main: string; worktree: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-wt-')));
  trees.push(root);
  const main = path.join(root, 'main');
  fs.mkdirSync(main);
  const git = (args: string[], cwd = main) =>
    execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(main, 'README.md'), '# test\n');
  git(['add', '.']);
  git(['commit', '-qm', 'init']);
  const worktree = path.join(root, 'wt');
  git(['worktree', 'add', '-q', '-b', 'feature', worktree]);
  const second = path.join(root, 'wt2');
  git(['worktree', 'add', '-q', '-b', 'other', second]);
  return { main, worktree, second };
}

afterEach(() => {
  for (const t of trees.splice(0)) fs.rmSync(t, { recursive: true, force: true });
});

describe('worktrees are the same project', () => {
  it('folds a worktree onto the checkout it branched from', () => {
    const { main, worktree } = repoWithWorktree();
    // findRepoConfig still stops at the worktree: its own .eklavya.json wins.
    expect(findRepoConfig(worktree).repoRoot).toBe(worktree);
    expect(mainRepoRoot(worktree)).toBe(main);
    expect(projectKey(worktree)).toBe(projectKey(main));
  });

  it('leaves an ordinary checkout and a repo-less cwd alone', () => {
    const { main } = repoWithWorktree();
    expect(mainRepoRoot(main)).toBe(main);
    expect(projectKey(null)).toBe(GLOBAL_PROJECT);
  });

  it('merges rows written before the fix, once', () => {
    const { main, worktree } = repoWithWorktree();
    const db = openDb(':memory:');
    db.prepare('INSERT INTO project_levels (repo, level, promoted_at, updated_at) VALUES (?, ?, NULL, ?)')
      .run(main, 'medium', '2026-01-01T00:00:00Z');
    db.prepare('INSERT INTO project_levels (repo, level, promoted_at, updated_at) VALUES (?, ?, NULL, ?)')
      .run(worktree, 'easy', '2026-01-01T00:00:00Z');
    db.prepare(
      `INSERT INTO attempts (concept_id, question, grade, difficulty, ts, repo)
       SELECT id, 'q?', 4, 2, ?, ? FROM concepts LIMIT 1`,
    ).run('2026-01-01T00:00:00Z', worktree);
    db.prepare('DELETE FROM meta WHERE key = ?').run('worktree_projects_merged');

    mergeWorktreeProjects(db);

    const levels = db.prepare('SELECT repo, level FROM project_levels').all() as { repo: string; level: string }[];
    expect(levels).toEqual([{ repo: main, level: 'medium' }]);
    const stray = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE repo = ?').get(worktree) as { n: number };
    expect(stray.n).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE repo = ?').get(main) as { n: number }).n,
    ).toBeGreaterThan(0);
    db.close();
  });

  it('keeps the furthest band when several worktrees fold into one checkout', () => {
    // Nothing demotes a learner. Merging must not either, whatever order the
    // rows come back in, and whether or not the main checkout has a row of its own.
    const { main, worktree, second } = repoWithWorktree();
    const db = openDb(':memory:');
    const level = db.prepare(
      'INSERT INTO project_levels (repo, level, promoted_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    level.run(worktree, 'easy', null, '2026-01-01T00:00:00Z');
    level.run(second, 'hard', '2026-02-02T00:00:00Z', '2026-02-02T00:00:00Z');
    db.prepare('DELETE FROM meta WHERE key = ?').run('worktree_projects_merged');

    mergeWorktreeProjects(db);

    expect(db.prepare('SELECT repo, level, promoted_at FROM project_levels').all()).toEqual([
      { repo: main, level: 'hard', promoted_at: '2026-02-02T00:00:00Z' },
    ]);
    db.close();
  });

  it('shows a worktree session\'s logged concepts under the main checkout', () => {
    // `gates.repo` stays the worktree path on purpose, so the dashboard has to
    // fold it on read or a project filter hides every context line.
    const { main, worktree } = repoWithWorktree();
    const db = openDb(':memory:');
    db.prepare('INSERT INTO gates (session_id, mode, repo) VALUES (?, ?, ?)').run('s1', 'ambient', worktree);
    db.prepare(
      'INSERT INTO session_concepts (session_id, concept_id, context, ts) SELECT ?, id, ?, ? FROM concepts LIMIT 1',
    ).run('s1', 'wrote the thing', '2026-01-01T00:00:00Z');

    const logged = dashboardState(db).logged as { repo: string }[];

    expect(logged).toHaveLength(1);
    expect(logged[0]!.repo).toBe(main);
    db.close();
  });
});
