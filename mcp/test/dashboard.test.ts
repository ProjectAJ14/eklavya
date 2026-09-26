import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  dashboardState, memoryPage, memoryEntry, startDashboard, browserCommand, fromLoopback, projectInventory, localTokens,
  SETTINGS, CLI_ONLY,
} from '../src/dashboard.js';
import { knownKeys, defaultAt, SETTING_RULES, settingProblem } from '../src/config-path.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { appendEvent, insertEntry, recordReceipt, supersedeEntry, deleteEntry, addCandidate } from '../src/memory/store.js';
import { tempDbPath, cleanup } from './helpers.js';
import { seedFixture, type Fixture } from './dashboard-fixture.js';
// `tokens.css` is copied in by the build, so the served-asset case runs the built server.
import { startDashboard as startBuilt } from '../dist/dashboard.js';

let dbFile = '';
let db: DB;
const SESSION = 'dash-sess';

const call2 = (d: DB, tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown>) =>
  tool.handler(args, { db: d }) as any;
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

  it('keeps an alias for every route the single-workflow page had', () => {
    // What each alias renders is the browser suite's job (dashboard-browser.test.ts
    // follows every one); this pins that none of them was dropped from the table.
    const legacy = html.slice(html.indexOf('const LEGACY = {'), html.indexOf('function decodeParam('));
    for (const route of ['overview', 'concepts', 'concept', 'review', 'sessions', 'session',
      'projects', 'domains', 'domain', 'entry', 'reuse', 'health']) {
      expect(legacy, route).toMatch(new RegExp(`\\b${route}:`));
    }
    // `#/memory` and `#/memory/<type>` are resolved before the table, because
    // canonical Memory pages share the prefix.
    expect(html).toContain("if (head === 'memory') return canonical('memory', 'timeline', rest);");
  });

  it('asks for nothing from another host', () => {
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
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

/* ------------------------------------------------------------------
   One project inventory for both workflows (`/api/projects`).
   ------------------------------------------------------------------ */
describe('projectInventory', () => {
  let home = '';
  let fdb: DB;
  let fx: Fixture;
  const savedHome = process.env.EKLAVYA_HOME;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-inventory-'));
    // The tools read config through `loadConfig`; point it away from the
    // machine's real ~/.eklavya so this passes the same everywhere.
    process.env.EKLAVYA_HOME = path.join(home, 'home');
    fdb = openDb(path.join(home, 'knowledge.db'));
    fx = seedFixture(fdb, path.join(home, 'root'));
  });
  afterEach(() => {
    fdb.close();
    if (savedHome === undefined) delete process.env.EKLAVYA_HOME;
    else process.env.EKLAVYA_HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const byId = (inv: ReturnType<typeof projectInventory>, id: string) => inv.projects.find((p) => p.id === id);

  it('reproduces the omission: the learning payload lists only projects with answers', () => {
    const s = dashboardState(fdb) as any;
    const repos = s.projects.map((p: any) => p.repo);
    expect(repos).toContain(fx.repo.answered);
    for (const missing of [fx.repo.logged, fx.repo.memoryOnly, fx.repo.pending]) expect(repos).not.toContain(missing);
  });

  it('finds memory-only, logged-but-unanswered, answered-only and mixed projects alike', () => {
    const inv = projectInventory(fdb);
    const memoryOnly = byId(inv, fx.repo.memoryOnly)!;
    expect(memoryOnly.learning.answers).toBe(0);
    expect(memoryOnly.memory).toMatchObject({ events: 2, entries: 2, sessions: 1 });

    const logged = byId(inv, fx.repo.logged)!;
    expect(logged.learning).toMatchObject({ answers: 0, logged_concepts: 2, assessed_concepts: 0, sessions: 1 });
    expect(logged.memory.events).toBe(0);

    const answered = byId(inv, fx.repo.answered)!;
    // `record_attempt` writes a review row per graded concept; those are not
    // concepts the work logged.
    expect(answered.learning).toMatchObject({ answers: 3, assessed_concepts: 3, logged_concepts: 0 });

    const mixed = byId(inv, fx.repo.mixed)!;
    expect(mixed.learning.answers).toBeGreaterThan(0);
    expect(mixed.memory.entries).toBeGreaterThan(0);
    expect(mixed.sources).toEqual(expect.arrayContaining(['attempts', 'logged', 'evidence', 'entries', 'receipts']));
  });

  it('counts captured evidence that no observation job has processed yet', () => {
    const pending = byId(projectInventory(fdb), fx.repo.pending)!;
    expect(pending.memory).toMatchObject({ events: 2, pending: 2, entries: 0 });
    expect(pending.sources).toEqual(['evidence']);
  });

  it('folds worktrees into their checkout, including one deleted since', () => {
    const inv = projectInventory(fdb);
    const ids = inv.projects.map((p) => p.id);
    expect(ids).not.toContain(fx.repo.mixedFeature);
    expect(ids).not.toContain(fx.repo.mixedOld);
    const mixed = byId(inv, fx.repo.mixed)!;
    expect(mixed.aliases).toEqual(expect.arrayContaining([fx.repo.mixedFeature, fx.repo.mixedOld]));
    expect(inv.aliases[fx.repo.mixedOld]).toBe(fx.repo.mixed);
    // The deleted worktree's logged concept is still the checkout's.
    expect(mixed.learning.logged_concepts).toBe(4);
    // And the gate row keeps the real checkout path the commit gate matches on.
    const gate = fdb.prepare("SELECT repo FROM gates WHERE session_id = 's-feature'").get() as { repo: string };
    expect(gate.repo).toBe(fx.repo.mixedFeature);
  });

  it('never merges a deleted checkout it cannot prove belongs elsewhere', () => {
    const retired = byId(projectInventory(fdb), fx.repo.retired)!;
    expect(retired).toMatchObject({ kind: 'repo', available: false, name: 'retired' });
    expect(retired.learning.answers).toBe(1);
  });

  it('keeps same-named repositories apart and names them so a person can tell', () => {
    const inv = projectInventory(fdb);
    expect(byId(inv, fx.repo.clientApi)!.name).toBe('client/api');
    expect(byId(inv, fx.repo.serverApi)!.name).toBe('server/api');
  });

  it('keeps the no-repository bucket and the legacy bucket, separately', () => {
    const inv = projectInventory(fdb);
    expect(byId(inv, '*')).toMatchObject({ kind: 'global', name: 'No repository', path: null });
    expect(byId(inv, '~')).toMatchObject({ kind: 'unattributed', name: 'Unattributed', path: null });
    expect(byId(inv, '~')!.learning.answers).toBe(1);
  });

  it('lists each project once, whatever wrote it', () => {
    const ids = projectInventory(fdb).projects.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(10);
  });

  it('attributes a no-repository session by its own answers, and only when they agree', () => {
    // Outside a checkout, the gate stores NULL while the answer stores `*`:
    // without this the session's logged concepts read as Unattributed.
    const gate = fdb.prepare("SELECT repo FROM gates WHERE session_id = 's-outside'").get() as { repo: string | null };
    expect(gate.repo).toBeNull();
    expect(projectInventory(fdb).sessions['s-outside']).toBe('*');

    // A session whose own rows name two projects is not guessed at.
    fdb.prepare("UPDATE gates SET repo = NULL WHERE session_id = 's-client'").run();
    call2(fdb, recordAttempt, { session_id: 's-client', cwd: fx.repo.serverApi, slug: 'csrf', grade: 4, difficulty: 2, question: 'q', answer: 'a' });
    fdb.prepare("UPDATE gates SET repo = NULL WHERE session_id = 's-client'").run();
    const inv = projectInventory(fdb);
    expect(inv.sessions['s-client']).toBeUndefined();
    expect(byId(inv, '~')!.learning.logged_concepts).toBeGreaterThan(0);
  });
});

describe('a logged concept belongs to its project before any question', () => {
  it('traces session_concepts → gates → repo with no attempt at all', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-logged-'));
    const saved = process.env.EKLAVYA_HOME;
    process.env.EKLAVYA_HOME = path.join(home, 'home');
    const repo = path.join(fs.realpathSync(home), 'svc');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    try {
      call2(db, logSessionConcepts, { session_id: 'only-logged', cwd: repo, concepts: [{ slug: 'csrf', context: 'set SameSite' }] });
      expect((db.prepare('SELECT count(*) AS n FROM attempts').get() as { n: number }).n).toBe(0);
      const s = dashboardState(db) as any;
      expect(s.logged.find((l: any) => l.session_id === 'only-logged').repo).toBe(repo);
      const p = projectInventory(db).projects.find((x) => x.id === repo)!;
      expect(p.learning).toMatchObject({ answers: 0, logged_concepts: 1, sessions: 1 });
    } finally {
      if (saved === undefined) delete process.env.EKLAVYA_HOME; else process.env.EKLAVYA_HOME = saved;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('/api/state is unchanged for the page that still reads it', () => {
  it('keeps every key, with its type', () => {
    work();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 2 });
    const s = dashboardState(db) as any;
    const shape = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, Array.isArray(v) ? 'array' : typeof v]));
    expect(shape).toEqual({
      generated_at: 'string', db_path: 'string', cursor: 'string', timeline_days: 'number',
      attempts_shown: 'number', attempts_total: 'number', config: 'object', totals: 'object',
      daily: 'array', projects: 'array', domains: 'array', concepts: 'array', attempts: 'array',
      logged: 'array', memory: 'object', reuse: 'object', health: 'object', memory_sessions: 'array',
      artifacts: 'array',
    });
    expect(Object.keys(s.projects[0]).sort()).toEqual([
      'answers', 'concepts', 'first_active', 'key', 'last_active', 'level', 'level_accuracy', 'level_counts',
      'level_needed', 'level_unmet', 'next_level', 'passed', 'pinned', 'promoted_at', 'repo', 'skipped',
    ]);
    expect(Object.keys(s.logged[0]).sort()).toEqual(['context', 'domain', 'name', 'origin', 'repo', 'session_id', 'slug', 'ts']);
  });
});

describe('the new endpoints', () => {
  it('serve the project inventory and a paged session list over loopback, and refuse a rebound host', async () => {
    remember({ title: 'one', session: 'm-1' });
    remember({ title: 'two', session: 'm-2' });
    const gone = remember({ title: 'three', session: 'm-3' });
    const { url, close } = await startDashboard(db, { port: 0 });
    try {
      const inv = (await (await fetch(`${url}/api/projects`)).json()) as any;
      expect(Object.keys(inv).sort()).toEqual(['aliases', 'projects', 'sessions']);
      const p = inv.projects.find((x: any) => x.id === PROJECT);
      expect(Object.keys(p).sort()).toEqual(['aliases', 'available', 'first_active', 'id', 'kind', 'last_active',
        'learning', 'memory', 'name', 'path', 'sources']);
      expect(p.memory).toMatchObject({ events: 3, entries: 3, sessions: 3 });

      const page = (await (await fetch(`${url}/api/memory/sessions?per=2&page=2`)).json()) as any;
      expect(page).toMatchObject({ total: 3, page: 2, pages: 2, per: 2 });
      expect(page.rows).toHaveLength(1);
      const one = (await (await fetch(`${url}/api/memory/sessions?session=m-2`)).json()) as any;
      expect(one.rows).toEqual([expect.objectContaining({ session_id: 'm-2', project: PROJECT, events: 1, entries: 1 })]);

      // A deleted entry leaves both screens alike: the session list and the inventory count live entries only.
      deleteEntry(db, gone);
      const after = (await (await fetch(`${url}/api/memory/sessions?session=m-3`)).json()) as any;
      expect(after.rows[0]).toMatchObject({ session_id: 'm-3', entries: 0 });
      const inv2 = (await (await fetch(`${url}/api/projects`)).json()) as any;
      expect(inv2.projects.find((x: any) => x.id === PROJECT).memory.entries).toBe(2);

      for (const route of ['/api/projects', '/api/memory/sessions']) {
        const res = await new Promise<number>((resolve) => {
          const u = new URL(url + route);
          http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: { host: 'evil.example:80' } },
            (r) => { r.resume(); resolve(r.statusCode ?? 0); });
        });
        expect(res, route).toBe(403);
      }
    } finally {
      close();
    }
  });

  it('serves the shared tokens with the remote font import stripped', async () => {
    const css = "@import url('https://fonts.googleapis.com/css2?family=Inter&display=swap');\n:root { --a: 1; }";
    expect(localTokens(css)).toBe(':root { --a: 1; }');
    const { url, close } = await startBuilt(db as any, { port: 0 });
    try {
      const served = await (await fetch(`${url}/tokens.css`)).text();
      expect(served).not.toMatch(/fonts\.googleapis|@import url\(\s*['"]?https?:/);
      expect(served).toContain('--font-body');
    } finally {
      close();
    }
  });
});

describe('search takes the box literally', () => {
  // The escape was there and the `ESCAPE '\'` clause was not, so SQLite read
  // `\%` as a backslash followed by a wildcard, and any search containing `%`,
  // `_` or `\` found nothing at all.
  const titles = (q: string) => ((memoryPage(db, { q, per: 50 }) as any).rows as any[]).map((r) => r.title).sort();

  beforeEach(() => {
    remember({ title: '100% done', narrative: 'n' });
    remember({ title: 'snake_case rename', narrative: 'n' });
    remember({ title: 'snakeXcase rename', narrative: 'n' });
    remember({ title: 'C:\\Users\\path fix', narrative: 'n' });
    remember({ title: '100 things', narrative: 'n' });
  });

  it('a percent sign is a percent sign', () => {
    expect(titles('100%')).toEqual(['100% done']);
  });

  it('an underscore matches an underscore, not any character', () => {
    expect(titles('_')).toEqual(['snake_case rename']);
    expect(titles('snake_case')).toEqual(['snake_case rename']);
  });

  it('a backslash is a backslash', () => {
    expect(titles('\\')).toEqual(['C:\\Users\\path fix']);
    expect(titles('C:\\Users')).toEqual(['C:\\Users\\path fix']);
  });
});

describe('the server says what a browser may do with its pages', () => {
  /** Raw `http.request`, so any method can be sent and every header read. */
  const request = (port: number, method: string, pathName: string) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: pathName, method }, (res) => {
        let body = '';
        res.on('data', (c) => (body += String(c)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });

  const ROUTES = ['/', '/tokens.css', '/api/state', '/api/projects', '/api/memory', '/api/memory/sessions', '/api/memory/entry?id=1', '/api/settings', '/nope'];

  it('sends the security headers on every response, errors included', async () => {
    const { url, close } = await startBuilt(db, { port: 0 });
    const port = Number(new URL(url).port);
    try {
      for (const route of ROUTES) {
        const { headers } = await request(port, 'GET', route);
        expect(headers['x-content-type-options'], route).toBe('nosniff');
        expect(headers['x-frame-options'], route).toBe('DENY');
        expect(headers['referrer-policy'], route).toBe('no-referrer');
        const csp = String(headers['content-security-policy']);
        expect(csp, route).toContain("default-src 'self'");
        expect(csp, route).toContain("frame-ancestors 'none'");
        expect(csp, route).toContain("connect-src 'self'");
        expect(csp, route).toContain("img-src 'self' data:");
      }
    } finally {
      close();
    }
  });

  it('answers 405 to anything but GET and HEAD, and still serves those', async () => {
    const { url, close } = await startBuilt(db, { port: 0 });
    const port = Number(new URL(url).port);
    try {
      for (const route of ['/', '/api/state', '/api/memory']) {
        expect((await request(port, 'GET', route)).status, route).toBe(200);
        const head = await request(port, 'HEAD', route);
        expect(head.status, route).toBe(200);
        expect(head.body, route).toBe('');
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
          const res = await request(port, method, route);
          expect(res.status, `${method} ${route}`).toBe(405);
          expect(res.headers.allow, `${method} ${route}`).toBe('GET, HEAD');
          expect(res.headers['x-frame-options']).toBe('DENY');
        }
      }
      // The one writable route still refuses every other write method.
      const put = await request(port, 'PUT', '/api/settings');
      expect(put.status).toBe(405);
      expect(put.headers.allow).toBe('GET, HEAD, POST');
    } finally {
      close();
    }
  });
});

/* ------------------------------------------------------------------
   Settings: the one route that writes.
   ------------------------------------------------------------------ */
describe('every config key has a home in the dashboard or the terminal', () => {
  it('lists each leaf key in SETTINGS or CLI_ONLY, and nothing else', () => {
    // A new key in DEFAULT_CONFIG fails here until it is placed on one list:
    // that is what keeps the CLI and the dashboard describing one config.
    const leaves = knownKeys().filter((k) => {
      const d = defaultAt(k);
      return !(d && typeof d === 'object' && !Array.isArray(d));
    });
    const placed = [...SETTINGS.map((f) => f.key), ...CLI_ONLY.map((c) => c.key)];
    expect([...placed].sort()).toEqual([...leaves].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });
});

describe('/api/settings', () => {
  let home = '';
  let repo = '';
  const saved = process.env.EKLAVYA_HOME;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-set-home-'));
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-set-repo-')));
    fs.mkdirSync(path.join(repo, '.git'));
    process.env.EKLAVYA_HOME = home;
    appendEvent(db, { eventUid: 'set-1', project: repo, sessionId: 's1', kind: 'tool_use', tool: 'Edit', title: 't', body: 'b' });
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.EKLAVYA_HOME;
    else process.env.EKLAVYA_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const post = (port: number, body: unknown, headers: Record<string, string>) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/settings', method: 'POST', headers }, (res) => {
        let text = '';
        res.on('data', (c) => (text += String(c)));
        res.on('end', () => {
          let parsed: any = text;
          try { parsed = JSON.parse(text); } catch { /* the loopback refusal is plain text */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      });
      req.on('error', reject);
      req.end(typeof body === 'string' ? body : JSON.stringify(body));
    });

  async function withServer(fn: (port: number, token: string, url: string) => Promise<void>) {
    const { url, close } = await startBuilt(db, { port: 0 });
    try {
      const html = await (await fetch(url)).text();
      const token = /name="eklavya-token" content="([0-9a-f]+)"/.exec(html)?.[1] ?? '';
      expect(token).toMatch(/^[0-9a-f]{48}$/);
      await fn(Number(new URL(url).port), token, url);
    } finally {
      close();
    }
  }
  const ok = (port: number, token: string) => ({
    host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json', 'x-eklavya-token': token,
  });

  it('reads both scopes and offers only projects with a checkout', async () => {
    await withServer(async (_port, _token, url) => {
      const d = await (await fetch(`${url}/api/settings?project=${encodeURIComponent(repo)}`)).json();
      expect(d.projects.map((p: any) => p.id)).toEqual([repo]);
      expect(d.project.id).toBe(repo);
      expect(d.user.effective['cadence']).toBe('interleaved');
      expect(d.global_only).toEqual(expect.arrayContaining(['telemetry', 'auto_update']));
    });
  });

  it('writes a user setting and a project one, and unsets back to inherit', async () => {
    await withServer(async (port, token, url) => {
      const h = ok(port, token);
      expect((await post(port, { scope: 'user', key: 'cadence', value: 'end' }, h)).status).toBe(200);
      const userFile = path.join(home, 'config.json');
      expect(JSON.parse(fs.readFileSync(userFile, 'utf8')).cadence).toBe('end');

      expect((await post(port, { scope: 'project', project: repo, key: 'memory.capture', value: 'minimal' }, h)).status).toBe(200);
      expect((await post(port, { scope: 'project', project: repo, key: 'cadence', value: 'interleaved' }, h)).status).toBe(200);
      let d = await (await fetch(`${url}/api/settings?project=${encodeURIComponent(repo)}`)).json();
      expect(d.project.set).toEqual({ 'memory.capture': 'minimal', cadence: 'interleaved' });
      expect(d.project.effective.cadence).toBe('interleaved');

      // A second write keeps the previous bytes beside the file.
      expect(fs.existsSync(`${d.project.path}.eklavya-bak`)).toBe(true);

      expect((await post(port, { scope: 'project', project: repo, key: 'cadence', unset: true }, h)).status).toBe(200);
      d = await (await fetch(`${url}/api/settings?project=${encodeURIComponent(repo)}`)).json();
      expect(d.project.set).toEqual({ 'memory.capture': 'minimal' });
      expect(d.project.effective.cadence).toBe('end'); // the user setting applies again
    });
  });

  it('refuses a write without the token, from another origin, or as a form', async () => {
    await withServer(async (port, token) => {
      const body = { scope: 'user', key: 'cadence', value: 'end' };
      expect((await post(port, body, { ...ok(port, token), 'x-eklavya-token': '' })).status).toBe(403);
      expect((await post(port, body, { ...ok(port, token), 'x-eklavya-token': 'f'.repeat(48) })).status).toBe(403);
      expect((await post(port, body, { ...ok(port, token), origin: 'https://evil.example' })).status).toBe(403);
      expect((await post(port, body, { ...ok(port, token), origin: 'null' })).status).toBe(403);
      const { origin: _o, ...noOrigin } = ok(port, token);
      expect((await post(port, body, noOrigin)).status).toBe(403);
      expect((await post(port, body, { ...ok(port, token), host: 'evil.example' })).status).toBe(403);
      expect((await post(port, 'cadence=end', { ...ok(port, token), 'content-type': 'application/x-www-form-urlencoded' })).status).toBe(415);
      expect((await post(port, 'x'.repeat(20000), ok(port, token))).status).toBe(413);
      expect(fs.existsSync(path.join(home, 'config.json'))).toBe(false);
    });
  });

  it('refuses unknown, terminal-only, global-only-for-a-project and out-of-range writes', async () => {
    await withServer(async (port, token) => {
      const h = ok(port, token);
      const bad = async (body: unknown) => {
        const r = await post(port, body, h);
        expect(r.status, JSON.stringify(body)).toBe(400);
        expect(typeof r.body.error).toBe('string');
      };
      await bad({ scope: 'user', key: 'nope', value: 1 });
      await bad({ scope: 'user', key: 'sync.enabled', value: true });
      await bad({ scope: 'project', project: repo, key: 'telemetry', value: false });
      await bad({ scope: 'project', project: '/etc', key: 'cadence', value: 'end' });
      await bad({ scope: 'user', key: 'cadence', value: 'bogus' });
      await bad({ scope: 'user', key: 'max_questions_per_task', value: 99 });
      await bad({ scope: 'user', key: 'focus', value: 'learn' }); // no topic yet
      await bad({ scope: 'global', key: 'cadence', value: 'end' });
      expect(fs.existsSync(path.join(home, 'config.json'))).toBe(false);
      expect(fs.existsSync(path.join(home, 'projects'))).toBe(false);
    });
  });

  it('refuses each kind of bad value in the words the CLI uses', async () => {
    await withServer(async (port, token) => {
      const h = ok(port, token);
      const cases: [string, unknown][] = [
        ['quiet', 'yes'],
        ['difficulty', 'impossible'],
        ['max_questions_per_task', 2.5],
        ['min_minutes_between_quizzes', 5000],
        ['level_up_accuracy', -0.1],
        ['memory.retention_days', 0],
        ['level_up_after', null],
        ['focus_topic', 'x'.repeat(201)],
        ['privacy.redact_patterns', ['(unclosed']],
        ['domains_enabled', 'react'],
      ];
      for (const [key, value] of cases) {
        const r = await post(port, { scope: 'user', key, value }, h);
        expect(r.status, key).toBe(400);
        expect(r.body.error, key).toBe(settingProblem(key, value));
      }
      await post(port, { scope: 'user', key: 'quiz.enabled', value: false }, h);
      const gate = await post(port, { scope: 'user', key: 'quiz.enforced', value: true }, h);
      expect(gate.body.error).toMatch(/no effect while quiz.enabled is false/);
      expect(JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'))).toEqual({ quiz: { enabled: false } });
    });
  });

  it('ships each field\'s bounds from SETTING_RULES, so the page checks what the server checks', async () => {
    await withServer(async (_port, _token, url) => {
      const d = await (await fetch(`${url}/api/settings`)).json();
      for (const f of d.fields) {
        const { type, options, min, max, int, nullable, maxLength, maxItems, regex } = f;
        expect(JSON.parse(JSON.stringify({ type, options, min, max, int, nullable, maxLength, maxItems, regex })), f.key)
          .toEqual(JSON.parse(JSON.stringify(SETTING_RULES[f.key])));
      }
    });
  });
});
