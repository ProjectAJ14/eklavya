import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { TOOLS, registerTools } from '../src/tools/index.js';
import { codeFindSymbol, codeOutline } from '../src/tools/code_tools.js';
import { memoryCollections } from '../src/tools/collection_tools.js';
import { memoryStatus, memoryTimeline, memorySearch } from '../src/tools/memory_read_tools.js';
import { memoryCorrect, memoryDelete, memoryWrite } from '../src/tools/memory_write_tools.js';
import { upsertConcepts } from '../src/tools/upsert_concepts.js';
import { getConceptGraph } from '../src/tools/get_concept_graph.js';
import { getLearnerProfile } from '../src/tools/get_learner_profile.js';
import { getSessionQuizPlan } from '../src/tools/get_session_quiz_plan.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { setConfig } from '../src/tools/config_tools.js';
import { insertEntry, recordReceipt } from '../src/memory/store.js';
import { ESTIMATOR } from '../src/memory/tokens.js';
import { conceptBySlug, insertConcept, projectKey } from '../src/store.js';
import { findRepoConfig } from '../src/config.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let home = '';
let cwd = '';
const envBackup = { ...process.env };
const cwdBackup = process.cwd();

const call = <T>(tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown> = {}): T =>
  tool.handler({ cwd, ...args }, { db }) as T;

function configure(patch: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ min_minutes_between_quizzes: 0, ...patch }));
}

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cwd-')));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
  dbFile = tempDbPath('tools-coverage');
  db = openDb(dbFile);
  configure({});
});

afterEach(() => {
  process.chdir(cwdBackup);
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  process.env = { ...envBackup };
});

describe('registerTools', () => {
  /** A stand-in server that keeps each registered callback, so a call goes through the real wrapper. */
  function registered(target: unknown) {
    const handlers = new Map<string, (args: unknown) => Promise<any>>();
    const server = { registerTool: (name: string, _meta: unknown, cb: (args: unknown) => Promise<any>) => handlers.set(name, cb) };
    registerTools(server as any, target as DB);
    return handlers;
  }

  it('registers every tool and returns its result as JSON text', async () => {
    const handlers = registered(db);
    expect([...handlers.keys()].sort()).toEqual(TOOLS.map((t) => t.name).sort());
    const res = await handlers.get('get_learner_profile')!({ cwd });
    expect(res.isError).toBe(false);
    expect(JSON.parse(res.content[0].text).quiz_enabled).toBe(true);
  });

  it('turns a thrown Error into a tool_failed envelope instead of crashing', async () => {
    const closed = openDb(tempDbPath('tools-closed'));
    closed.close();
    const res = await registered(closed).get('get_concept_graph')!({ domain: 'web-auth' });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toMatchObject({ error: 'tool_failed', tool: 'get_concept_graph' });
  });

  it('reports a thrown non-Error as text', async () => {
    // Any property read throws a bare string, which is what some native code does.
    const hostile = new Proxy({}, { get: () => { throw 'boom'; } });
    const res = await registered(hostile).get('get_concept_graph')!({ domain: 'web-auth' });
    expect(JSON.parse(res.content[0].text)).toEqual({ error: 'tool_failed', tool: 'get_concept_graph', detail: 'boom' });
  });
});

describe('code tools', () => {
  beforeEach(() => {
    gitInit(cwd);
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(
      path.join(cwd, 'src', 'auth.ts'),
      ['import x from "y";', '', 'export function rotateRefreshToken(t: string) {', '  return t;', '}', ''].join('\n'),
    );
    fs.writeFileSync(path.join(cwd, 'notes.xyz'), 'nothing to see');
  });

  it('outlines a file given relative to the repository', () => {
    const res = call<any>(codeOutline, { file: 'src/auth.ts' });
    expect(res.file).toBe('src/auth.ts');
    expect(res.symbols.map((s: { name: string }) => s.name)).toContain('rotateRefreshToken');
  });

  it('expands one line of an absolute path', () => {
    const res = call<any>(codeOutline, { file: path.join(cwd, 'src', 'auth.ts'), line: 3 });
    expect(res.line).toBe(3);
    expect(res.text).toContain('rotateRefreshToken');
  });

  it('says unreadable for a missing file it could have parsed', () => {
    expect(call<any>(codeOutline, { file: 'src/missing.ts' })).toMatchObject({ error: 'unreadable' });
    expect(call<any>(codeOutline, { file: 'src/missing.ts', line: 2 })).toEqual({ error: 'unreadable', file: 'src/missing.ts' });
  });

  it('says unsupported_language rather than returning an empty outline', () => {
    expect(call<any>(codeOutline, { file: 'notes.xyz' })).toMatchObject({ error: 'unsupported_language', file: 'notes.xyz' });
  });

  it('finds where a symbol is declared, with a limit', () => {
    const res = call<any>(codeFindSymbol, { name: 'refresh' });
    expect(res.count).toBe(1);
    expect(res.hits[0]).toMatchObject({ file: path.join('src', 'auth.ts'), line: 3, symbol: 'rotateRefreshToken' });
    expect(call<any>(codeFindSymbol, { name: 'refresh', limit: 1 }).count).toBe(1);
  });

  it('refuses to search outside a checkout', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-bare-'));
    try {
      expect(call<any>(codeFindSymbol, { name: 'x', cwd: bare })).toMatchObject({ error: 'no_repository' });
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('memory_collections', () => {
  beforeEach(() => {
    gitInit(cwd);
    call(memoryWrite, { title: 'Refresh cookie rotation', body: 'Every use rotates the cookie.', files: ['src/auth.ts'] });
    call(memoryWrite, { title: 'WAL checkpointing', body: 'sqlite checkpoint on idle.' });
  });

  it('creates, lists, shows, rebuilds and deletes a collection', () => {
    const created = call<any>(memoryCollections, { action: 'create', name: 'auth', description: 'auth work', query: 'cookie rotation' });
    expect(created.created).toBe('auth');
    expect(created.members).toBeGreaterThan(0);

    const listed = call<any>(memoryCollections, { action: 'list' });
    expect(listed.collections).toHaveLength(1);
    expect(listed.collections[0]).toMatchObject({ name: 'auth', description: 'auth work' });

    const shown = call<any>(memoryCollections, { action: 'show', name: 'auth' });
    expect(shown.count).toBe(created.members);
    expect(shown.entries).toContainEqual(expect.objectContaining({ title: 'Refresh cookie rotation', files: ['src/auth.ts'] }));
    expect(call<any>(memoryCollections, { action: 'show', name: 'auth', limit: 1 }).count).toBe(1);

    expect(call<any>(memoryCollections, { action: 'rebuild', name: 'auth' }).members).toBe(created.members);
    expect(call<any>(memoryCollections, { action: 'delete', name: 'auth' })).toEqual({ deleted: 'auth' });
    expect(call<any>(memoryCollections, { action: 'list' }).collections).toEqual([]);
  });

  it('saves a cross-project collection with no project', () => {
    call(memoryCollections, { action: 'create', name: 'all', all_projects: true, type: 'note' });
    expect(call<any>(memoryCollections, { action: 'list' }).collections[0].project).toBeNull();
  });

  it('needs a name for everything but list, and reports unknown names', () => {
    expect(call<any>(memoryCollections, { action: 'show' })).toEqual({ error: 'name_required', action: 'show' });
    for (const action of ['show', 'rebuild', 'delete']) {
      expect(call<any>(memoryCollections, { action, name: 'nope' })).toEqual({ error: 'not_found', name: 'nope' });
    }
  });
});

describe('memory read tools', () => {
  beforeEach(() => gitInit(cwd));

  it('reads a malformed or non-list files column as no files', () => {
    const project = projectKey(findRepoConfig(cwd).repoRoot);
    const a = insertEntry(db, { project, title: 'Bad files json', narrative: 'x' });
    const b = insertEntry(db, { project, title: 'Object files json', narrative: 'y' });
    db.prepare('UPDATE memory_entries SET files = ? WHERE id = ?').run('{not json', a);
    db.prepare('UPDATE memory_entries SET files = ? WHERE id = ?').run('{"a":1}', b);
    const res = call<any>(memoryTimeline, {});
    expect(res.limit).toBe(20);
    expect(res.entries.map((e: { files: string[] }) => e.files)).toEqual([[], []]);
  });

  it('counts a confirmed receipt as a confirmed saving', () => {
    const project = projectKey(findRepoConfig(cwd).repoRoot);
    const id = call<{ id: number }>(memoryWrite, { title: 'Quota backoff', body: 'Retry with jitter.' }).id;
    recordReceipt(db, { project, scope: 'test', method: ESTIMATOR, delivery: 'confirmed', items: [{ entryId: id, sourceTokens: 500, sentTokens: 20 }] });
    const res = call<any>(memoryStatus, {});
    expect(res.receipts.confirmed).toBe(1);
    expect(res.savings).toMatchObject({ kind: 'saving', base: 500, delivered: 20 });
  });

  it('still reports on a database it cannot read', () => {
    // Every query throws: the status tool falls back field by field instead of failing.
    const broken = { prepare: () => { throw new Error('no such table'); } };
    const res = memoryStatus.handler({ cwd }, { db: broken as unknown as DB }) as any;
    expect(res).toMatchObject({ entries: 0, pending_events: 0, newest_evidence: null, session_id: 'default' });
    expect(res.queue).toEqual({ pending: 0, paused: 0, failed: 0, quarantined: 0, oldest: null });
  });
});

describe('memory write tools', () => {
  beforeEach(() => gitInit(cwd));

  it('corrects only the title or only the body, keeping the other', () => {
    const id = call<{ id: number }>(memoryWrite, { title: 'Old title', body: 'Old body.' }).id;
    const t = call<any>(memoryCorrect, { id, title: 'New title' });
    const b = call<any>(memoryCorrect, { id: t.id, body: 'New body.' });
    const hit = call<any>(memorySearch, { query: 'new title' }).results[0];
    expect(hit.id).toBe(b.id);
    expect(hit.title).toBe('New title');
  });

  it('refuses to correct an entry that was already replaced', () => {
    const id = call<{ id: number }>(memoryWrite, { title: 'Original', body: 'Body.' }).id;
    const replaced = call<any>(memoryCorrect, { id, body: 'Fixed.' });
    expect(call<any>(memoryCorrect, { id, body: 'Again.' })).toMatchObject({ error: 'already_superseded' });
    expect(call<any>(memoryCorrect, { id, body: 'Again.' }).detail).toContain(String(replaced.id));
  });

  it('soft-deletes by default', () => {
    const id = call<{ id: number }>(memoryWrite, { title: 'Doomed', body: 'Body.' }).id;
    expect(call<any>(memoryDelete, { id })).toMatchObject({ id, hard: false, deleted: true });
    expect(call<any>(memoryDelete, { id: 999999 })).toMatchObject({ error: 'not_found' });
  });
});

describe('upsert_concepts', () => {
  it('fills in a name, domain and tier the caller left out', () => {
    const res = call<any>(upsertConcepts, { concepts: [{ slug: 'zebra-striping-queues' }] });
    expect(res.created).toEqual(['zebra-striping-queues']);
    expect(conceptBySlug(db, 'zebra-striping-queues')).toMatchObject({ name: 'zebra striping queues', domain: 'general', tier: 2 });
  });

  it('rejects new concepts once the session cap is spent', () => {
    configure({ max_new_concepts_per_session: 0 });
    const res = call<any>(upsertConcepts, { concepts: [{ slug: 'quokka-lattice-merge' }] });
    expect(res.created).toEqual([]);
    expect(res.rejected).toEqual([{ slug: 'quokka-lattice-merge', reason: 'session_cap_reached' }]);
  });
});

describe('get_concept_graph', () => {
  it('treats an attempted concept with no mastery row as unknown', () => {
    const c = insertConcept(db, { slug: 'orphan-attempt', name: 'Orphan attempt', domain: 'cov-domain', tier: 1 });
    insertConcept(db, { slug: 'orphan-next', name: 'Next', domain: 'cov-domain', tier: 2 });
    db.prepare('INSERT INTO attempts (concept_id, question, grade, difficulty) VALUES (?, ?, ?, ?)').run(c.id, 'q?', 5, 1);
    db.prepare('DELETE FROM mastery WHERE concept_id = ?').run(c.id);

    const res = call<any>(getConceptGraph, { domain: 'cov-domain', include_mastery: true, unmastered_only: true });
    const node = res.concepts.find((n: { slug: string }) => n.slug === 'orphan-attempt');
    expect(node).toMatchObject({ score: 0, known: false, attempts: 1 });
    expect(res.concepts).toHaveLength(2);
  });
});

describe('get_learner_profile', () => {
  it('lists an attempted concept with no mastery row, and one owed a review', () => {
    configure({ difficulty: 'medium' });
    const orphan = insertConcept(db, { slug: 'orphan-profile', name: 'Orphan', domain: 'cov-profile', tier: 2 });
    const owed = insertConcept(db, { slug: 'owed-profile', name: 'Owed', domain: 'cov-profile', tier: 3 });
    db.prepare('INSERT INTO attempts (concept_id, question, grade, difficulty) VALUES (?, ?, ?, ?)').run(orphan.id, 'q1?', 4, 2);
    db.prepare('INSERT INTO attempts (concept_id, question, grade, difficulty) VALUES (?, ?, ?, ?)').run(owed.id, 'q2?', 1, 3);
    db.prepare('INSERT OR REPLACE INTO mastery (concept_id, score, reps, next_review) VALUES (?, 0.1, 0, ?)').run(
      owed.id,
      '2000-01-01T00:00:00Z',
    );

    const res = call<any>(getLearnerProfile, { domain: 'cov-profile' });
    expect(res.domains).toEqual([{ domain: 'cov-profile', known: 0, learning: 2, unseen: 0 }]);
    expect(res.weak).toEqual(expect.arrayContaining(['orphan-profile', 'owed-profile']));
    expect(res.due_for_review.map((d: { slug: string }) => d.slug)).toEqual(['owed-profile']);
    expect(res.due_for_review[0].tier_to_ask).toBeLessThanOrEqual(4);
    // A pinned difficulty is reported as pinned.
    expect(res.level).toMatchObject({ level: 'medium', pinned: true });
  });
});

describe('get_session_quiz_plan', () => {
  it('checks the process directory for changes when no cwd is given', () => {
    configure({ cadence: 'interleaved', min_minutes_between_checkpoints: 0, quiz: { enabled: true, enforced: false, only_on_changes: true } });
    process.chdir(cwd);
    logSessionConcepts.handler({ session_id: 's1', concepts: [{ slug: 'csrf', context: 'SameSite' }] }, { db });
    expect(getSessionQuizPlan.handler({ session_id: 's1' }, { db })).toMatchObject({ questions_needed: 0, reason: 'no_code_change' });
  });

  it('says no_candidates for a topic with nothing in it', () => {
    const res = call<any>(getSessionQuizPlan, { session_id: 's1', domain: 'no-such-domain-anywhere', ignore_cooldown: true });
    expect(res).toMatchObject({ questions_needed: 0, reason: 'no_candidates' });
  });

  it('orders a concept with an unreadable log time after the rest', () => {
    configure({ cadence: 'end', focus: 'project', quiz: { enabled: true, enforced: true, only_on_changes: false } });
    call(logSessionConcepts, {
      session_id: 's1',
      concepts: [
        { slug: 'csrf', context: 'SameSite on the cookie' },
        { slug: 'jwt-structure', context: 'signed the token' },
      ],
    });
    const csrf = conceptBySlug(db, 'csrf')!;
    db.prepare("UPDATE session_concepts SET ts = 'not a time' WHERE session_id = 's1' AND concept_id = ?").run(csrf.id);
    const res = call<any>(getSessionQuizPlan, { session_id: 's1', ignore_cooldown: true });
    const slugs = res.concepts.map((c: { slug: string }) => c.slug);
    expect(slugs).toContain('csrf');
    expect(slugs).toContain('jwt-structure');
  });
});

describe('record_attempt', () => {
  it('reports no unmet conditions when a pinned band has met them all', () => {
    // Pinned, so nothing promotes; with a bar of one answer, one pass meets it.
    configure({ difficulty: 'easy', level_up_after: 1, level_up_accuracy: 0 });
    const res = call<any>(recordAttempt, {
      session_id: 's1',
      slug: 'csrf',
      question: 'why SameSite=Lax here?',
      answer: 'it stops cross-site POSTs carrying the cookie',
      grade: 5,
      difficulty: 1,
    });
    expect(res.level_progress.pinned).toBe(true);
    expect(res.level_progress.unmet).toBeUndefined();
  });
});

describe('set_config', () => {
  it('honours the legacy ambient mode', () => {
    const res = call<any>(setConfig, { scope: 'global', mode: 'ambient' });
    expect(res.config.quiz).toMatchObject({ enabled: true, enforced: false });
  });
});
