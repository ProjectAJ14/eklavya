/**
 * A moved or renamed checkout keeps its history.
 *
 * Every project key is an absolute path (`projectKey`), so `mv ~/QF ~/quietflip`
 * used to start the project over: the memory, answers and level stayed filed
 * under a folder that no longer existed, and nothing said so. Two hours of
 * recorded work recalled as two entries is how it was found.
 *
 * A repository's root commits survive a move, so they are its identity here.
 * SessionStart records them the first time it sees a project key, and at that
 * moment asks whether another key with the same roots has lost its folder. If
 * exactly one has, that is this checkout before the move, and its history is
 * re-filed here. Anything less certain is left alone and named in the banner:
 * two missing folders could be two clones, and a folder that still exists is a
 * separate checkout that happens to share history, which is what a fork or a
 * second clone is.
 *
 * `eklavya memory move` does the same re-filing by hand, for the cases this
 * declines and for folders moved before their roots were ever recorded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { escHtml } from './artifacts.js';
import type { DB } from './db.js';
import { git } from './hooks/changes-lib.js';
import { artifactsDir, projectsDir, projectSlug } from './paths.js';
import { readJsonForUpdate, writeJsonWithBackup } from './safe-write.js';
import { GLOBAL_PROJECT } from './store.js';

/**
 * Every column that files a row under a project key. `project_levels` is not
 * here: its key is its primary key, and two levels merge rather than move.
 * `evidence_events.checkout` is the unfolded root; only the checkout that
 * moved is renamed, and a worktree's own path stays as it was recorded.
 */
const KEYED: ReadonlyArray<readonly [table: string, column: string]> = [
  ['evidence_events', 'project'],
  ['evidence_events', 'checkout'],
  ['memory_batches', 'project'],
  ['memory_entries', 'project'],
  ['context_receipts', 'project'],
  ['memory_reads', 'project'],
  ['learning_sources', 'project'],
  ['memory_collections', 'project'],
  ['feedback_items', 'project'],
  ['attempts', 'repo'],
  ['gates', 'repo'],
];

const LEVELS = ['easy', 'medium', 'hard'];

export interface MoveReport {
  from: string;
  to: string;
  /** Memory entries now filed under `to`: the number worth telling somebody. */
  entries: number;
  /** Rows re-filed, every table together. */
  rows: number;
  /** Folders under `~/.eklavya` that could not move because `to` already had one. */
  left: string[];
}

/** The repository's root commits, or none outside git, before a first commit, or on any git failure. */
export function rootCommits(checkout: string): string[] {
  const out = git(checkout, ['rev-list', '--max-parents=0', 'HEAD']);
  return out ? out.split('\n').map((s) => s.trim()).filter((s) => /^[0-9a-f]{40,64}$/.test(s)) : [];
}

function rememberRoots(db: DB, project: string, roots: string[]): void {
  const insert = db.prepare('INSERT OR IGNORE INTO project_roots (project, root_commit) VALUES (?, ?)');
  for (const root of roots) insert.run(project, root);
}

/**
 * Re-files everything under `from` as `to`, in one transaction, then moves the
 * project's settings and artifact folders. Merges into history `to` already
 * has. The two folders are best effort: a failure there leaves them where they
 * were and named in `left`, never a half-moved database.
 */
export function moveProject(db: DB, from: string, to: string): MoveReport {
  if (from === to) throw new Error('The old and new project are the same.');
  if (from === GLOBAL_PROJECT || to === GLOBAL_PROJECT) throw new Error('Work outside a git repository has no folder to move.');

  let rows = 0;
  db.transaction(() => {
    for (const [table, column] of KEYED) {
      rows += db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(to, from).changes;
    }
    // Primary-keyed on (project, root_commit): a root both keys share is one row.
    db.prepare('UPDATE OR IGNORE project_roots SET project = ? WHERE project = ?').run(to, from);
    db.prepare('DELETE FROM project_roots WHERE project = ?').run(from);
    // Two levels merge to the higher: a promotion was earned by answers that
    // are now all filed here.
    const level = (repo: string) =>
      (db.prepare('SELECT level FROM project_levels WHERE repo = ?').get(repo) as { level: string } | undefined)?.level;
    const old = level(from);
    if (old !== undefined) {
      const current = level(to);
      if (current === undefined) {
        db.prepare('UPDATE project_levels SET repo = ? WHERE repo = ?').run(to, from);
      } else {
        if (LEVELS.indexOf(old) > LEVELS.indexOf(current)) {
          db.prepare("UPDATE project_levels SET level = ?, updated_at = datetime('now') WHERE repo = ?").run(old, to);
        }
        db.prepare('DELETE FROM project_levels WHERE repo = ?').run(from);
      }
      rows += 1;
    }
  })();

  const entries = (
    db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE project = ? AND deleted_at IS NULL').get(to) as { n: number }
  ).n;
  return { from, to, entries, rows, left: moveFolders(from, to) };
}

/** `projects/<slug>` and `artifacts/<slug>`, each renamed when the new name is free. */
function moveFolders(from: string, to: string): string[] {
  const left: string[] = [];
  for (const root of [projectsDir(), artifactsDir()]) {
    const src = path.join(root, projectSlug(from));
    const dst = path.join(root, projectSlug(to));
    // The slug is lossy (`/a/b-c` and `/a-b/c` share one), so the folder may
    // already be the right one; only its recorded project needs changing.
    if (src !== dst) {
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dst)) {
        left.push(src);
        continue;
      }
      try {
        fs.renameSync(src, dst);
      } catch {
        left.push(src);
        continue;
      }
    }
    try {
      if (root === projectsDir()) retagConfig(path.join(dst, 'config.json'), from, to);
      else retagArtifacts(dst, from, to);
    } catch {
      /* the rows moved; a file that could not be retagged keeps its old label */
    }
  }
  return left;
}

/** The project settings file records its checkout (`belongsTo`); a stale one would be ignored. */
function retagConfig(file: string, from: string, to: string): void {
  if (!fs.existsSync(file)) return;
  const raw = readJsonForUpdate(file);
  if (raw.project === from) writeJsonWithBackup(file, { ...raw, project: to }, { mode: 0o600 });
}

/** The dashboard scopes an artifact by its `eklavya:project` meta, so the tag moves with the folder. */
function retagArtifacts(dir: string, from: string, to: string): void {
  if (!fs.existsSync(dir)) return;
  const before = `<meta name="eklavya:project" content="${escHtml(from)}">`;
  const after = `<meta name="eklavya:project" content="${escHtml(to)}">`;
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (!/\.html?$/i.test(name) || !fs.lstatSync(file).isFile()) continue;
    const html = fs.readFileSync(file, 'utf8');
    if (html.includes(before)) fs.writeFileSync(file, html.replace(before, after));
  }
}

export interface FollowResult {
  moved: MoveReport | null;
  /** Missing folders with this repository's roots, when there was more than one to choose from. */
  candidates: string[];
}

/**
 * SessionStart's half: record this project's roots the first time it is seen,
 * and re-file the one missing folder that shares them. A project whose roots
 * are already on record returns at once, so git runs once per project key --
 * except in a repository with no commits yet, which asks again each start
 * until it has one.
 */
export function followMove(db: DB, project: string, checkout: string | null): FollowResult | null {
  if (project === GLOBAL_PROJECT || !checkout) return null;
  if (db.prepare('SELECT 1 FROM project_roots WHERE project = ? LIMIT 1').get(project)) return null;
  const roots = rootCommits(checkout);
  if (!roots.length) return null;
  const candidates = (
    db
      .prepare(
        `SELECT DISTINCT project FROM project_roots
         WHERE root_commit IN (${roots.map(() => '?').join(', ')}) AND project != ?`,
      )
      .all(...roots, project) as { project: string }[]
  )
    .map((r) => r.project)
    .filter((p) => !fs.existsSync(p))
    .sort();
  const moved = candidates.length === 1 ? moveProject(db, candidates[0]!, project) : null;
  rememberRoots(db, project, roots);
  return { moved, candidates: moved ? [] : candidates };
}

/** Keys with history whose folder is gone: what `eklavya memory move` lists. */
export function missingProjects(db: DB): { project: string; entries: number }[] {
  const rows = db
    .prepare(
      `SELECT project, SUM(entries) AS entries FROM (
         SELECT project, COUNT(*) AS entries FROM memory_entries WHERE deleted_at IS NULL GROUP BY project
         UNION ALL
         SELECT project, 0 FROM evidence_events GROUP BY project
       ) GROUP BY project ORDER BY project`,
    )
    .all() as { project: string; entries: number }[];
  // Absolute only: a bare name is a Claude Mem project no checkout matched yet,
  // which `memory import --map` places, not this.
  return rows.filter((r) => path.isAbsolute(r.project) && !fs.existsSync(r.project));
}
