import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { dashboardState, startDashboard } from '../src/dashboard.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
const SESSION = 'dash-sess';

const call = (tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown>) =>
  tool.handler({ cwd: process.cwd(), ...args }, { db }) as any;

beforeEach(() => {
  dbFile = tempDbPath('dashboard');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
});

function work() {
  call(logSessionConcepts, {
    session_id: SESSION,
    concepts: [
      { slug: 'csrf', context: 'chose SameSite=Lax on the session cookie' },
      { slug: 'jwt-structure', context: 'signed the access token in token.ts' },
    ],
  });
}

const bySlug = (s: any, slug: string) => s.concepts.find((c: any) => c.slug === slug);

describe('dashboardState', () => {
  it('splits a day three ways and never double-counts an answer', () => {
    work();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q1', answer: 'a', grade: 5, difficulty: 2 });
    call(recordAttempt, { session_id: SESSION, slug: 'jwt-structure', question: 'q2', answer: 'a', grade: 1, difficulty: 2 });
    call(recordAttempt, { session_id: SESSION, slug: 'jwt-structure', question: 'q3', grade: 0, difficulty: 2, outcome: 'declined' });

    const s = dashboardState(db) as any;
    const today = s.daily.at(-1);
    expect(today.passed).toBe(1);
    expect(today.missed).toBe(1);
    expect(today.skipped).toBe(1);
    // Every attempt lands in exactly one bucket, so the day sums to the total.
    expect(today.passed + today.missed + today.skipped).toBe(s.totals.answers);
    expect(s.totals.passed + s.totals.missed + s.totals.skipped).toBe(s.totals.answers);
  });

  it('ships every attempt with the question, the answer and the tutor reply', () => {
    work();
    call(recordAttempt, {
      session_id: SESSION, slug: 'csrf', question: 'why SameSite?', answer: 'cross-site posts',
      grade: 4, difficulty: 2, format: 'mcq', options: ['a', 'b'], feedback: 'because the browser attaches cookies',
    });

    const s = dashboardState(db) as any;
    expect(s.attempts).toHaveLength(1);
    const a = s.attempts[0];
    expect(a).toMatchObject({ slug: 'csrf', question: 'why SameSite?', answer: 'cross-site posts', grade: 4, tier: 2, format: 'mcq' });
    expect(a.feedback).toMatch(/browser attaches/);
    expect(a.session_id).toBe(SESSION);
    // Options travel as the stored JSON string; the page parses them.
    expect(JSON.parse(a.options)).toEqual(['a', 'b']);
  });

  it('keeps the context line the slug hangs on, per session', () => {
    work();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 2 });
    const s = dashboardState(db) as any;
    expect(bySlug(s, 'csrf').context).toMatch(/SameSite/);
    const logged = s.logged.find((l: any) => l.slug === 'csrf');
    expect(logged.session_id).toBe(SESSION);
    expect(logged.context).toMatch(/SameSite/);
  });

  it('reports the whole catalogue, marking what has actually been asked', () => {
    const cold = dashboardState(db) as any;
    // The seed graph is all there, and none of it is claimed as touched.
    expect(cold.concepts.length).toBe(cold.totals.catalogue);
    expect(cold.concepts.every((c: any) => c.seen === false)).toBe(true);
    expect(cold.totals.touched).toBe(0);
    expect(cold.totals.catalogue).toBeGreaterThan(50);

    work();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 2 });
    const s = dashboardState(db) as any;
    expect(bySlug(s, 'csrf')).toMatchObject({ seen: true, attempts: 1, passed: 1 });
    expect(s.totals.touched).toBe(1);
    // A domain reports its catalogue and what has been reached inside it.
    const domain = s.domains.find((d: any) => d.domain === bySlug(s, 'csrf').domain);
    expect(domain.touched).toBe(1);
    expect(domain.catalogue).toBeGreaterThanOrEqual(1);
  });

  it('counts overdue days from both timestamp shapes', () => {
    work();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 1, difficulty: 2 });
    // `next_review` is a JS ISO string with a Z; a naive parser appended a
    // second one and every overdue count silently came out null.
    db.prepare("UPDATE mastery SET next_review = ? WHERE concept_id = (SELECT id FROM concepts WHERE slug = 'csrf')")
      .run(new Date(Date.now() - 3 * 86_400_000).toISOString());

    const s = dashboardState(db) as any;
    expect(bySlug(s, 'csrf').due).toBe(true);
    expect(bySlug(s, 'csrf').overdue_days).toBe(3);
  });

  it('carries the promotion runway for each project', () => {
    work();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 2 });
    const p = (dashboardState(db) as any).projects[0];
    expect(p.level).toBe('easy');
    expect(p.next_level).toBe('medium');
    expect(p.level_needed.answers).toBeGreaterThan(0);
    // The bar is said out loud rather than hinted at.
    expect(p.level_unmet).toContain('answers');
  });

  it('serves the state over loopback and stops cleanly', async () => {
    work();
    const { url, close } = await startDashboard(db, { port: 0 });
    try {
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const res = await fetch(`${url}/api/state`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).totals.catalogue).toBeGreaterThan(0);
      expect((await fetch(`${url}/nope`)).status).toBe(404);
    } finally {
      close();
    }
  });
});
