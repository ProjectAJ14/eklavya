import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { openDb, type DB } from '../src/db.js';
import { retryOnBusy } from '../src/concurrency.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { upsertConcepts } from '../src/tools/upsert_concepts.js';
import { getSessionQuizPlan } from '../src/tools/get_session_quiz_plan.js';
import { LIMITS, type ToolDef } from '../src/tools/types.js';
import { getConfig, setConfig } from '../src/tools/config_tools.js';
import { backlogConcepts, conceptBySlug, masteryFor } from '../src/store.js';
import { MAX_INTERVAL_DAYS, MS_PER_DAY } from '../src/srs.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let home = '';
let cwd = '';
const envBackup = { ...process.env };

const call = <T>(tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown> = {}): T =>
  tool.handler({ cwd, ...args }, { db }) as T;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cwd-'));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ min_minutes_between_quizzes: 0 }));
  dbFile = tempDbPath('tool-hardening');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  process.env = { ...envBackup };
});

/**
 * Makes the first `run` of any statement matching `pattern` throw SQLITE_BUSY,
 * as a second writer would. Returns a restore function.
 */
function busyOnce(pattern: string): () => void {
  const original = db.prepare.bind(db);
  let thrown = false;
  (db as any).prepare = (sql: string) => {
    const stmt = original(sql);
    if (!thrown && sql.includes(pattern)) {
      const run = stmt.run.bind(stmt);
      (stmt as any).run = (...a: unknown[]) => {
        if (!thrown) {
          thrown = true;
          const err = new Error('database is locked') as Error & { code: string };
          err.code = 'SQLITE_BUSY';
          throw err;
        }
        return run(...a);
      };
    }
    return stmt;
  };
  return () => {
    (db as any).prepare = original;
  };
}

/** What `registerTools` does with every call: retry the whole handler on a lock. */
const viaServer = <T>(tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown>): T =>
  retryOnBusy(() => call<T>(tool, args));

describe('a retried tool call is recorded once', () => {
  // `registerTools` retries the whole handler on SQLITE_BUSY, which is only safe
  // if everything the handler writes rolls back together. record_attempt
  // committed the grade and then wrote the gate outside that transaction, so a
  // lock on the gate write retried a grade that had already landed: two attempt
  // rows for one answer, reps 2, interval 6 -- a learner jumped a rung of the
  // ladder they never climbed.
  it('record_attempt: a lock on the gate write does not record the answer twice', () => {
    const restore = busyOnce('INSERT INTO gates');
    const res = viaServer<any>(recordAttempt, {
      session_id: 's1',
      slug: 'csrf',
      question: 'What does SameSite=Lax stop?',
      answer: 'cross-site POSTs carrying the cookie',
      grade: 4,
      difficulty: 1,
    });
    restore();

    const rows = db.prepare('SELECT count(*) n FROM attempts').get() as { n: number };
    expect(rows.n).toBe(1);
    expect(res.reps).toBe(1);
    expect(res.interval_days).toBe(1);
    expect(res.repeat_question).toBe(false);
    expect(masteryFor(db, conceptBySlug(db, 'csrf')!.id).reps).toBe(1);
  });

  it('record_attempt: a lock on the attempt write itself still records it exactly once', () => {
    const restore = busyOnce('INSERT INTO attempts');
    const res = viaServer<any>(recordAttempt, {
      session_id: 's1',
      slug: 'csrf',
      question: 'q',
      answer: 'a',
      grade: 4,
      difficulty: 1,
    });
    restore();
    expect((db.prepare('SELECT count(*) n FROM attempts').get() as { n: number }).n).toBe(1);
    expect(res.reps).toBe(1);
  });

  // The same shape: the concepts committed, then the gate was written outside.
  // A retry re-ran the insert, found the concept already there, and reported
  // `created: []` -- dropping the next_action that tells the tutor to give the
  // new concept a real domain and prerequisites.
  it('log_session_concepts: a lock on the gate write does not lose what was created', () => {
    const restore = busyOnce('INSERT INTO gates');
    const res = viaServer<any>(logSessionConcepts, {
      session_id: 's1',
      concepts: [{ slug: 'brand-new-idea-xyz', context: 'wrote it' }],
    });
    restore();
    expect(res.created).toEqual(['brand-new-idea-xyz']);
    expect(res.next_action).toContain('brand-new-idea-xyz');
    expect(res.gate.required).toBe(1);
  });
});

describe('a concept holding an absurd interval can still be graded', () => {
  // Rows written before the interval ceiling: after ~60 passes interval x ease
  // left the Date range, `toISOString` threw, and every later record_attempt on
  // the concept failed -- forever, because the row that caused it never changed.
  it('grades it, and the row comes back inside the ceiling', () => {
    const id = conceptBySlug(db, 'csrf')!.id;
    db.prepare(
      `INSERT INTO mastery (concept_id, score, ease, interval_d, reps, last_seen, next_review)
       VALUES (?, 0.9, 2.9, 99000000, 60, ?, '+275760-09-13T00:00:00.000Z')`,
    ).run(id, new Date().toISOString());

    const res = call<any>(recordAttempt, { session_id: 's1', slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 3 });
    expect(res.error).toBeUndefined();
    expect(res.interval_days).toBe(MAX_INTERVAL_DAYS);
    expect(Date.parse(res.next_review) - Date.now()).toBeLessThanOrEqual(MAX_INTERVAL_DAYS * MS_PER_DAY + 60_000);
  });

  it('reads it back clamped, so nothing downstream sees the extended year', () => {
    const id = conceptBySlug(db, 'csrf')!.id;
    const seen = '2026-01-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO mastery (concept_id, score, ease, interval_d, reps, last_seen, next_review)
       VALUES (?, 0.9, 2.9, 99000000, 60, ?, '+275760-09-13T00:00:00.000Z')`,
    ).run(id, seen);
    const m = masteryFor(db, id);
    expect(m.interval_d).toBe(MAX_INTERVAL_DAYS);
    expect(m.next_review).toBe(new Date(Date.parse(seen) + MAX_INTERVAL_DAYS * MS_PER_DAY).toISOString());
  });
});

/**
 * Model-supplied text is persisted and quoted back into later prompts, so each
 * field has a ceiling. The MCP SDK validates every call against `inputSchema`
 * before the handler runs, so parsing the schema here is exactly what a real
 * call meets. Each case is tried at the limit (accepted) and one past it
 * (rejected, naming the field).
 */
describe('free-text inputs are bounded', () => {
  const parse = (tool: ToolDef, args: Record<string, unknown>) => z.object(tool.inputSchema).safeParse(args);
  const str = (n: number) => 'x'.repeat(n);

  const attempt = { slug: 'csrf', question: 'q', grade: 4, difficulty: 1 };
  const concept = (extra: Record<string, unknown>) => ({ concepts: [{ slug: 'csrf', ...extra }] });

  const cases: { tool: ToolDef; field: string; limit: number; build: (v: any) => Record<string, unknown> }[] = [
    { tool: recordAttempt, field: 'question', limit: LIMITS.question, build: (v) => ({ ...attempt, question: v }) },
    { tool: recordAttempt, field: 'answer', limit: LIMITS.answer, build: (v) => ({ ...attempt, answer: v }) },
    { tool: recordAttempt, field: 'feedback', limit: LIMITS.feedback, build: (v) => ({ ...attempt, feedback: v }) },
    { tool: recordAttempt, field: 'slug', limit: LIMITS.slug, build: (v) => ({ ...attempt, slug: v }) },
    { tool: recordAttempt, field: 'session_id', limit: LIMITS.sessionId, build: (v) => ({ ...attempt, session_id: v }) },
    { tool: recordAttempt, field: 'cwd', limit: LIMITS.cwd, build: (v) => ({ ...attempt, cwd: v }) },
    { tool: recordAttempt, field: 'options[0]', limit: LIMITS.option, build: (v) => ({ ...attempt, format: 'mcq', options: [v, 'b', 'c', 'd'] }) },
    { tool: logSessionConcepts, field: 'context', limit: LIMITS.context, build: (v) => concept({ context: v }) },
    { tool: logSessionConcepts, field: 'name', limit: LIMITS.name, build: (v) => concept({ name: v }) },
    { tool: logSessionConcepts, field: 'domain', limit: LIMITS.domain, build: (v) => concept({ domain: v }) },
    { tool: logSessionConcepts, field: 'slug', limit: LIMITS.slug, build: (v) => ({ concepts: [{ slug: v }] }) },
    { tool: upsertConcepts, field: 'description', limit: LIMITS.description, build: (v) => concept({ description: v }) },
    { tool: upsertConcepts, field: 'name', limit: LIMITS.name, build: (v) => concept({ name: v }) },
    { tool: upsertConcepts, field: 'domain', limit: LIMITS.domain, build: (v) => concept({ domain: v }) },
    { tool: upsertConcepts, field: 'edges.from', limit: LIMITS.slug, build: (v) => ({ ...concept({}), edges: [{ from: v, to: 'csrf', relation: 'related_to' }] }) },
    { tool: getSessionQuizPlan, field: 'domain', limit: LIMITS.domain, build: (v) => ({ domain: v }) },
    { tool: getSessionQuizPlan, field: 'slugs[0]', limit: LIMITS.slug, build: (v) => ({ slugs: [v] }) },
  ];

  for (const c of cases) {
    it(`${c.tool.name}.${c.field}: ${c.limit} accepted, ${c.limit + 1} rejected`, () => {
      expect(parse(c.tool, c.build(str(c.limit))).success).toBe(true);
      const over = parse(c.tool, c.build(str(c.limit + 1)));
      expect(over.success).toBe(false);
      expect(JSON.stringify(over.error?.issues)).toMatch(/too_big/);
    });
  }

  const arrays: { tool: ToolDef; field: string; limit: number; build: (n: number) => Record<string, unknown> }[] = [
    { tool: recordAttempt, field: 'options', limit: LIMITS.options, build: (n) => ({ ...attempt, options: Array(n).fill('o') }) },
    { tool: logSessionConcepts, field: 'concepts', limit: LIMITS.concepts, build: (n) => ({ concepts: Array.from({ length: n }, (_, i) => ({ slug: `c-${i}` })) }) },
    { tool: upsertConcepts, field: 'concepts', limit: LIMITS.concepts, build: (n) => ({ concepts: Array.from({ length: n }, (_, i) => ({ slug: `c-${i}` })) }) },
    { tool: upsertConcepts, field: 'edges', limit: LIMITS.edges, build: (n) => ({ ...concept({}), edges: Array(n).fill({ from: 'a', to: 'b', relation: 'related_to' }) }) },
    { tool: getSessionQuizPlan, field: 'slugs', limit: LIMITS.concepts, build: (n) => ({ slugs: Array(n).fill('csrf') }) },
  ];

  for (const a of arrays) {
    it(`${a.tool.name}.${a.field}: ${a.limit} entries accepted, ${a.limit + 1} rejected`, () => {
      expect(parse(a.tool, a.build(a.limit)).success).toBe(true);
      expect(parse(a.tool, a.build(a.limit + 1)).success).toBe(false);
    });
  }

  it('the limits leave headroom over a realistic question, and multibyte text counts in characters', () => {
    const stem = 'In auth.ts the refresh cookie is set with SameSite=Lax. Which request would still carry it? '.repeat(4);
    expect(parse(recordAttempt, { ...attempt, question: stem, format: 'mcq', options: ['a', 'b', 'c', 'd'] }).success).toBe(true);
    expect(parse(recordAttempt, { ...attempt, question: 'é'.repeat(LIMITS.question) }).success).toBe(true);
  });
});

describe('slugs and clocks the planner is handed', () => {
  it('get_session_quiz_plan normalises named slugs, as every other tool does', () => {
    const plan = call<any>(getSessionQuizPlan, { session_id: 's1', slugs: ['  JWT Structure '] });
    expect(plan.concepts.map((c: any) => c.slug)).toEqual(['jwt-structure']);
    expect(plan.concepts[0].reason).toBe('topic');
  });

  it('a slug that normalises to nothing is not a topic request', () => {
    const plan = call<any>(getSessionQuizPlan, { session_id: 's1', slugs: ['!!!'] });
    expect(plan.reason).not.toBe('no_candidates');
  });

  it('log_session_concepts never mints a slug that fails validation', () => {
    const res = call<any>(logSessionConcepts, {
      session_id: 's1',
      concepts: [{ slug: `${'a'.repeat(79)} tail` }, { slug: '---' }],
    });
    expect(res.logged).toEqual(['a'.repeat(79)]);
    const bad = db.prepare("SELECT count(*) n FROM concepts WHERE slug LIKE '%-' OR slug = ''").get() as { n: number };
    expect(bad.n).toBe(0);
  });

  it('a last attempt stamped in the future reads as just now, not as a negative age', () => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ cadence: 'interleaved', min_minutes_between_checkpoints: 4 }),
    );
    call(logSessionConcepts, { session_id: 's1', concepts: [{ slug: 'csrf' }, { slug: 'pkce' }] });
    call(recordAttempt, { session_id: 's1', slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 1 });
    // The clock moved back an hour after that answer was written.
    db.prepare("UPDATE attempts SET ts = datetime('now', '+60 minutes')").run();
    const plan = call<any>(getSessionQuizPlan, { session_id: 's1' });
    expect(plan.reason).toBe('cooldown');
    expect(plan.minutes_remaining).toBeLessThanOrEqual(4);
  });

  it('backlog works for a project with more sessions than SQLite can bind variables', () => {
    // One bound variable per session used to be the shape; SQLite caps a
    // statement at 32,766, and a project a year old can pass that.
    call(logSessionConcepts, { session_id: 'earlier', concepts: [{ slug: 'pkce' }] });
    const repo = (db.prepare("SELECT repo FROM gates WHERE session_id = 'earlier'").get() as { repo: string | null }).repo;
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40000)
       INSERT INTO gates (session_id, mode, required, answered, passed, updated_at, repo)
       SELECT 'filler-' || i, 'ambient', 0, 0, 1, datetime('now'), ? FROM n`,
    ).run(repo);

    const started = Date.now();
    const backlog = backlogConcepts(db, 'current', null).map((c) => c.slug);
    expect(backlog).toEqual(['pkce']);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('backlog still folds a NULL-repo session into the global project, and keeps projects apart', () => {
    call(logSessionConcepts, { session_id: 'earlier', concepts: [{ slug: 'pkce' }] });
    db.prepare("UPDATE gates SET repo = NULL WHERE session_id = 'earlier'").run();
    expect(backlogConcepts(db, 'current', null).map((c) => c.slug)).toEqual(['pkce']);
    expect(backlogConcepts(db, 'current', '/some/other/checkout')).toEqual([]);
  });
});

describe('set_config says which refusal it is', () => {
  function checkout(): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-co-')));
    fs.mkdirSync(path.join(dir, '.git'));
    return dir;
  }

  it('a project-scope provider is global_only, and nothing is written', () => {
    const dir = checkout();
    try {
      const res = call<any>(setConfig, {
        scope: 'project',
        cwd: dir,
        providers: { observer: { kind: 'anthropic', model: 'claude-haiku' } },
      });
      expect(res.error).toBe('global_only');
      expect(res.keys).toEqual(['providers']);
      expect(call<any>(getConfig, { cwd: dir }).project_path).toBeTruthy();
      expect(fs.existsSync(call<any>(getConfig, { cwd: dir }).project_path)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the same provider at global scope is accepted', () => {
    const res = call<any>(setConfig, { scope: 'global', providers: { observer: null } });
    expect(res.error).toBeUndefined();
  });

  it('an unparseable config file is unreadable_config, and the file is left as it was', () => {
    const file = path.join(home, 'config.json');
    fs.writeFileSync(file, '{ "focus": "project", oops');
    const res = call<any>(setConfig, { scope: 'global', difficulty: 'hard' });
    expect(res.error).toBe('unreadable_config');
    expect(res.file).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "focus": "project", oops');
  });

  it('a slug collision is still project_collision', () => {
    const dir = checkout();
    try {
      const target = call<any>(getConfig, { cwd: dir }).project_path as string;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ project: '/somewhere/else/entirely' }));
      const res = call<any>(setConfig, { scope: 'project', cwd: dir, difficulty: 'hard' });
      expect(res.error).toBe('project_collision');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('get_config reports a global-only key a project file sets as ignored', () => {
    const dir = checkout();
    try {
      const target = call<any>(getConfig, { cwd: dir }).project_path as string;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify({ project: dir, providers: { observer: null } }));
      expect(call<any>(getConfig, { cwd: dir }).ignored_in_project).toEqual(['providers']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
