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

describe('dashboardState', () => {
  it('splits a day three ways and never double-counts an answer', () => {
    work();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q1', answer: 'a', grade: 5, difficulty: 2 });
    call(recordAttempt, { session_id: SESSION, slug: 'jwt-structure', question: 'q2', answer: 'a', grade: 1, difficulty: 2 });
    call(recordAttempt, { session_id: SESSION, slug: 'jwt-structure', question: 'q3', grade: 0, difficulty: 2, outcome: 'declined' });

    const s = dashboardState(db) as any;
    const today = s.timeline.at(-1);
    expect(today.passed).toBe(1);
    expect(today.missed).toBe(1);
    expect(today.skipped).toBe(1);
    // Every attempt lands in exactly one bucket, so the day sums to the total.
    expect(today.passed + today.missed + today.skipped).toBe(s.totals.answers);
  });

  it('keeps the context line the slug hangs on', () => {
    work();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 2 });
    const s = dashboardState(db) as any;
    expect(s.concepts.find((c: any) => c.slug === 'csrf').context).toMatch(/SameSite/);
    expect(s.recent.some((r: any) => r.slug === 'csrf')).toBe(true);
  });

  it('reports the catalogue without pretending it is a backlog', () => {
    const s = dashboardState(db) as any;
    // Nothing asked yet: no concepts on the page, but the seed graph is there.
    expect(s.concepts).toEqual([]);
    expect(s.totals.touched).toBe(0);
    expect(s.totals.catalogue).toBeGreaterThan(50);
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
