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
 * Bash edits in that sibling worktree are the same layout through the other
 * door: `cd <worktree>; sed -i …` touches no edit tool and leaves the session's
 * own tree alone, so a quietflip session of 250 Bash calls and no Edit got no
 * question at all while the delegate nudge, which follows the `cd`, fired. So
 * the checkpoint hook also marks the session (`noteBashEdit`) when the tree a
 * Bash command's leading `cd` names lists a file modified since the session
 * began. The session-start time is the baseline's own stamp, so the first
 * command in a tree counts without any snapshot of it.
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
import os from 'node:os';
import path from 'node:path';
import type { DB } from './lib.js';

const KEY_PREFIX = 'tree_fp:';
/** A hook has ten seconds in all; git gets a fraction of it. */
const GIT_TIMEOUT_MS = 2000;

export function git(cwd: string, args: string[]): string | null {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true });
  return res.status === 0 && typeof res.stdout === 'string' ? res.stdout : null;
}

/** The working tree's fingerprint, or null outside a repository or on any git failure. */
export function treeFingerprint(cwd: string): string | null {
  try {
    const root = git(cwd, ['rev-parse', '--show-toplevel'])?.trim();
    if (!root) return null;
    const entries = statusEntries(root);
    if (entries === null) return null;
    // An unborn branch has no HEAD; the status entries still fingerprint it.
    const head = git(root, ['rev-parse', '--verify', '-q', 'HEAD'])?.trim() ?? '';
    const hash = createHash('sha1').update(head);
    for (const { entry, rel } of entries) {
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

/** Every entry `git status` reports under `root`, with its path relative to it; null on failure. */
function statusEntries(root: string): Array<{ entry: string; rel: string }> | null {
  const status = git(root, ['status', '--porcelain=v1', '-z', '-uall']);
  if (status === null) return null;
  const out: Array<{ entry: string; rel: string }> = [];
  const entries = status.split('\0');
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (entry.length < 4) continue;
    // `R` and `C` entries carry the source path as the next NUL field.
    if (entry[0] === 'R' || entry[0] === 'C') i++;
    out.push({ entry, rel: entry.slice(3) });
  }
  return out;
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
 * Outside a git repository the edit marker is the whole answer. A folder of
 * repositories (`~/Workspace`) is where general questions get asked, and
 * answering true there quizzed a session that had only answered one -- on
 * the question it had just answered. An edit into any repository below it
 * still marks the session; an edit to a file in no repository never counts.
 *
 * Unknown answers true: on a git failure inside a repository, or when the
 * database will not answer. The one exception is a session with no baseline
 * but a readable tree -- one that started before this shipped, or whose
 * start-up git call timed out. It takes its baseline now and answers false, so
 * its changes from here on still count.
 */
export function sessionChangedCode(db: DB, sessionId: string, cwd: string): boolean {
  if (editMarked(db, sessionId)) return true;
  const now = treeFingerprint(cwd);
  if (now === null) return !outsideRepo(cwd);
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

/**
 * Git ran and said no. A timeout or a missing git binary is not an answer, and
 * neither is any other refusal: a repository owned by another user (a
 * devcontainer, a bind mount, WSL's `/mnt`) fails with "dubious ownership",
 * and reading that as "no repository" would silence it for good. `LC_ALL=C`
 * keeps the message in English. Inside `.git` or a bare repository git answers
 * "false" with a clean exit.
 */
function outsideRepo(cwd: string): boolean {
  const res = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, LC_ALL: 'C' },
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (res.status === 0) return res.stdout.trim() === 'false';
  return typeof res.status === 'number' && /not a git repository/i.test(res.stderr);
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
    markEdit(db, sessionId);
  } catch {
    /* Unmarked falls back to the git comparison. */
  }
}

/**
 * The directory a command's leading `cd` moves to, or null. Only the first
 * word: `cd <dir> && …` is how agents work in another checkout. A `cd` later in
 * the command, `pushd`, a subshell or a variable is not followed.
 */
export function leadingCd(command: string, cwd: string): string | null {
  const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;|\n|$)/.exec(command);
  const dir = m?.[1] ?? m?.[2] ?? m?.[3];
  if (!dir || dir.includes('$')) return null;
  const home = dir === '~' || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir;
  return path.resolve(cwd, home);
}

/**
 * Marks the session, once, when a Bash command's leading `cd` names a git tree
 * that lists a file modified since the session began -- the sibling-worktree
 * edit no edit tool and no fingerprint of the session's own tree sees. Ignored
 * files never appear in `git status`, so build output does not count. Without
 * a baseline (a session started outside any repository) there is no start time
 * to compare against, and nothing is marked.
 *
 * Known edges, accepted with the rest above: a file the developer edits in that
 * tree by hand during the session counts, and so does a command that only
 * reads there after such an edit. Both err towards asking.
 */
export function noteBashEdit(db: DB, sessionId: string, cwd: string, command: string): void {
  try {
    if (editMarked(db, sessionId)) return;
    const target = leadingCd(command, cwd);
    if (!target) return;
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`${KEY_PREFIX}${sessionId}`) as
      | { value: string }
      | undefined;
    const since = row ? Date.parse(row.value.slice(0, row.value.indexOf('|'))) : NaN;
    if (Number.isNaN(since)) return;
    const root = git(target, ['rev-parse', '--show-toplevel'])?.trim();
    if (!root) return;
    const entries = statusEntries(root);
    if (!entries) return;
    const moved = entries.some(({ rel }) => {
      try {
        return fs.statSync(path.join(root, rel)).mtimeMs >= since;
      } catch {
        return false; // Deleted: no mtime to say when. The fingerprint still sees it in the session's own tree.
      }
    });
    if (moved) markEdit(db, sessionId);
  } catch {
    /* Unmarked falls back to the git comparison. */
  }
}

/**
 * Marks the session, once, when the parent hands the build to an agent
 * (`delegate-nudge` sees the launch). The builder's first edit can be minutes
 * away, and that wait is exactly what `get_session_quiz_plan` with
 * `while_waiting: true` is for: unmarked, it answered "no_code_change" the
 * moment the agent started and the parent sat out the build in silence. A
 * session that started a builder is not the research `only_on_changes` exists
 * to leave alone. Read-only agents (Explore, Plan, the tutor, the explainer)
 * never get here.
 */
export function noteBuilder(db: DB, sessionId: string): void {
  try {
    markEdit(db, sessionId);
  } catch {
    /* Unmarked falls back to the git comparison and the builder's own edits. */
  }
}

function markEdit(db: DB, sessionId: string): void {
  db.prepare(`DELETE FROM meta WHERE key LIKE ? AND substr(value, 1, 10) < date('now', '-7 day')`).run(
    `${EDIT_PREFIX}%`,
  );
  db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(
    `${EDIT_PREFIX}${sessionId}`,
    new Date().toISOString(),
  );
}
