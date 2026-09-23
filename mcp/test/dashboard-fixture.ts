/**
 * One synthetic learner, shared by the dashboard's payload tests, its browser
 * tests and the before/after screenshots — so a screenshot and a test that
 * disagree are disagreeing about the same rows.
 *
 * Every project shape the project inventory has to get right exists here once:
 *
 * | Folder            | What it did                                            |
 * |-------------------|--------------------------------------------------------|
 * | `answered`        | answered questions, logged nothing, captured nothing   |
 * | `logged`          | logged concepts, was never asked a question            |
 * | `memory-only`     | captured and remembered, never touched learning        |
 * | `mixed`           | all three, plus two worktrees of it (one deleted since) |
 * | `pending`         | captured evidence no observation job has processed yet |
 * | `client/api`, `server/api` | two repositories with the same folder name    |
 * | `retired`         | answered, then its checkout was deleted                |
 * | (no repository)   | answered from a directory outside any checkout (`*`)   |
 * | (legacy)          | an answer and a session from before repos were stored  |
 *
 * Real directories, because identity is resolved from the filesystem: a
 * worktree is a `.git` *file* pointing into its main checkout's `.git/worktrees`.
 * Timestamps are fixed offsets from now, so the charts always have something
 * in their window and the layout is the same on every run.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DB } from '../src/db.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { appendEvent, insertEntry, recordReceipt, addCandidate } from '../src/memory/store.js';

export interface Fixture {
  root: string;
  repo: Record<
    'answered' | 'logged' | 'memoryOnly' | 'mixed' | 'mixedFeature' | 'mixedOld' | 'pending' | 'clientApi' | 'serverApi' | 'retired',
    string
  >;
  outside: string;
  entries: { mixed: number; memoryOnly: number };
}

const call = (db: DB, tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown>) =>
  tool.handler(args, { db }) as any;

function repoDir(dir: string): string {
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function worktreeDir(dir: string, main: string, name: string): string {
  const gitdir = path.join(main, '.git', 'worktrees', name);
  fs.mkdirSync(gitdir, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${gitdir}\n`);
  return dir;
}

/** SQLite's own shape, `2026-09-05 21:04:00`, `n` days and `h` hours ago. */
const sqlAgo = (n: number, h = 0) =>
  new Date(Date.now() - n * 86400000 - h * 3600000).toISOString().slice(0, 19).replace('T', ' ');
const isoAgo = (n: number, h = 0) => new Date(Date.now() - n * 86400000 - h * 3600000).toISOString();

/**
 * Seeds `db` under `rootDir`. The caller owns `EKLAVYA_HOME`: the tools read
 * config through `loadConfig`, and pointing it at a temp directory is what
 * keeps the real learner's settings out of the fixture.
 */
export function seedFixture(db: DB, rootDir: string): Fixture {
  fs.mkdirSync(rootDir, { recursive: true });
  // Realpath first: `findRepoConfig` resolves symlinks (macOS /var is one), so
  // an unresolved root would name the same folder two ways.
  const root = fs.realpathSync(rootDir);
  const repo = {
    answered: repoDir(path.join(root, 'answered')),
    logged: repoDir(path.join(root, 'logged')),
    memoryOnly: repoDir(path.join(root, 'memory-only')),
    mixed: repoDir(path.join(root, 'mixed')),
    mixedFeature: '',
    mixedOld: '',
    pending: repoDir(path.join(root, 'pending')),
    clientApi: repoDir(path.join(root, 'client', 'api')),
    serverApi: repoDir(path.join(root, 'server', 'api')),
    retired: repoDir(path.join(root, 'retired')),
  };
  repo.mixedFeature = worktreeDir(path.join(root, 'mixed-feature'), repo.mixed, 'feature');
  repo.mixedOld = worktreeDir(path.join(root, 'mixed-old'), repo.mixed, 'old');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });

  const log = (session: string, cwd: string, concepts: { slug: string; context?: string }[]) =>
    call(db, logSessionConcepts, { session_id: session, cwd, concepts });
  const ask = (session: string, cwd: string, slug: string, grade: number, extra: Record<string, unknown> = {}) =>
    call(db, recordAttempt, {
      session_id: session, cwd, slug, grade, difficulty: 2,
      question: `What does ${slug} protect against in this change?`,
      answer: grade >= 3 ? 'the right thing' : 'not sure', format: 'mcq',
      options: ['the right thing', 'not sure', 'a third thing', 'a fourth thing'],
      feedback: 'Because the browser attaches the cookie on its own.', ...extra,
    });

  // --- answered only: questions, no logged concept, no memory.
  ask('s-answered', repo.answered, 'csrf', 5);
  ask('s-answered', repo.answered, 'jwt-structure', 2);
  ask('s-answered', repo.answered, 'cors-basics', 4);

  // --- logged, never asked.
  log('s-logged', repo.logged, [
    { slug: 'react-useeffect-cleanup', context: 'cleared the polling interval when the panel unmounts' },
    { slug: 'react-lists-keys', context: 'keyed the timeline rows by entry id' },
  ]);

  // --- mixed: learning and memory in the same session, plus two worktrees.
  log('s-mixed', repo.mixed, [
    { slug: 'csrf', context: 'chose SameSite=Lax on the session cookie' },
    { slug: 'refresh-token-rotation', context: 'rotated the refresh token on every use' },
  ]);
  ask('s-mixed', repo.mixed, 'csrf', 4);
  ask('s-mixed', repo.mixed, 'refresh-token-rotation', 1);
  ask('s-mixed', repo.mixed, 'refresh-token-rotation', 0, { outcome: 'dont_know', answer: undefined });
  log('s-feature', repo.mixedFeature, [{ slug: 'git-rebase', context: 'rebased the feature branch onto main' }]);
  ask('s-feature', repo.mixedFeature, 'git-rebase', 5);
  log('s-old', repo.mixedOld, [{ slug: 'git-stash', context: 'parked the hotfix in its own worktree' }]);

  // --- no repository, and a retired checkout.
  ask('s-outside', outside, 'key-rotation-jwks', 3);
  ask('s-retired', repo.retired, 'express-middleware', 4);
  // --- same folder name, different repositories.
  log('s-client', repo.clientApi, [{ slug: 'cors-basics', context: 'allowed the web origin on the API' }]);
  ask('s-client', repo.clientApi, 'cors-basics', 5);
  ask('s-server', repo.serverApi, 'express-middleware', 2);
  // --- legacy: recorded before attempts or gates carried a repository.
  ask('s-legacy', repo.answered, 'git-rebase', 3);
  log('s-legacy', repo.answered, [{ slug: 'git-rebase', context: 'an old session' }]);
  db.prepare("UPDATE attempts SET repo = NULL WHERE session_id = 's-legacy'").run();
  db.prepare("UPDATE gates SET repo = NULL WHERE session_id = 's-legacy'").run();

  // --- memory.
  const event = (project: string, checkout: string | null, session: string, title: string, ago: number, n = 0) =>
    appendEvent(db, {
      eventUid: `fx-${session}-${title}-${n}`, project, checkout, sessionId: session, kind: 'tool_use',
      tool: 'Edit', title, body: `diff for ${title}\n+ one line\n- another`, occurredAt: isoAgo(ago, n),
      files: ['src/auth/cookie.ts'],
    }).id;
  const remember = (project: string, session: string, type: string, title: string, ago: number, eventIds: number[], tags: string[]) =>
    insertEntry(db, {
      project, sessionId: session, type, title, tags, eventIds, occurredAt: isoAgo(ago),
      narrative: `${title}. The change keeps the session cookie out of cross-site requests.`,
      facts: ['SameSite=Lax is the default in current browsers'], files: ['src/auth/cookie.ts'],
      generator: 'local-extract-v1', confidence: 0.7,
    });

  const markDone = (ids: number[]) =>
    db.prepare(`UPDATE evidence_events SET status = 'summarized' WHERE id IN (${ids.join(',')})`).run();

  const m1 = [event(repo.mixed, repo.mixed, 's-mixed', 'Edit cookie.ts', 1), event(repo.mixed, repo.mixed, 's-mixed', 'Edit token.ts', 1, 1)];
  markDone(m1);
  const mixedEntry = remember(repo.mixed, 's-mixed', 'decision', 'Chose SameSite=Lax for the session cookie', 1, m1, ['auth', 'cookies']);
  remember(repo.mixed, 's-mixed', 'bugfix', 'Refresh token was reused after rotation', 1, [m1[1]!], ['auth']);
  // The deleted worktree captured evidence while it existed, so the fold from
  // its checkout to `mixed` is on record even after the folder is gone.
  const old = [event(repo.mixed, repo.mixedOld, 's-old', 'Edit hotfix.ts', 3)];
  markDone(old);
  remember(repo.mixed, 's-old', 'change', 'Parked the hotfix in a worktree', 3, old, ['git']);

  const mo = [event(repo.memoryOnly, repo.memoryOnly, 's-mem', 'Read README', 2), event(repo.memoryOnly, repo.memoryOnly, 's-mem', 'Edit docs', 2, 1)];
  markDone(mo);
  const memEntry = remember(repo.memoryOnly, 's-mem', 'discovery', 'The docs build reads the manual from web/', 2, mo, ['docs']);
  remember(repo.memoryOnly, 's-mem', 'feature', 'Added a route table to the manual', 2, [mo[1]!], ['docs', 'routes']);

  // Captured, not yet processed: no entry exists for this project at all.
  event(repo.pending, repo.pending, 's-pending', 'Edit queue.ts', 0);
  event(repo.pending, repo.pending, 's-pending', 'Edit worker.ts', 0, 1);

  addCandidate(db, { entryId: mixedEntry, slug: 'samesite-cookies', name: 'SameSite cookies', domain: 'web-auth', confidence: 0.8, project: repo.mixed });
  recordReceipt(db, {
    project: repo.mixed, sessionId: 's-mixed', scope: 'session_start', method: 'chars4-v1', delivery: 'confirmed',
    items: [{ entryId: mixedEntry, sourceTokens: 900, sentTokens: 120 }],
  });
  recordReceipt(db, {
    project: repo.memoryOnly, sessionId: 's-mem', scope: 'prompt', method: 'chars4-v1', delivery: 'prepared',
    items: [{ entryId: memEntry, sourceTokens: 400, sentTokens: 80 }],
  });

  // Spread the learning rows over the last fortnight so the charts have shape.
  const spread: [string, number][] = [
    ['s-answered', 12], ['s-mixed', 1], ['s-feature', 4], ['s-outside', 6], ['s-retired', 20],
    ['s-client', 8], ['s-server', 9], ['s-legacy', 40], ['s-logged', 5], ['s-old', 3],
  ];
  for (const [session, ago] of spread) {
    db.prepare('UPDATE attempts SET ts = ? WHERE session_id = ?').run(sqlAgo(ago), session);
    db.prepare('UPDATE session_concepts SET ts = ? WHERE session_id = ?').run(sqlAgo(ago), session);
  }

  // Gone since: a retired checkout and a removed worktree.
  fs.rmSync(repo.retired, { recursive: true, force: true });
  fs.rmSync(repo.mixedOld, { recursive: true, force: true });
  fs.rmSync(path.join(repo.mixed, '.git', 'worktrees', 'old'), { recursive: true, force: true });

  return { root, repo, outside, entries: { mixed: mixedEntry, memoryOnly: memEntry } };
}
