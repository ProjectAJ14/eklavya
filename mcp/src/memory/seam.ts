import { execFileSync } from 'node:child_process';
import type { DB } from '../db.js';
import { timeline } from './store.js';

/**
 * The query a session-start recall ranks by (issue #258, `retrieval.seam_query`).
 *
 * A session start has no prompt yet, so recall used to send the newest entries
 * only, and a month-old decision behind sixty newer entries never appeared.
 * What the developer is about to work on is usually written down already: the
 * branch name, the files changed and not yet committed, the last few commit
 * subjects, and what the last checkpoint said to do next. This joins them into
 * one search query.
 *
 * Every git call is bounded (`GIT_BUDGET_MS` in all) and fails open: a missing
 * git, a folder that is not a checkout or a slow filesystem leaves that part
 * out, and with nothing at all the recall falls back to newest first.
 */

/** The whole time the git calls may take together. */
export const GIT_BUDGET_MS = 1_000;
/** Changed files beyond this are not worth the query length. */
const MAX_FILES = 20;
const MAX_QUERY_CHARS = 1_500;

export interface SeamParts {
  branch: string | null;
  files: string[];
  commits: string[];
  nextSteps: string | null;
}

/** One git call within what is left of the budget, or null. */
function git(cwd: string, args: string[], deadline: number, now: () => number): string | null {
  const left = deadline - now();
  if (left <= 0) return null;
  try {
    return execFileSync('git', args, {
      cwd,
      timeout: left,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024,
    });
  } catch {
    return null;
  }
}

/** `feat/retry-backoff` → `retry backoff`; the default branches say nothing. */
export function branchWords(branch: string | null): string | null {
  if (!branch || branch === 'HEAD' || /^(main|master|trunk|develop|dev)$/.test(branch)) return null;
  const words = branch
    .replace(/^(feat|feature|fix|bugfix|hotfix|chore|refactor|docs|test|claude|release)\//i, '')
    .replace(/[/_.-]+/g, ' ')
    .trim();
  return words || null;
}

/** File paths from `git status --porcelain`, renames to their new name. */
export function porcelainFiles(out: string): string[] {
  const files: string[] = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const name = line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, '').trim();
    if (name && !files.includes(name)) files.push(name);
  }
  return files.slice(0, MAX_FILES);
}

/** The "next steps" part of a checkpoint narrative, or null. */
export function nextStepsOf(narrative: string): string | null {
  const match = /(?:^|\n)\s*(?:#+\s*)?next[ _]steps?\s*:?\s*\n?([\s\S]*?)(?:\n\s*\n|$)/i.exec(narrative);
  const text = match?.[1]?.trim();
  return text ? text.slice(0, 600) : null;
}

export function seamParts(
  db: DB,
  opts: { cwd: string | null; project: string; sessionId?: string | null },
  now: () => number = Date.now,
): SeamParts {
  const parts: SeamParts = { branch: null, files: [], commits: [], nextSteps: null };
  if (opts.cwd) {
    const deadline = now() + GIT_BUDGET_MS;
    parts.branch = branchWords(git(opts.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], deadline, now)?.trim() ?? null);
    parts.files = porcelainFiles(git(opts.cwd, ['status', '--porcelain', '--untracked-files=normal'], deadline, now) ?? '');
    parts.commits = (git(opts.cwd, ['log', '-3', '--format=%s'], deadline, now) ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  const checkpoint = timeline(db, { project: opts.project, kind: 'session_summary', excludeSuperseded: true, limit: 3 }).find(
    (e) => !opts.sessionId || e.session_id !== opts.sessionId,
  );
  parts.nextSteps = checkpoint ? nextStepsOf(checkpoint.narrative) : null;
  return parts;
}

/** The parts as one query, or null when there is nothing to search by. */
export function seamQueryOf(parts: SeamParts): string | null {
  const text = [parts.branch, ...parts.files, ...parts.commits, parts.nextSteps].filter(Boolean).join(' ').trim();
  return text ? text.slice(0, MAX_QUERY_CHARS) : null;
}
