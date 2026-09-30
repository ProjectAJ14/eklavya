import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { insertEntry } from '../src/memory/store.js';
import { projectConfigPath, projectSlug } from '../src/paths.js';
import { followMove, missingProjects, moveProject, rootCommits } from '../src/relocate.js';
import { cleanup, tempDbPath } from './helpers.js';

/**
 * A moved or renamed checkout keeps its history (`relocate.ts`).
 *
 * Real repositories in a temp folder, because the identity is git's own root
 * commit and a stub would test nothing but the stub. `EKLAVYA_HOME` points at a
 * temp directory so the settings and artifact folders moved here are never the
 * developer's.
 */

const mcpRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SESSION_START = path.join(mcpRoot, 'dist', 'hooks', 'session-start.js');
const CLI = path.join(mcpRoot, 'dist', 'cli.js');

let work = '';
let home = '';
let dbFile = '';
let db: DB;
let savedHome: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/** A checkout with one commit, as its realpath: the form every project key takes. */
function repo(name: string, commit = true): string {
  const dir = path.join(work, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  if (commit) git(dir, 'commit', '-q', '--allow-empty', '-m', 'first');
  return fs.realpathSync(dir);
}

function remember(project: string, title = 'Built the flip clock'): void {
  insertEntry(db, { project, title, narrative: 'n', occurredAt: new Date().toISOString() });
}

const entriesUnder = (project: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE project = ?').get(project) as { n: number }).n;

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-move-')));
  home = path.join(work, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ min_minutes_between_quizzes: 0 }));
  savedHome = process.env.EKLAVYA_HOME;
  process.env.EKLAVYA_HOME = home;
  dbFile = tempDbPath('move');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  if (savedHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = savedHome;
  fs.rmSync(work, { recursive: true, force: true });
});

describe('following a moved checkout', () => {
  it('re-files the history of the one missing folder that shares this repository’s root commit', () => {
    const old = repo('QF');
    expect(followMove(db, old, old)).toEqual({ moved: null, candidates: [] });
    remember(old);
    remember(old, 'Added the stopwatch');

    const moved = path.join(work, 'quietflip');
    fs.renameSync(old, moved);
    const result = followMove(db, moved, moved);

    expect(result?.moved).toMatchObject({ from: old, to: moved, entries: 2 });
    expect(entriesUnder(old)).toBe(0);
    expect(entriesUnder(moved)).toBe(2);
    // The roots moved too, so a second move later is followed the same way.
    const roots = db.prepare('SELECT project FROM project_roots').all() as { project: string }[];
    expect(new Set(roots.map((r) => r.project))).toEqual(new Set([moved]));
    // Seen once: a second start asks git nothing and moves nothing.
    expect(followMove(db, moved, moved)).toBeNull();
  });

  it('leaves a second clone alone: its old folder still exists, so it is a separate checkout', () => {
    const first = repo('app');
    followMove(db, first, first);
    remember(first);
    const clone = path.join(work, 'app-clone');
    execFileSync('git', ['clone', '-q', first, clone], { stdio: 'ignore' });

    expect(followMove(db, fs.realpathSync(clone), fs.realpathSync(clone))).toEqual({ moved: null, candidates: [] });
    expect(entriesUnder(first)).toBe(1);
  });

  it('names the candidates instead of choosing when two missing folders share the roots', () => {
    const a = repo('a');
    followMove(db, a, a);
    const b = path.join(work, 'b');
    execFileSync('git', ['clone', '-q', a, b], { stdio: 'ignore' });
    followMove(db, fs.realpathSync(b), fs.realpathSync(b));
    remember(a);
    const bKey = fs.realpathSync(b);
    const target = path.join(work, 'c');
    fs.renameSync(a, target);
    fs.rmSync(b, { recursive: true, force: true });

    const result = followMove(db, target, target);
    expect(result?.moved).toBeNull();
    expect(result?.candidates).toEqual([a, bKey].sort());
    expect(entriesUnder(a)).toBe(1);
  });

  it('records nothing for a repository with no commits, and asks again once it has one', () => {
    const fresh = repo('fresh', false);
    expect(rootCommits(fresh)).toEqual([]);
    expect(followMove(db, fresh, fresh)).toBeNull();
    git(fresh, 'commit', '-q', '--allow-empty', '-m', 'first');
    expect(followMove(db, fresh, fresh)).toEqual({ moved: null, candidates: [] });
  });

  it('ignores work outside a repository', () => {
    expect(followMove(db, '*', null)).toBeNull();
  });
});

describe('moveProject', () => {
  it('merges into existing history, keeps the higher level, and moves settings and artifacts', () => {
    const from = path.join(work, 'gone');
    const to = repo('here');
    remember(from);
    remember(to, 'Already here');
    db.prepare("INSERT INTO project_levels (repo, level) VALUES (?, 'medium'), (?, 'easy')").run(from, to);
    const concept = (db.prepare('SELECT id FROM concepts LIMIT 1').get() as { id: number }).id;
    db.prepare("INSERT INTO attempts (concept_id, question, grade, difficulty, repo) VALUES (?, 'q', 5, 1, ?)").run(
      concept,
      from,
    );

    const settings = projectConfigPath(from);
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ project: from, cadence: 'end' }));
    const art = path.join(home, 'artifacts', projectSlug(from));
    fs.mkdirSync(art, { recursive: true });
    fs.writeFileSync(path.join(art, 'page.html'), `<head><meta name="eklavya:project" content="${from}"></head>`);

    const report = moveProject(db, from, to);

    expect(report).toMatchObject({ from, to, entries: 2, left: [] });
    expect(db.prepare('SELECT repo, level FROM project_levels').all()).toEqual([{ repo: to, level: 'medium' }]);
    expect(db.prepare('SELECT repo FROM attempts').all()).toEqual([{ repo: to }]);
    expect(JSON.parse(fs.readFileSync(projectConfigPath(to), 'utf8'))).toEqual({ project: to, cadence: 'end' });
    expect(fs.existsSync(path.dirname(settings))).toBe(false);
    expect(fs.readFileSync(path.join(home, 'artifacts', projectSlug(to), 'page.html'), 'utf8')).toContain(
      `content="${to}"`,
    );
  });

  it('leaves a folder in place when the new project already has one', () => {
    const from = path.join(work, 'gone');
    const to = repo('here');
    for (const p of [from, to]) {
      fs.mkdirSync(path.dirname(projectConfigPath(p)), { recursive: true });
      fs.writeFileSync(projectConfigPath(p), JSON.stringify({ project: p }));
    }
    expect(moveProject(db, from, to).left).toEqual([path.dirname(projectConfigPath(from))]);
    expect(JSON.parse(fs.readFileSync(projectConfigPath(to), 'utf8'))).toEqual({ project: to });
  });

  it('refuses a move onto itself or into the no-repository bucket', () => {
    expect(() => moveProject(db, '/a', '/a')).toThrow(/same/);
    expect(() => moveProject(db, '/a', '*')).toThrow(/outside a git repository/);
  });
});

describe('the hook and the CLI', () => {
  const env = () => ({ ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, NO_COLOR: '1' });
  const start = (cwd: string, session: string) => {
    const res = spawnSync(process.execPath, [SESSION_START], {
      input: JSON.stringify({ session_id: session, cwd, hook_event_name: 'SessionStart', source: 'startup' }),
      encoding: 'utf8',
      env: env(),
    });
    expect(res.status).toBe(0);
    return res.stdout ? (JSON.parse(res.stdout) as { systemMessage?: string }) : {};
  };
  const cli = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, [CLI, 'memory', 'move', ...args], { cwd, encoding: 'utf8', env: env() });

  it('SessionStart in the moved folder re-files the history and says so in the banner', () => {
    const old = repo('QF');
    start(old, 's1');
    remember(old);
    const moved = path.join(work, 'quietflip');
    fs.renameSync(old, moved);

    const out = start(moved, 's2');

    expect(out.systemMessage).toContain(`Memory · moved from ${old} · 1 entries re-filed`);
    expect(entriesUnder(moved)).toBe(1);
    // This session's own first event is filed under the new key, not the old.
    expect(db.prepare('SELECT DISTINCT project FROM evidence_events').all()).toEqual([{ project: moved }]);
  });

  it('`memory move` lists missing folders, refuses a live one without --force, and re-files by hand', () => {
    const here = repo('here');
    const gone = path.join(work, 'gone');
    const live = repo('live');
    remember(gone);
    remember(live);
    expect(missingProjects(db)).toEqual([{ project: gone, entries: 1 }]);

    expect(cli(here).stdout).toContain(`${gone}  (1 entries)`);
    const refused = cli(here, live);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('--force');
    expect(cli(here, path.join(work, 'never')).stderr).toContain('No history is filed under');

    const moved = cli(here, gone);
    expect(moved.status).toBe(0);
    expect(moved.stdout).toContain(`Moved ${gone} → ${here}`);
    expect(entriesUnder(here)).toBe(1);
    expect(cli(here, live, '--force').status).toBe(0);
    expect(entriesUnder(here)).toBe(2);
  });
});
