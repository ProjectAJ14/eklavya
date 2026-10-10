/**
 * The dashboard's cheaper reads (issue #171, Phase 6) answer what the queries
 * they replaced answered, value for value and in the same order.
 *
 * Each rewritten read is run beside the SQL it replaced, copied here from the
 * commit before the rewrite (`legacy*`), over the dashboard fixture plus the
 * rows that make a rewrite differ if it is wrong: equal timestamps (which a
 * sort leaves to chance unless the order is spelled out), a session captured
 * from two checkouts, a session two projects share, entries without evidence,
 * evidence without entries, corrections, blank repositories and contexts.
 * A second block opens a session whose rows the payload cut, through the
 * resource the page uses for it.
 *
 * Every case pins EKLAVYA_HOME, so no real config is read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { dashboardState, memorySessionPage, projectInventory, startDashboard, LOGGED_LIMIT } from '../src/dashboard.js';
import { conceptBySlug, projectKey } from '../src/store.js';
import { seedFixture, type Fixture } from './dashboard-fixture.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let tmp = '';
let fx: Fixture;
const saved = process.env.EKLAVYA_HOME;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-dash-queries-')));
  process.env.EKLAVYA_HOME = path.join(tmp, 'home');
  dbFile = tempDbPath('dashboard-queries');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  if (saved === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = saved;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const all = <T = any>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...args) as T[];
const run = (sql: string, ...args: unknown[]) => db.prepare(sql).run(...args);
const idOf = (slug: string): number => conceptBySlug(db, slug)!.id;

/** An ISO time on a fixed day, so a case reads the same whenever it runs. */
const at = (hhmm: string, day = '2026-03-02') => `${day}T${hhmm}:00.000Z`;

const evidence = (project: string, checkout: string | null, session: string, when: string, opts: {
  status?: string; redacted?: number; received?: string; uid?: string;
} = {}) =>
  run(
    `INSERT INTO evidence_events (event_uid, project, checkout, session_id, kind, tool, title, body, occurred_at, received_at, redacted, status)
     VALUES (?, ?, ?, ?, 'tool_use', 'Edit', 't', 'b', ?, ?, ?, ?)`,
    opts.uid ?? `q-${session}-${project}-${checkout}-${when}-${Math.random()}`, project, checkout, session, when,
    opts.received ?? '2026-03-02 12:00:00', opts.redacted ?? 0, opts.status ?? 'accepted',
  );

const entry = (project: string, session: string | null, when: string, opts: { deleted?: boolean; supersededBy?: number } = {}): number =>
  Number(
    run(
      `INSERT INTO memory_entries (entry_uid, project, session_id, kind, title, occurred_at, deleted_at, superseded_by)
       VALUES (?, ?, ?, 'observation', 't', ?, ?, ?)`,
      `e-${Math.random()}`, project, session, when, opts.deleted ? '2026-03-03T00:00:00.000Z' : null, opts.supersededBy ?? null,
    ).lastInsertRowid,
  );

const candidate = (entryId: number, project: string) =>
  run(`INSERT INTO learning_sources (entry_id, slug, name, domain, confidence, status, project) VALUES (?, 'x', 'X', 'd', 0.5, 'candidate', ?)`, entryId, project);

const answer = (slug: string, session: string | null, ts: string, opts: { repo?: string | null; grade?: number; outcome?: string; retryOf?: number } = {}): number =>
  Number(
    run(
      `INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, ts, repo, outcome, retry_of)
       VALUES (?, ?, 'q', 'a', ?, 2, ?, ?, ?, ?)`,
      idOf(slug), session, opts.grade ?? 4, ts, opts.repo === undefined ? null : opts.repo, opts.outcome ?? 'answered', opts.retryOf ?? null,
    ).lastInsertRowid,
  );

const logged = (slug: string, session: string, ts: string, context: string | null, origin: string | null = 'work') =>
  run('INSERT INTO session_concepts (session_id, concept_id, context, ts, origin) VALUES (?, ?, ?, ?, ?)', session, idOf(slug), context, ts, origin);

/** The fixture, then every shape a rewritten read could get wrong. */
function seedExtras() {
  const A = fx.repo.mixed;
  const B = fx.repo.answered;
  const gone = path.join(fx.root, 'gone-checkout');

  // Two sessions that stopped at the same instant, one of them also captured under a second project:
  // the order of equal times is session id, then project.
  for (const [project, session] of [[A, 'tie-b'], [A, 'tie-a'], [B, 'tie-a']] as const) evidence(project, project, session, at('09:00'));
  // One session captured from three checkouts (none, the project, a worktree): one row, the sum, the widest span.
  evidence(A, null, 'multi', at('10:00'), { received: '2026-03-02 10:00:00' });
  evidence(A, null, 'multi', at('10:30'), { redacted: 1, status: 'summarized', received: '2026-03-02 10:30:00' });
  evidence(A, A, 'multi', at('09:00'), { received: '2026-03-02 09:00:00' });
  evidence(A, A, 'multi', at('10:15'), { status: 'batched', received: '2026-03-02 09:15:00' });
  evidence(A, `${A}-feature`, 'multi', at('12:00'), { received: '2026-03-02 12:00:00' });
  evidence(A, `${A}-feature`, 'multi', at('12:30'), { redacted: 1, received: '2026-03-02 12:30:00' });
  // Evidence and entries disagree about which came first and last, both ways.
  evidence(A, A, 'both-1', at('10:00'));
  evidence(A, A, 'both-1', at('10:10'));
  entry(A, 'both-1', at('09:00'));
  entry(A, 'both-1', at('11:00'));
  evidence(A, A, 'both-2', at('09:00'));
  evidence(A, A, 'both-2', at('12:00'));
  entry(A, 'both-2', at('10:00'));
  // Entries with no evidence, one of them deleted and one superseded; an entry with no session at all.
  const live = entry(A, 'entries-only', at('08:00'));
  entry(A, 'entries-only', at('08:30'), { deleted: true });
  entry(A, 'entries-only', at('08:45'), { supersededBy: live });
  candidate(live, A);
  candidate(live, A);
  entry(A, null, at('08:00'));
  // A session two projects both remembered, and a project whose checkout is gone.
  entry(B, 'entries-only', at('07:00'));
  evidence(gone, gone, 'gone-s', at('06:00'));
  // A host whose clock ran ahead: the newest event is not the newest thing received.
  evidence(A, A, 'skewed', '2099-01-01T00:00:00.000Z', { received: '2026-03-02 12:00:00' });
  // A session's entries are counted by session alone in the payload list and by project in the paged one,
  // and the payload list counts the deleted ones too.
  entry(A, 'both-1', at('09:30'), { deleted: true });
  const other = entry(B, 'both-1', at('09:45'));
  candidate(other, B);
  // Evidence alone, spread over three sessions, for the counts.
  for (const [i, session] of ['solo-1', 'solo-2', 'solo-3'].entries()) evidence(B, B, session, at(`0${i + 1}:00`, '2026-03-01'), { status: 'summarized' });

  // Answers: blank and unset repositories newer than a real one, declines, a correction, a tie on time.
  const first = answer('cors-basics', 'q-1', '2026-02-01 10:00:00', { repo: B, grade: 1 });
  // A correction stamped before every answer it corrects: it is no answer, and must not be the first one asked.
  answer('cors-basics', 'q-1', '2026-01-15 10:00:00', { repo: B, grade: 4, retryOf: answer('cors-basics', 'q-1', '2026-02-01 11:00:00', { repo: B, grade: 0 }) });
  answer('cors-basics', 'q-1', '2026-02-02 10:00:00', { repo: '   ', grade: 4 });
  answer('cors-basics', 'q-2', '2026-02-03 10:00:00', { repo: null, outcome: 'declined', grade: 1 });
  answer('cors-basics', 'q-2', '2026-02-04 10:00:00', { repo: '', outcome: 'dont_know', grade: 0 });
  answer('cors-basics', 'q-2', '2026-02-05 10:00:00', { repo: A, grade: 5, retryOf: first });
  answer('git-stash', null, '2026-02-06 10:00:00', { repo: null, grade: 2 });
  answer('git-stash', null, '2026-02-06 10:00:00', { repo: null, grade: 5 });
  // The newest answer of a concept names no usable repository: the last real one is the concept's.
  answer('git-stash', null, '2026-02-05 10:00:00', { repo: B, grade: 3 });
  answer('git-stash', null, '2026-02-07 10:00:00', { repo: '  ', grade: 3 });
  // Logged lines: equal times (the row written first wins), a newer line with no context, an older empty one.
  logged('jwt-structure', 'tie-s1', '2026-02-10 09:00:00', 'first written');
  logged('jwt-structure', 'tie-s2', '2026-02-10 09:00:00', 'second written');
  logged('jwt-structure', 'tie-s3', '2026-02-11 09:00:00', null);
  logged('jwt-structure', 'tie-s4', '2026-02-09 09:00:00', '');
  logged('key-rotation-jwks', 'tie-s5', '2026-02-12 09:00:00', null, null);
  logged('key-rotation-jwks', 'tie-s6', '2026-02-12 09:00:00', 'review line', 'review');
  // Two concepts that are the same to the catalogue's ordering.
  for (const slug of ['twin-b', 'twin-a']) {
    run("INSERT INTO concepts (slug, name, domain, tier) VALUES (?, 'Twin', 'zz-twins', 1)", slug);
  }
  run("INSERT INTO gates (session_id, mode, repo) VALUES ('tie-s1', 'ambient', ?)", A);
  run("INSERT INTO gates (session_id, mode, repo) VALUES ('tie-s2', 'ambient', ?)", A);
  run("INSERT INTO gates (session_id, mode, repo) VALUES ('tie-s6', 'ambient', NULL)");
}

// ---------------------------------------------------------------------------
// The statements the rewrites replaced, verbatim from the commit before them.

const legacyConcepts = () =>
  all(`SELECT c.id, c.slug, c.name, c.domain, c.description, c.tier, c.source,
              m.score, m.ease, m.interval_d, m.reps, m.next_review, m.last_seen,
              (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id AND a.retry_of IS NULL) AS attempts,
              (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id AND a.retry_of IS NULL AND a.grade >= 3) AS passed,
              (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id AND a.retry_of IS NULL
                AND a.outcome IN ('declined','dont_know')) AS skipped,
              (SELECT count(*) FROM attempts a WHERE a.concept_id = c.id AND a.retry_of IS NOT NULL) AS corrected,
              (SELECT min(a.ts) FROM attempts a WHERE a.concept_id = c.id AND a.retry_of IS NULL) AS first_asked,
              (SELECT a.grade FROM attempts a WHERE a.concept_id = c.id AND a.retry_of IS NULL ORDER BY a.id DESC LIMIT 1) AS last_grade,
              (SELECT sc.context FROM session_concepts sc
                WHERE sc.concept_id = c.id AND sc.context IS NOT NULL
                ORDER BY sc.ts DESC LIMIT 1) AS last_context,
              (SELECT a.repo FROM attempts a
                WHERE a.concept_id = c.id AND a.repo IS NOT NULL AND trim(a.repo) <> ''
                ORDER BY a.id DESC LIMIT 1) AS last_repo
       FROM concepts c
       LEFT JOIN mastery m ON m.concept_id = c.id
       ORDER BY c.domain, c.tier, c.name`);

const legacyAttempts = () =>
  all(
    `SELECT a.id, c.slug, c.name, c.domain, a.session_id, a.question, a.answer, a.feedback,
            a.grade, a.difficulty AS tier, a.outcome, a.format, a.options, a.ts,
            NULLIF(trim(COALESCE(a.repo, '')), '') AS repo, a.level,
            fix.ts AS corrected_at,
            CASE WHEN fix.id IS NULL THEN NULL
                 ELSE (SELECT count(*) FROM attempt_retries r WHERE r.attempt_id = a.id) END AS corrected_try
     FROM attempts a JOIN concepts c ON c.id = a.concept_id
     LEFT JOIN attempts fix ON fix.retry_of = a.id
     WHERE a.retry_of IS NULL
     ORDER BY a.id DESC
     LIMIT ?`,
    2000,
  );

const legacyLogged = () =>
  all(
    `SELECT sc.session_id, c.slug, c.name, c.domain, sc.context, sc.ts, sc.origin,
            NULLIF(trim(COALESCE(g.repo, '')), '') AS repo
     FROM session_concepts sc
     JOIN concepts c ON c.id = sc.concept_id
     LEFT JOIN gates g ON g.session_id = sc.session_id
     ORDER BY sc.ts DESC`,
  ).map((row) => ({ ...row, repo: row.repo ? projectKey(row.repo) : null }));

const legacyMemorySessions = () =>
  all(
    `SELECT e.session_id, e.project, count(*) AS events,
            COALESCE(SUM(e.redacted), 0) AS redacted,
            min(e.occurred_at) AS first, max(e.occurred_at) AS last,
            (SELECT count(*) FROM memory_entries m WHERE m.session_id = e.session_id) AS entries,
            (SELECT count(*) FROM learning_sources ls JOIN memory_entries m ON m.id = ls.entry_id
              WHERE m.session_id = e.session_id) AS candidates
     FROM evidence_events e
     GROUP BY e.session_id, e.project
     ORDER BY last DESC LIMIT ?`,
    500,
  );

const legacyEvidenceCounts = () => ({
  events: db
    .prepare(
      `SELECT count(*) AS captured,
              COALESCE(SUM(status = 'summarized'), 0) AS processed,
              COALESCE(SUM(status <> 'summarized'), 0) AS pending,
              COALESCE(SUM(redacted), 0) AS redacted,
              max(occurred_at) AS newest
       FROM evidence_events`,
    )
    .get() as any,
  beat: db.prepare('SELECT max(occurred_at) AS newest, max(received_at) AS received FROM evidence_events').get() as any,
});

function legacySessionPage(q: { project?: string | null; session?: string | null; page?: number; per?: number } = {}) {
  const per = Math.min(200, Math.max(1, Math.floor(q.per || 25)));
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.project) { where.push('project = ?'); args.push(q.project); }
  if (q.session) { where.push('session_id = ?'); args.push(q.session); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const union = `
    SELECT session_id, project, count(*) AS events, COALESCE(SUM(redacted), 0) AS redacted,
           COALESCE(SUM(status <> 'summarized'), 0) AS pending, min(occurred_at) AS first, max(occurred_at) AS last
    FROM evidence_events GROUP BY session_id, project
    UNION ALL
    SELECT session_id, project, 0, 0, 0, min(occurred_at), max(occurred_at)
    FROM memory_entries WHERE session_id IS NOT NULL GROUP BY session_id, project`;
  const total = (db.prepare(`SELECT count(*) AS n FROM (SELECT session_id, project FROM (${union}) ${clause} GROUP BY session_id, project)`).get(...args) as any).n;
  const pages = Math.max(1, Math.ceil(total / per));
  const p = Math.min(Math.max(1, Math.floor(q.page || 1)), pages);
  const rows = db
    .prepare(
      `SELECT s.session_id, s.project, SUM(s.events) AS events, SUM(s.redacted) AS redacted, SUM(s.pending) AS pending,
              min(s.first) AS first, max(s.last) AS last,
              (SELECT count(*) FROM memory_entries m WHERE m.session_id = s.session_id AND m.project = s.project
                AND m.deleted_at IS NULL AND m.superseded_by IS NULL) AS entries,
              (SELECT count(*) FROM learning_sources ls JOIN memory_entries m ON m.id = ls.entry_id
                WHERE m.session_id = s.session_id AND m.project = s.project) AS candidates
       FROM (${union}) s ${clause}
       GROUP BY s.session_id, s.project ORDER BY last DESC LIMIT ? OFFSET ?`,
    )
    .all(...args, per, (p - 1) * per);
  return { total, page: p, pages, per, rows };
}

const withoutLearning = (page: Record<string, unknown>) => {
  const { learning, ...rest } = page;
  return rest;
};

// ---------------------------------------------------------------------------

describe.each([
  ['the fixture alone', false],
  ['the fixture and the rows that tell a wrong rewrite apart', true],
])('over %s', (_name, extras) => {
  beforeEach(() => {
    fx = seedFixture(db, path.join(tmp, 'fx'));
    if (extras) seedExtras();
  });

  it('keeps every concept row of the catalogue: its counts, its last context and repository, and its order', () => {
    const state = dashboardState(db) as any;
    const legacy = legacyConcepts();
    expect(state.concepts.map((c: any) => c.slug)).toEqual(legacy.map((r: any) => r.slug));
    expect(state.concepts.map((c: any) => ({
      slug: c.slug, attempts: c.attempts, passed: c.passed, skipped: c.skipped, corrected: c.corrected,
      first_asked: c.first_asked, last_grade: c.last_grade, last_context: c.context, last_repo: c.repo,
    }))).toEqual(legacy.map((r: any) => ({
      slug: r.slug, attempts: r.attempts, passed: r.passed, skipped: r.skipped, corrected: r.corrected,
      first_asked: r.first_asked, last_grade: r.last_grade, last_context: r.last_context, last_repo: r.last_repo,
    })));
  });

  it('keeps the answers and the logged lines the payload ships, row for row', () => {
    const state = dashboardState(db) as any;
    expect(state.attempts).toEqual(legacyAttempts());
    // Nothing here exceeds the cap, so the capped list is the whole of what it replaced.
    const everything = legacyLogged();
    expect(everything.length).toBeLessThan(LOGGED_LIMIT);
    expect(state.logged).toEqual(everything);
    expect(state).toMatchObject({ logged_shown: everything.length, logged_total: everything.length });
  });

  it('keeps the memory counts and the capture heartbeat, read once from evidence_events', () => {
    const state = dashboardState(db) as any;
    const { events, beat } = legacyEvidenceCounts();
    expect(state.memory).toMatchObject({
      captured: events.captured, processed: events.processed, pending: events.pending,
      redacted: events.redacted, newest_event: events.newest,
    });
    expect(state.health.capture).toMatchObject({ newest_event: beat.newest, newest_received: beat.received });
  });

  it('keeps the payload list of sessions that captured evidence: rows, counts, and the order of equal times', () => {
    expect((dashboardState(db) as any).memory_sessions).toEqual(legacyMemorySessions());
  });

  it('pages the sessions of both halves exactly as the union it replaced did', () => {
    const projects: (string | undefined)[] = [undefined, ...new Set(all<{ project: string }>('SELECT project FROM memory_entries UNION SELECT project FROM evidence_events').map((r) => r.project)), '/no/such/project'];
    const sessions = [undefined, ...new Set(all<{ s: string }>('SELECT session_id AS s FROM evidence_events UNION SELECT session_id FROM memory_entries WHERE session_id IS NOT NULL').map((r) => r.s)), 'no-such-session'];
    const queries: { project?: string; session?: string; page?: number; per?: number }[] = [];
    for (const project of projects) for (const per of [undefined, 1, 2, 3, 7, 500, 0, -4]) for (const page of [undefined, 1, 2, 3, 4, 99, 0, -1, 2.9]) queries.push({ project, per, page });
    for (const session of sessions) for (const project of [undefined, ...projects.slice(1, 3)]) queries.push({ session, project });
    expect(queries.length).toBeGreaterThan(200);
    for (const q of queries) expect(withoutLearning(memorySessionPage(db, q)), JSON.stringify(q)).toEqual(legacySessionPage(q));
  });

  it('still derives the project inventory from the same evidence: events, pending, sessions and span', () => {
    // The inventory's totals per project read straight off the table, folded the way it folds.
    const inv = projectInventory(db);
    const total = (p: string) => inv.projects.filter((x) => x.id === p).reduce((n, x) => n + x.memory.events, 0);
    const raw = (project: string) => all<{ n: number }>('SELECT count(*) AS n FROM evidence_events WHERE project = ?', project)[0]!.n;
    for (const p of [fx.repo.mixed, fx.repo.memoryOnly, fx.repo.pending]) expect(total(p), p).toBe(raw(p));
    const mixed = inv.projects.find((p) => p.id === fx.repo.mixed)!;
    expect(mixed.memory.pending).toBe(all<{ n: number }>("SELECT count(*) AS n FROM evidence_events WHERE project = ? AND status <> 'summarized'", fx.repo.mixed)[0]!.n);
    expect(mixed.memory.sessions).toBe(new Set(all<{ s: string }>('SELECT session_id AS s FROM evidence_events WHERE project = ?', fx.repo.mixed).map((r) => r.s)
      .concat(all<{ s: string }>('SELECT session_id AS s FROM memory_entries WHERE project = ? AND session_id IS NOT NULL', fx.repo.mixed).map((r) => r.s))).size);
  });
});

describe('a session captured from several checkouts', () => {
  it('is one row of the session list, with the sum of its events and the widest span', () => {
    fx = seedFixture(db, path.join(tmp, 'fx'));
    seedExtras();
    const rows = (dashboardState(db) as any).memory_sessions.filter((r: any) => r.session_id === 'multi');
    expect(rows).toEqual([{
      session_id: 'multi', project: fx.repo.mixed, events: 6, redacted: 2, first: at('09:00'), last: at('12:30'), entries: 0, candidates: 0,
    }]);
  });
});

describe('a database with no evidence at all', () => {
  it('reports no capture, no newest event and an empty session list', () => {
    const state = dashboardState(db) as any;
    expect(state.memory).toMatchObject({ captured: 0, processed: 0, pending: 0, redacted: 0, newest_event: null });
    expect(state.health.capture).toMatchObject({ newest_event: null, newest_received: null });
    expect(state.memory_sessions).toEqual([]);
    expect(withoutLearning(memorySessionPage(db))).toEqual(legacySessionPage());
    expect(projectInventory(db).projects).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('the session lookup answers for the learning half, however old the rows', () => {
  const NEW = '2030-01-01 00:00:00';
  /** More lines and answers than either cap holds, all newer than the session under test. */
  function crowd() {
    const insertLine = db.prepare('INSERT INTO session_concepts (session_id, concept_id, context, ts, origin) VALUES (?, ?, ?, ?, ?)');
    const insertAnswer = db.prepare('INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, ts, repo) VALUES (?, ?, ?, ?, ?, 2, ?, ?)');
    const csrf = idOf('csrf');
    db.transaction(() => {
      for (let i = 0; i < LOGGED_LIMIT + 5; i++) insertLine.run(`crowd-${i}`, csrf, 'recent', NEW, 'work');
      for (let i = 0; i < 2005; i++) insertAnswer.run(csrf, `crowd-${i}`, 'recent?', 'a', 4, NEW, null);
    })();
  }

  beforeEach(() => {
    fx = seedFixture(db, path.join(tmp, 'fx'));
  });

  it('opens a session that logged and was asked but captured nothing, which no memory table lists', () => {
    logged('csrf', 'learn-only', '2020-01-01 10:00:00', 'chose SameSite=Lax');
    logged('jwt-structure', 'learn-only', '2020-01-01 10:05:00', 'signed the token', 'review');
    const missed = answer('csrf', 'learn-only', '2020-01-01 10:10:00', { repo: fx.repo.mixed, grade: 2 });
    // The pick made later from the explainer is no question asked: not a row, and not in the total.
    answer('csrf', 'learn-only', '2020-01-02 10:10:00', { repo: fx.repo.mixed, grade: 4, retryOf: missed });
    const page = memorySessionPage(db, { session: 'learn-only' }) as any;
    // The memory half is empty, as it always was, and the learning half is there.
    expect(page).toMatchObject({ total: 0, page: 1, pages: 1, rows: [] });
    expect(page.learning.logged.map((l: any) => [l.slug, l.context, l.origin, l.session_id])).toEqual([
      ['jwt-structure', 'signed the token', 'review', 'learn-only'],
      ['csrf', 'chose SameSite=Lax', 'work', 'learn-only'],
    ]);
    expect(page.learning.attempts).toHaveLength(1);
    expect(page.learning.attempts[0]).toMatchObject({ slug: 'csrf', session_id: 'learn-only', grade: 2, repo: fx.repo.mixed });
    expect(page.learning.attempts_total).toBe(1);
  });

  it('opens a session whose rows fell outside both caps, which the payload no longer carries', () => {
    logged('csrf', 'ancient', '2019-05-01 08:00:00', 'the first line');
    logged('jwt-structure', 'ancient', '2019-05-01 08:30:00', 'the second line');
    for (let i = 0; i < 3; i++) answer('csrf', 'ancient', `2019-05-01 09:0${i}:00`, { grade: i });
    crowd();

    const state = dashboardState(db) as any;
    expect(state.logged).toHaveLength(LOGGED_LIMIT);
    expect(state.attempts_shown).toBe(2000);
    expect(state.logged.some((l: any) => l.session_id === 'ancient')).toBe(false);
    expect(state.attempts.some((a: any) => a.session_id === 'ancient')).toBe(false);

    const { learning } = memorySessionPage(db, { session: 'ancient' }) as any;
    expect(learning.logged.map((l: any) => l.context)).toEqual(['the second line', 'the first line']);
    expect(learning.attempts.map((a: any) => a.grade)).toEqual([2, 1, 0]);
    expect(learning.attempts_total).toBe(3);
  });

  it('opens a session that the cut runs through, with every line it logged', () => {
    // Two lines in the payload (newest), one outside it: the page must not draw it from the payload's two.
    logged('csrf', 'straddle', '2031-01-01 00:00:00', 'newest');
    logged('jwt-structure', 'straddle', '2030-06-01 00:00:00', 'newer');
    crowd();
    logged('git-rebase', 'straddle', '2018-01-01 00:00:00', 'oldest');
    const shown = (dashboardState(db) as any).logged.filter((l: any) => l.session_id === 'straddle');
    expect(shown.map((l: any) => l.context)).toEqual(['newest', 'newer']);
    const { learning } = memorySessionPage(db, { session: 'straddle' }) as any;
    expect(learning.logged.map((l: any) => l.context)).toEqual(['newest', 'newer', 'oldest']);
  });

  it('caps one session\'s answers like every answers list, and says how many there are', () => {
    crowd();
    const { learning } = memorySessionPage(db, { session: 'crowd-1' }) as any;
    expect(learning.attempts).toHaveLength(1);
    // A session that asked more than the cap: newest first, cut, with the total beside it.
    const csrf = idOf('csrf');
    const insert = db.prepare('INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, ts) VALUES (?, ?, ?, ?, 4, 2, ?)');
    db.transaction(() => { for (let i = 0; i < 2003; i++) insert.run(csrf, 'chatty', 'q', 'a', NEW); })();
    const chatty = (memorySessionPage(db, { session: 'chatty' }) as any).learning;
    expect(chatty.attempts).toHaveLength(2000);
    expect(chatty.attempts_total).toBe(2003);
    const ids = chatty.attempts.map((a: any) => a.id);
    expect(ids).toEqual([...ids].sort((x: number, y: number) => y - x));
  });

  it('gives a lookup the same rows, in the same shape and order, as the payload holds for a session it carries', () => {
    const state = dashboardState(db) as any;
    for (const session of ['s-mixed', 's-client', 's-legacy', 's-feature']) {
      const { learning } = memorySessionPage(db, { session }) as any;
      expect(learning.logged, session).toEqual(state.logged.filter((l: any) => l.session_id === session));
      expect(learning.attempts, session).toEqual(state.attempts.filter((a: any) => a.session_id === session));
      expect(learning.attempts_total, session).toBe(learning.attempts.length);
    }
  });

  it('leaves a session with memory and no learning with its rows, and empty learning lists', () => {
    const page = memorySessionPage(db, { session: 's-mem' }) as any;
    expect(page.rows).toHaveLength(1);
    expect(page.learning).toEqual({ logged: [], attempts: [], attempts_total: 0 });
  });

  it('answers a session nobody has heard of with nothing', () => {
    expect(memorySessionPage(db, { session: 'unknown' })).toEqual({
      total: 0, page: 1, pages: 1, per: 25, rows: [], learning: { logged: [], attempts: [], attempts_total: 0 },
    });
  });

  it('adds the learning half only when one session is asked for', () => {
    expect(memorySessionPage(db, {})).not.toHaveProperty('learning');
    expect(memorySessionPage(db, { project: fx.repo.mixed })).not.toHaveProperty('learning');
    expect(memorySessionPage(db, { session: '' })).not.toHaveProperty('learning');
  });

  it('serves it over HTTP from the resource the page already calls', async () => {
    logged('csrf', 'over-http', '2019-01-01 00:00:00', 'an old line');
    const { url, close } = await startDashboard(db, { port: 0 });
    try {
      const body = (await (await fetch(`${url}/api/memory/sessions?session=over-http&project=${encodeURIComponent(fx.repo.mixed)}`)).json()) as any;
      // Narrowed by the project it is scoped to: no memory rows there, and the learning half is whole.
      expect(body.rows).toEqual([]);
      expect(body.learning.logged.map((l: any) => l.context)).toEqual(['an old line']);
      const list = (await (await fetch(`${url}/api/memory/sessions?per=2`)).json()) as any;
      expect(Object.keys(list).sort()).toEqual(['page', 'pages', 'per', 'rows', 'total']);
    } finally {
      await close();
    }
  });
});

describe('the repositories a build folds', () => {
  it('are looked at once each, however many context lines name them', () => {
    fx = seedFixture(db, path.join(tmp, 'fx'));
    const insertGate = db.prepare("INSERT OR IGNORE INTO gates (session_id, mode, repo) VALUES (?, 'ambient', ?)");
    const insertLine = db.prepare('INSERT INTO session_concepts (session_id, concept_id, context, ts) VALUES (?, ?, ?, ?)');
    const csrf = idOf('csrf');
    const add = (from: number, to: number) => db.transaction(() => {
      for (let i = from; i < to; i++) {
        insertGate.run(`fold-${i}`, fx.repo.logged);
        insertLine.run(`fold-${i}`, csrf, 'a line', '2026-01-01 00:00:00');
      }
    })();
    /** Statements that look at a checkout's `.git`, which is what folding a worktree into its main checkout does. */
    const lookups = () => {
      const spy = vi.spyOn(fs, 'statSync');
      try {
        dashboardState(db);
        return spy.mock.calls.filter(([p]) => String(p) === path.join(fx.repo.logged, '.git')).length;
      } finally {
        spy.mockRestore();
      }
    };
    add(0, 3);
    const few = lookups();
    add(3, 300);
    expect(lookups()).toBe(few);
  });
});
