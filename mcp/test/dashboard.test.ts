import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { dashboardState, memoryPage, memoryEntry, startDashboard, browserCommand, fromLoopback } from '../src/dashboard.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { appendEvent, insertEntry, recordReceipt, supersedeEntry, deleteEntry, addCandidate } from '../src/memory/store.js';
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

  it('hands the URL to each platform opener in the shape that platform wants', () => {
    const url = 'http://127.0.0.1:41729';
    expect(browserCommand(url, 'darwin')).toEqual(['open', [url]]);
    expect(browserCommand(url, 'linux')).toEqual(['xdg-open', [url]]);
    // The empty string is load-bearing: `start <url>` reads its first quoted
    // argument as the window title, so the URL alone can be swallowed as one.
    expect(browserCommand(url, 'win32')).toEqual(['cmd', ['/c', 'start', '', url]]);
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

/* ============================================================
   The memory half
   ============================================================ */

const PROJECT = '/tmp/repo-a';

/** One entry with its evidence, as the capture pipeline would leave it. */
function remember(opts: {
  title: string;
  session?: string;
  type?: string;
  narrative?: string;
  tags?: string[];
  body?: string;
  occurredAt?: string;
}) {
  const session = opts.session ?? SESSION;
  const ev = appendEvent(db, {
    eventUid: `uid-${opts.title}-${Math.random()}`,
    project: PROJECT,
    sessionId: session,
    kind: 'tool_use',
    tool: 'Edit',
    title: opts.title,
    body: opts.body ?? 'diff body',
    occurredAt: opts.occurredAt,
  });
  return insertEntry(db, {
    project: PROJECT,
    sessionId: session,
    type: opts.type ?? 'bugfix',
    title: opts.title,
    narrative: opts.narrative ?? 'what happened here',
    tags: opts.tags,
    eventIds: [ev.id],
    occurredAt: opts.occurredAt,
  });
}

describe('dashboardState — memory', () => {
  it('carries the memory, reuse and health sections without renaming anything', () => {
    work();
    const id = remember({ title: 'fixed the cookie flag', tags: ['auth'] });
    recordReceipt(db, {
      project: PROJECT,
      sessionId: SESSION,
      scope: 'session_start',
      method: 'chars4-v1',
      delivery: 'confirmed',
      items: [{ entryId: id, sourceTokens: 400, sentTokens: 100 }],
    });

    const s = dashboardState(db) as any;
    // Additive: every learning key is still there and still shaped the same.
    for (const k of ['config', 'totals', 'daily', 'projects', 'domains', 'concepts', 'attempts', 'logged']) {
      expect(s[k], k).toBeDefined();
    }
    expect(s.memory).toMatchObject({ entries: 1, captured: 1, superseded: 0, deleted: 0 });
    expect(s.memory.per_page).toBeGreaterThan(0);
    expect(s.memory.tags).toContainEqual({ tag: 'auth', n: 1 });
    expect(s.reuse).toMatchObject({ base: 400, delivered: 100, receipts: 1, confirmed: 1 });
    expect(s.reuse.savings).toMatchObject({ kind: 'saving', percent: 75 });
    expect(s.reuse.estimator).toBe('chars4-v1');
    expect(s.health.queue).toMatchObject({ pending: 0, paused: 0, failed: 0 });
    expect(s.health.capture.newest_event).toBeTruthy();
    // No secret, and not even the name of the variable one would be read from.
    expect(JSON.stringify(s.health)).not.toMatch(/api_key/i);
    expect(s.memory_sessions[0]).toMatchObject({ session_id: SESSION, events: 1, entries: 1 });
  });

  it('distinguishes captured, processed, indexed, reused, exposed and assessed', () => {
    work();
    const id = remember({ title: 'a decision' });
    // Selected for a receipt, but the host never confirmed it was delivered.
    recordReceipt(db, {
      project: PROJECT,
      scope: 'search',
      method: 'chars4-v1',
      delivery: 'prepared',
      items: [{ entryId: id, sourceTokens: 900, sentTokens: 90 }],
    });
    addCandidate(db, { entryId: id, slug: 'csrf', name: 'CSRF', domain: 'web-auth', confidence: 0.8 });

    const m = (dashboardState(db) as any).memory;
    expect(m.captured).toBe(1);
    expect(m.reused).toBe(1);
    // Prepared is not delivered, and a proposal is not an answer.
    expect(m.exposed).toBe(0);
    expect(m.assessed).toBe(0);
    expect(m.candidates.candidate).toBe(1);
  });

  it('never reports an unconfirmed receipt as a saving', () => {
    const id = remember({ title: 'unconfirmed' });
    for (const delivery of ['prepared', 'unknown'] as const) {
      recordReceipt(db, {
        project: PROJECT,
        scope: 'session_start',
        method: 'chars4-v1',
        delivery,
        items: [{ entryId: id, sourceTokens: 1000, sentTokens: 10 }],
      });
    }
    const r = (dashboardState(db) as any).reuse;
    expect(r.receipts).toBe(2);
    expect(r.confirmed).toBe(0);
    // B and D stay zero because only confirmed rows are summed, so there is no
    // percentage to print — an injection that may never have reached the model
    // is not a saving.
    expect(r.base).toBe(0);
    expect(r.savings.kind).not.toBe('saving');
    expect(r.savings.percent).toBeUndefined();
    expect(r.line).not.toMatch(/%/);
    expect(r.rows.every((x: any) => x.delivery !== 'confirmed')).toBe(true);
  });

  it('splits a receipt into its index and detail stages', () => {
    const id = remember({ title: 'two stage' });
    recordReceipt(db, {
      project: PROJECT,
      scope: 'session_start',
      method: 'chars4-v1',
      delivery: 'confirmed',
      items: [
        { entryId: id, sourceTokens: 500, sentTokens: 50, stage: 'index' },
        { entryId: id, sourceTokens: 0, sentTokens: 300, stage: 'detail' },
      ],
    });
    const row = (dashboardState(db) as any).reuse.rows[0];
    expect(row).toMatchObject({ index_tokens: 50, detail_tokens: 300, detail_items: 1 });
  });

  it('reports failed jobs by class, and never their message', () => {
    const batch = db
      .prepare("INSERT INTO memory_batches (project, session_id, reason) VALUES (?, ?, 'manual')")
      .run(PROJECT, SESSION);
    db.prepare(
      `INSERT INTO memory_jobs (batch_id, status, attempts, last_error, error_class)
       VALUES (?, 'failed', 3, 'sk-secret-leaked-in-the-message', 'auth')`,
    ).run(batch.lastInsertRowid);

    const h = (dashboardState(db) as any).health;
    expect(h.queue.failed).toBe(1);
    expect(h.stalled[0]).toMatchObject({ status: 'failed', error_class: 'auth', n: 1, attempts: 3 });
    expect(JSON.stringify(h)).not.toMatch(/sk-secret/);
  });
});

describe('memoryPage', () => {
  it('pages the timeline instead of shipping the corpus', () => {
    for (let i = 0; i < 12; i++) {
      remember({ title: `entry ${i}`, occurredAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString() });
    }
    // The state payload carries the count, never the rows.
    const s = dashboardState(db) as any;
    expect(s.memory.entries).toBe(12);
    expect(s.memory.rows).toBeUndefined();

    const first = memoryPage(db, { per: 5 }) as any;
    expect(first).toMatchObject({ total: 12, page: 1, pages: 3, per: 5 });
    expect(first.rows).toHaveLength(5);
    // Newest first, and the second page continues where the first stopped.
    expect(first.rows[0].title).toBe('entry 11');
    const second = memoryPage(db, { per: 5, page: 2 }) as any;
    expect(second.rows[0].title).toBe('entry 6');
    expect(second.rows.map((r: any) => r.id)).not.toContain(first.rows[0].id);
    // A page number a filter outran is clamped, not an empty list.
    expect((memoryPage(db, { per: 5, page: 99 }) as any).page).toBe(3);
  });

  it('marks a superseded entry and a deleted one rather than hiding them', () => {
    const stale = remember({ title: 'the old claim' });
    const fresh = remember({ title: 'the correction' });
    supersedeEntry(db, stale, fresh);
    const gone = remember({ title: 'removed by hand' });
    deleteEntry(db, gone);

    const rows = (memoryPage(db, { per: 50 }) as any).rows;
    const byTitle = (t: string) => rows.find((r: any) => r.title === t);
    expect(byTitle('the old claim').superseded_by).toBe(fresh);
    expect(byTitle('removed by hand').deleted_at).toBeTruthy();
    // The live count excludes both; the timeline still shows them, marked.
    expect((dashboardState(db) as any).memory).toMatchObject({ superseded: 1, deleted: 1, entries: 1 });
  });

  it('filters by type, tag, session and free text', () => {
    remember({ title: 'cookie samesite', type: 'bugfix', tags: ['auth'], session: 's1' });
    remember({ title: 'router rewrite', type: 'refactor', tags: ['routing'], session: 's2' });

    expect((memoryPage(db, { type: 'refactor' }) as any).total).toBe(1);
    expect((memoryPage(db, { tag: 'auth' }) as any).rows[0].title).toBe('cookie samesite');
    expect((memoryPage(db, { q: 'samesite' }) as any).total).toBe(1);
    expect((memoryPage(db, { q: 'nothing matches this' }) as any).total).toBe(0);
    const s2 = memoryPage(db, { session: 's2' }) as any;
    expect(s2.total).toBe(1);
    // A session query carries that session's candidates, for the session page.
    expect(s2.candidates).toEqual([]);
    expect((memoryPage(db, { project: '/tmp/other' }) as any).total).toBe(0);
  });

  it('drills from an entry down to the raw evidence behind it', () => {
    const id = remember({ title: 'the claim', body: 'the actual tool output', tags: ['auth'] });
    addCandidate(db, { entryId: id, slug: 'csrf', name: 'CSRF', domain: 'web-auth', confidence: 0.6 });
    const d = memoryEntry(db, id) as any;
    expect(d.entry.title).toBe('the claim');
    expect(d.tags).toEqual(['auth']);
    expect(d.events[0].body).toBe('the actual tool output');
    expect(d.candidates[0]).toMatchObject({ slug: 'csrf', status: 'candidate' });
    expect(memoryEntry(db, 9999)).toBeNull();
  });
});

describe('the change cursor', () => {
  it('holds still while nothing is written', () => {
    work();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 2 });
    const first = (dashboardState(db) as any).cursor;
    // This is the property the open page polls on. A cursor that drifted on its
    // own -- a timestamp, or a hash over decayed scores -- would raise the "new
    // activity" notice every minute, and a notice that always shows is ignored.
    expect((dashboardState(db) as any).cursor).toBe(first);
  });

  it('moves when work lands, on either half', () => {
    work();
    const empty = (dashboardState(db) as any).cursor;

    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 2 });
    const answered = (dashboardState(db) as any).cursor;
    expect(answered).not.toBe(empty);

    // The memory half moves it too: evidence captured by a hook is work the
    // reader left this page open to watch for.
    remember({ title: 'fixed the cookie flag' });
    expect((dashboardState(db) as any).cursor).not.toBe(answered);
  });
});

describe('the dashboard page', () => {
  const html = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/assets/dashboard.html'),
    'utf8',
  );

  it('escapes every stored string it puts in the DOM', () => {
    // A memory row is arbitrary tool output and developer prose. One `${e.title}`
    // without `esc()` is stored XSS on a page served from the same origin as
    // everything else this machine runs on loopback.
    const stored = [
      'title', 'narrative', 'snippet', 'generator', 'tool', 'body', 'project',
      'error_class', 'method', 'scope', 'import_source', 'entry_uid', 'event_uid',
    ];
    const raw: string[] = [];
    for (const m of html.matchAll(/\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)) {
      const expr = m[1];
      if (!stored.some((f) => new RegExp(`\\.${f}\\b`).test(expr))) continue;
      if (/\besc\(/.test(expr) || /\.length\b/.test(expr)) continue;
      raw.push(expr.trim());
    }
    expect(raw).toEqual([]);
  });

  it('polls for work that landed while it was open, without stomping the reader', () => {
    // The browser half is only checkable statically here: this suite has no DOM
    // and a browser harness is not worth one poll. What still needs a human is
    // that the notice appears and that nothing on the page moves when it does.
    const poll = html.slice(html.indexOf('function poll()'), html.indexOf('/* ---------- boot'));
    expect(poll).toContain('s.cursor !== S.cursor');
    // Never while the tab is hidden, and never two requests at once.
    expect(poll).toContain("document.visibilityState !== 'visible'");
    expect(poll).toMatch(/if \(!S \|\| polling/);
    // A failed poll leaves the page on the data it has rather than blanking it.
    expect(poll).toContain('.catch(() => {})');
    expect(html).toContain("addEventListener('visibilitychange', poll)");
    // The notice is a real <button>, so Tab and Enter reach it with no wiring —
    // and it sits outside #view, which render() replaces wholesale.
    expect(html).toMatch(/<button[^>]*id="stale"/);
    expect(html.indexOf('id="stale"')).toBeLessThan(html.indexOf('id="view"'));
  });

  it('still serves every learning route alongside the memory ones', () => {
    const views = html.slice(html.indexOf('const VIEWS = {'), html.indexOf('function route()'));
    for (const route of ['overview', 'concepts', 'concept', 'review', 'sessions', 'session',
      'projects', 'domains', 'domain', 'memory', 'entry', 'reuse', 'health']) {
      expect(views, route).toMatch(new RegExp(`\\b${route}:`));
    }
  });
});

describe('the memory endpoints', () => {
  it('pages the timeline and reads one entry over loopback', async () => {
    const id = remember({ title: 'served over http', tags: ['auth'] });
    const { url, close } = await startDashboard(db, { port: 0 });
    try {
      const list = (await (await fetch(`${url}/api/memory?per=1&tag=auth`)).json()) as any;
      expect(list).toMatchObject({ total: 1, page: 1, per: 1 });
      expect(list.rows[0].title).toBe('served over http');

      const entry = (await (await fetch(`${url}/api/memory/entry?id=${id}`)).json()) as any;
      expect(entry.entry.id).toBe(id);
      expect(entry.events).toHaveLength(1);
      expect((await fetch(`${url}/api/memory/entry?id=404404`)).status).toBe(404);

      // The old contract is untouched.
      const state = (await (await fetch(`${url}/api/state`)).json()) as any;
      expect(state.totals.catalogue).toBeGreaterThan(0);
      expect(state.memory.entries).toBe(1);
    } finally {
      close();
    }
  });
});

describe('the dashboard is loopback-only, and says so to a browser', () => {
  it('accepts the addresses a browser on this machine actually uses', () => {
    for (const host of ['127.0.0.1:41729', 'localhost:41729', '[::1]:41729', '127.0.0.1', 'LOCALHOST:41729']) {
      expect(fromLoopback(host), host).toBe(true);
    }
    // No Host header at all is HTTP/1.0 or a hand-rolled client, not a
    // browser — and a browser is the only attacker this check has.
    expect(fromLoopback(undefined)).toBe(true);
  });

  it('refuses a hostname pointed at 127.0.0.1 by its own DNS', () => {
    // The attack this exists for. A page the developer has open resolves a
    // hostname it controls to loopback and fetches from here; the same-origin
    // policy does not help, because the page's origin *is* that hostname. The
    // request still carries the attacker's name in Host, which is what gives
    // it away.
    for (const host of ['evil.example', 'rebind.attacker.test:41729', '127.0.0.1.nip.io', 'localhost.evil.com']) {
      expect(fromLoopback(host), host).toBe(false);
    }
  });

  it('refuses a cross-origin request even when Host looks right', () => {
    expect(fromLoopback('127.0.0.1:41729', 'https://evil.example')).toBe(false);
    expect(fromLoopback('127.0.0.1:41729', 'http://localhost:3000')).toBe(true);
    // A sandboxed iframe or a `file://` page sends `null`, and neither is the
    // developer's own dashboard tab.
    expect(fromLoopback('127.0.0.1:41729', 'null')).toBe(true);
    expect(fromLoopback('127.0.0.1:41729', 'not a url')).toBe(false);
  });

  it('answers 403 over the wire rather than serving the payload', async () => {
    const { url, close } = await startDashboard(db, { port: 0 });
    const port = Number(new URL(url).port);

    /** Raw `http.request`: `fetch` refuses to let a caller set `Host`. */
    const get = (headers: Record<string, string>) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/api/state', method: 'GET', headers },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += String(c)));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end();
      });

    try {
      expect((await get({ host: `127.0.0.1:${port}` })).status).toBe(200);

      // The Host a rebound page sends: its own name, resolved to loopback.
      const rebound = await get({ host: 'evil.example' });
      expect(rebound.status).toBe(403);
      expect(rebound.body).toContain('loopback');
    } finally {
      close();
    }
  });
});
