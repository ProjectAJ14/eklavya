/**
 * Has this session changed the code? Answered by its edits and by git.
 *
 * `quiz.only_on_changes` keeps questions out of sessions that only read,
 * searched or answered questions -- being quizzed in the middle of research is
 * an interruption with no new code behind it. Watching Edit and Write alone is not
 * enough: agents edit through Bash (`sed -i`, heredocs, codegen) as often as
 * through the edit tools, and all of those land in the working tree.
 *
 * So `session-start` records a fingerprint of the working tree, and the quiz
 * hooks compare against it just before asking. The fingerprint is HEAD plus the
 * path, size and mtime of every entry `git status` reports -- mtime rather than
 * content, so an edit to a file that was already dirty at session start still
 * counts, and nothing reads file bodies. `-uall` lists every untracked file:
 * the default collapses an untracked folder to one entry whose mtime does not
 * move when a file inside it is edited.
 *
 * The baseline lives in `meta` as `<ISO>|<fingerprint>`, one row per session,
 * pruned after a week the way the prompt nudge's rows are. No migration.
 *
 * Git alone misses the commonest layout of all: a session started in the main
 * checkout that edits a sibling worktree (`<repo>-worktrees/<branch>`) by
 * absolute path and `cd`. The tree it started in never moves, so every one of
 * those sessions read as research -- nine of thirteen coding sessions in one
 * OIP day got no question. So the checkpoint hook, which fires on every edit
 * tool, marks the session (`noteEdit`) when the file it edited sits in any git
 * working tree and is not ignored. Research writes elsewhere -- auto-memory
 * notes, plans, a scratchpad -- are outside any tree and do not count. Git
 * still covers Bash edits in the session's own tree.
 *
 * Known edges, all accepted:
 *   - a file already dirty at session start, edited and then reverted, still
 *     counts (its mtime moved; a clean file reverted is clean again and does not);
 *   - a build that writes untracked, un-ignored files counts;
 *   - `git pull` or a branch switch moves HEAD and counts.
 * Each errs towards asking, which is the behaviour before this existed.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './lib.js';

const KEY_PREFIX = 'tree_fp:';
/** A hook has ten seconds in all; git gets a fraction of it. */
const GIT_TIMEOUT_MS = 2000;

function git(cwd: string, args: string[]): string | null {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true });
  return res.status === 0 && typeof res.stdout === 'string' ? res.stdout : null;
}

/** The working tree's fingerprint, or null outside a repository or on any git failure. */
export function treeFingerprint(cwd: string): string | null {
  try {
    const root = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
    if (!root) return null;
    const status = git(root, ['status', '--porcelain=v1', '-z', '-uall']);
    if (status === null) return null;
    // An unborn branch has no HEAD; the status entries still fingerprint it.
    const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? '';
    const hash = createHash('sha1').update(head);
    const entries = status.split('\0');
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i] ?? '';
      if (entry.length < 4) continue;
      // `R` and `C` entries carry the source path as the next NUL field.
      if (entry[0] === 'R' || entry[0] === 'C') i++;
      const rel = entry.slice(3);
      let stamp = 'gone';
      try {
        const st = fs.statSync(path.join(root, rel));
        stamp = `${st.size}:${st.mtimeMs}`;
      } catch {
        /* Deleted: the status code alone records it. */
      }
      hash.update(`\0${entry}\0${stamp}`);
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Records the session's baseline, once. `session-start` also fires on resume
 * and after a compaction with the same session id, and overwriting there would
 * forget every change made before it.
 */
export function recordBaseline(db: DB, sessionId: string, cwd: string, fp = treeFingerprint(cwd)): void {
  try {
    db.prepare(
      `DELETE FROM meta WHERE key LIKE ? AND substr(value, 1, 10) < date('now', '-7 day')`,
    ).run(`${KEY_PREFIX}%`);
    if (fp === null) return;
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
      `${KEY_PREFIX}${sessionId}`,
      `${new Date().toISOString()}|${fp}`,
    );
  } catch {
    /* No baseline means `sessionChangedCode` treats the session as unknown. */
  }
}

/**
 * True when the working tree differs from the session's baseline.
 *
 * Unknown answers true: outside a git repository, on a git failure, or when
 * the database will not answer, there is nothing to measure, and the setting
 * restricts questions only where it can tell. The one exception is a session
 * with no baseline but a readable tree -- one that started before this shipped,
 * or whose start-up git call timed out. It takes its baseline now and answers
 * false, so its changes from here on still count.
 */
export function sessionChangedCode(db: DB, sessionId: string, cwd: string): boolean {
  if (editMarked(db, sessionId)) return true;
  const now = treeFingerprint(cwd);
  if (now === null) return true;
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`${KEY_PREFIX}${sessionId}`) as
      | { value: string }
      | undefined;
    if (!row) {
      recordBaseline(db, sessionId, cwd, now);
      return false;
    }
    return row.value.slice(row.value.indexOf('|') + 1) !== now;
  } catch {
    return true;
  }
}

const EDIT_PREFIX = 'code_edit:';

function editMarked(db: DB, sessionId: string): boolean {
  try {
    return Boolean(db.prepare('SELECT 1 FROM meta WHERE key = ?').get(`${EDIT_PREFIX}${sessionId}`));
  } catch {
    return false;
  }
}

/** True when `file` is in a git working tree and not ignored. Two git calls. */
function inWorkTree(file: string): boolean {
  const dir = path.dirname(file);
  if (git(dir, ['rev-parse', '--is-inside-work-tree'])?.trim() !== 'true') return false;
  // Exit 0 means ignored: build output, a vendored folder.
  const ignored = spawnSync('git', ['check-ignore', '-q', file], { cwd: dir, timeout: GIT_TIMEOUT_MS, windowsHide: true });
  return ignored.status !== 0;
}

/**
 * Marks the session as having changed code, once, when an edit tool wrote a
 * file inside a git working tree -- any tree, including a sibling worktree the
 * session never started in. Once marked, later edits cost no git call.
 */
export function noteEdit(db: DB, sessionId: string, file: string): void {
  try {
    if (!path.isAbsolute(file) || editMarked(db, sessionId) || !inWorkTree(file)) return;
    db.prepare(`DELETE FROM meta WHERE key LIKE ? AND substr(value, 1, 10) < date('now', '-7 day')`).run(
      `${EDIT_PREFIX}%`,
    );
    db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
      `${EDIT_PREFIX}${sessionId}`,
      new Date().toISOString(),
    );
  } catch {
    /* Unmarked falls back to the git comparison. */
  }
}
