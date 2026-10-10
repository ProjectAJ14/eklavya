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
import { ATTEMPT_LIMIT, dashboardState, memorySessionPage, projectInventory, startDashboard, LOGGED_LIMIT } from '../src/dashboard.js';
import { conceptBySlug, PASSING_GRADE, projectKey } from '../src/store.js';
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

const legacyAttempts = (limit: number = ATTEMPT_LIMIT) =>
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
    limit,
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
      for (let i = 0; i < ATTEMPT_LIMIT + 5; i++) insertAnswer.run(csrf, `crowd-${i}`, 'recent?', 'a', 4, NEW, null);
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
    expect(state.attempts_shown).toBe(ATTEMPT_LIMIT);
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
    db.transaction(() => { for (let i = 0; i < ATTEMPT_LIMIT + 3; i++) insert.run(csrf, 'chatty', 'q', 'a', NEW); })();
    const chatty = (memorySessionPage(db, { session: 'chatty' }) as any).learning;
    expect(chatty.attempts).toHaveLength(ATTEMPT_LIMIT);
    expect(chatty.attempts_total).toBe(ATTEMPT_LIMIT + 3);
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

// ---------------------------------------------------------------------------
// The answers table is read in two passes where five statements read it. Each
// figure is checked against the statement it replaced, verbatim from the commit
// before the rewrite, over the fixture, the fixture and the rows that tell a wrong
// rewrite apart, and learners generated from a seed.

const legacyDaily = () =>
  all(
    `SELECT date(a.ts, 'localtime') AS day,
            NULLIF(trim(COALESCE(a.repo, '')), '') AS repo,
            sum(CASE WHEN a.grade >= ? THEN 1 ELSE 0 END) AS passed,
            sum(CASE WHEN a.grade < ? AND (a.outcome IS NULL OR a.outcome = 'answered') AND fix.id IS NULL THEN 1 ELSE 0 END) AS missed,
            sum(CASE WHEN a.outcome IN ('declined','dont_know') AND fix.id IS NULL THEN 1 ELSE 0 END) AS skipped,
            count(fix.id) AS corrected
     FROM attempts a LEFT JOIN attempts fix ON fix.retry_of = a.id
     WHERE a.retry_of IS NULL AND a.ts >= date('now', ?)
     GROUP BY 1, 2
     ORDER BY day`,
    PASSING_GRADE, PASSING_GRADE, '-365 days',
  );

// Two of these statements left equal rows (the same newest answer, the same count) in whatever order their
// plan gave them, which changes with the indexes there are; the ties are spelled out here (the column as
// written, a type as stored) so the comparison is the same under any plan.
const legacyProjects = () =>
  all(
    `SELECT NULLIF(trim(COALESCE(a.repo, '')), '') AS repo,
            count(*) AS answers,
            sum(CASE WHEN a.grade >= ? THEN 1 ELSE 0 END) AS passed,
            sum(CASE WHEN a.outcome IN ('declined','dont_know') THEN 1 ELSE 0 END) AS skipped,
            count(DISTINCT a.concept_id) AS concepts,
            min(a.ts) AS first_active,
            max(a.ts) AS last_active
     FROM attempts a
     WHERE a.retry_of IS NULL
     GROUP BY repo
     ORDER BY last_active DESC, a.repo`,
    PASSING_GRADE,
  );

const legacyTotals = () =>
  all(
    `SELECT count(*) AS answers,
            sum(CASE WHEN a.grade >= ? THEN 1 ELSE 0 END) AS passed,
            sum(CASE WHEN a.grade < ? AND (a.outcome IS NULL OR a.outcome = 'answered') AND fix.id IS NULL THEN 1 ELSE 0 END) AS missed,
            sum(CASE WHEN a.outcome IN ('declined','dont_know') AND fix.id IS NULL THEN 1 ELSE 0 END) AS skipped,
            count(fix.id) AS corrected,
            count(DISTINCT date(a.ts, 'localtime')) AS active_days,
            min(a.ts) AS first_answer
     FROM attempts a LEFT JOIN attempts fix ON fix.retry_of = a.id
     WHERE a.retry_of IS NULL`,
    PASSING_GRADE, PASSING_GRADE,
  )[0]!;

const legacyMemory = () => ({
  entries: all(
    `SELECT count(*) AS total,
            COALESCE(SUM(deleted_at IS NULL AND superseded_by IS NULL), 0) AS live,
            COALESCE(SUM(superseded_by IS NOT NULL), 0) AS superseded,
            COALESCE(SUM(deleted_at IS NOT NULL), 0) AS deleted,
            COALESCE(SUM(kind = 'note'), 0) AS notes
     FROM memory_entries`,
  )[0]!,
  types: all(`SELECT COALESCE(type, 'untyped') AS type, count(*) AS n FROM memory_entries
              WHERE deleted_at IS NULL GROUP BY type ORDER BY n DESC, memory_entries.type`),
  tags: all(`SELECT t.tag, count(*) AS n FROM memory_entry_tags t
             JOIN memory_entries e ON e.id = t.entry_id AND e.deleted_at IS NULL
             GROUP BY t.tag ORDER BY n DESC, t.tag LIMIT 60`),
});

/** Every figure the two passes produce, beside the statements they replaced. */
function expectRollupsToMatchLegacy(label: string) {
  const state = dashboardState(db) as any;
  expect(state.daily, `${label}: daily`).toEqual(legacyDaily());
  expect(state.projects.map((p: any) => ({
    repo: p.repo, answers: p.answers, passed: p.passed, skipped: p.skipped, concepts: p.concepts,
    first_active: p.first_active, last_active: p.last_active,
  })), `${label}: projects`).toEqual(legacyProjects());
  const totals = legacyTotals() as any;
  expect(state.totals, `${label}: totals`).toMatchObject({
    answers: totals.answers, passed: totals.passed ?? 0, missed: totals.missed ?? 0, skipped: totals.skipped ?? 0,
    corrected: totals.corrected, active_days: totals.active_days, first_answer: totals.first_answer,
  });
  expect(state.attempts_total, `${label}: attempts_total`).toBe(totals.answers);
  const legacy = legacyConcepts();
  expect(state.concepts.map((c: any) => ({
    slug: c.slug, attempts: c.attempts, passed: c.passed, skipped: c.skipped, corrected: c.corrected,
    first_asked: c.first_asked, last_grade: c.last_grade, last_context: c.context, last_repo: c.repo,
  })), `${label}: concepts`).toEqual(legacy.map((r: any) => ({
    slug: r.slug, attempts: r.attempts, passed: r.passed, skipped: r.skipped, corrected: r.corrected,
    first_asked: r.first_asked, last_grade: r.last_grade, last_context: r.last_context, last_repo: r.last_repo,
  })));
  const memory = legacyMemory();
  expect(state.memory, `${label}: memory`).toMatchObject({
    entries: memory.entries.live, entries_total: memory.entries.total, superseded: memory.entries.superseded,
    deleted: memory.entries.deleted, notes: memory.entries.notes, types: memory.types, tags: memory.tags,
  });
}

/** A small seeded PRNG, so a failing learner can be reproduced. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** SQLite's own shape for a time `d` days and `h` hours ago. */
const ago = (d: number, h = 0) => new Date(Date.now() - d * 86400000 - h * 3600000).toISOString().slice(0, 19).replace('T', ' ');

/**
 * A learner nobody wrote by hand: answers on every kind of repository (a path, the same path
 * with a space after it, blank, empty, unset), over more than a year (so some fall outside the
 * daily window, and two sit either side of its edge), with declines, blanks, ungraded outcomes
 * and corrections (some filed under another concept, or another repository, than the answer
 * they fix), and two projects whose newest answer is the same instant.
 */
function seedLearner(seed: number, repos: string[]) {
  const rand = prng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const slugs = ['csrf', 'jwt-structure', 'cors-basics', 'git-stash', 'git-rebase', 'express-middleware', 'react-lists-keys'];
  const spellings: (string | null)[] = [...repos, `${repos[0]} `, '  ', '', null];
  const edge = (db.prepare("SELECT date('now', '-365 days') AS d").get() as { d: string }).d;
  const justBefore = (db.prepare("SELECT datetime(?, '-1 second') AS t").get(edge) as { t: string }).t;
  const sessions = ['r-1', 'r-2', 'r-3', 'r-4', null];
  const rows: number[] = [];
  const corrected = new Set<number>();
  const add = (slug: string, repo: string | null, ts: string, grade: number, outcome: string | null, retryOf: number | null = null) =>
    answer(slug, pick(sessions), ts, { repo, grade, ...(outcome ? { outcome } : {}), ...(retryOf ? { retryOf } : {}) });
  for (let i = 0; i < 260; i++) {
    const outcome = pick(['answered', 'answered', 'answered', 'declined', 'dont_know']);
    const grade = outcome === 'answered' ? Math.floor(rand() * 6) : Math.floor(rand() * 2);
    const id = add(pick(slugs), pick(spellings), ago(Math.floor(rand() * 420), Math.floor(rand() * 24)), grade, outcome);
    rows.push(id);
    if (grade < PASSING_GRADE && rand() < 0.4) {
      // The correction is stamped later, on the explainer; some name another repository or another concept's answer.
      // An answer is corrected once.
      const fixed = rand() < 0.15 ? pick(rows) : id;
      if (!corrected.has(fixed)) {
        corrected.add(fixed);
        add(pick(slugs), pick(spellings), ago(Math.floor(rand() * 5)), 4, 'answered', fixed);
      }
    }
  }
  // Either side of the window's edge, and the same instant for the newest answer of two projects.
  add('csrf', repos[0]!, `${edge} 00:00:00`, 5, 'answered');
  add('csrf', repos[0]!, justBefore, 1, 'answered');
  const tie = ago(0, 0);
  add('jwt-structure', repos[1]!, tie, 3, 'answered');
  add('git-stash', repos[2]!, tie, 2, 'answered');
  return rows.length;
}

/**
 * The inventory's answer counts per project against the statement it read them with (a lookup
 * for a correction made per answer), summed per project through the inventory's own spellings.
 */
function expectInventoryAnswersToMatchLegacy(label: string) {
  const inv = projectInventory(db);
  const want = new Map<string, { answers: number; passed: number; skipped: number }>();
  for (const r of all<{ repo: string | null; n: number; passed: number; skipped: number }>(
    `SELECT repo, count(*) AS n,
            COALESCE(SUM(grade >= ${PASSING_GRADE} OR EXISTS (SELECT 1 FROM attempts fix WHERE fix.retry_of = attempts.id)), 0) AS passed,
            COALESCE(SUM(outcome IN ('declined','dont_know')), 0) AS skipped
     FROM attempts WHERE retry_of IS NULL GROUP BY repo`,
  )) {
    const v = r.repo?.trim();
    const id = !v ? '~' : inv.aliases[v] ?? v;
    const t = want.get(id) ?? { answers: 0, passed: 0, skipped: 0 };
    want.set(id, { answers: t.answers + r.n, passed: t.passed + r.passed, skipped: t.skipped + r.skipped });
  }
  for (const p of inv.projects) {
    const { answers, passed, skipped } = p.learning;
    expect({ answers, passed, skipped }, `${label}: ${p.id}`).toEqual(want.get(p.id) ?? { answers: 0, passed: 0, skipped: 0 });
  }
  for (const id of want.keys()) expect(inv.projects.map((p) => p.id), label).toContain(id);
}

describe('the answers, read in two passes, are what five statements read', () => {
  const makeRepos = () => ['alpha', 'beta', 'gamma'].map((n) => {
    const dir = path.join(tmp, n);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return dir;
  });

  it('over the fixture, and over the rows that tell a wrong rewrite apart', () => {
    fx = seedFixture(db, path.join(tmp, 'fx'));
    expectRollupsToMatchLegacy('fixture');
    expectInventoryAnswersToMatchLegacy('fixture');
    seedExtras();
    expectRollupsToMatchLegacy('fixture and extras');
    expectInventoryAnswersToMatchLegacy('fixture and extras');
  });

  it('over an empty database, which has no answers to sum', () => {
    expectRollupsToMatchLegacy('empty');
    expect((dashboardState(db) as any).totals).toMatchObject({ answers: 0, passed: 0, missed: 0, skipped: 0, corrected: 0, active_days: 0, first_answer: null });
  });

  it.each([1, 2, 3, 4, 5])('over a learner generated from seed %i', (seed) => {
    expect(seedLearner(seed, makeRepos())).toBeGreaterThan(200);
    expectRollupsToMatchLegacy(`seed ${seed}`);
    expectInventoryAnswersToMatchLegacy(`seed ${seed}`);
  });

  it('keeps a concept whose only rows are corrections, with no newest answer and no grade', () => {
    // A correction filed under another concept than the answer it fixes leaves that concept with a
    // correction and nothing else: counted as corrected, but never asked.
    const [alpha] = makeRepos();
    const miss = answer('csrf', 'x-1', ago(2), { repo: alpha, grade: 1 });
    answer('git-stash', 'x-1', ago(1), { repo: alpha, grade: 4, retryOf: miss });
    expectRollupsToMatchLegacy('orphaned correction');
    const stash = (dashboardState(db) as any).concepts.find((c: any) => c.slug === 'git-stash');
    expect(stash).toMatchObject({ attempts: 0, corrected: 1, last_grade: null, repo: alpha, first_asked: null });
  });

  it('keeps an answer whose time is no time: a day row with no day, and no active day', () => {
    const [alpha] = makeRepos();
    answer('csrf', 'bad-1', ago(3), { repo: alpha });
    answer('csrf', 'bad-1', 'not a time', { repo: alpha });
    // A correction of it is just as undated.
    answer('csrf', 'bad-1', 'also not a time', { repo: alpha, grade: 4, retryOf: answer('git-stash', 'bad-2', 'not a time either', { repo: alpha, grade: 1 }) });
    expectRollupsToMatchLegacy('undated');
    expectInventoryAnswersToMatchLegacy('undated');
    const state = dashboardState(db) as any;
    expect(state.daily.map((d: any) => d.day)).toContain(null);
    expect(state.totals.active_days).toBe(1);
  });

  it('orders projects with the same newest answer as the statement did', () => {
    const [alpha, beta, gamma] = makeRepos();
    const same = ago(1);
    for (const repo of [gamma, alpha, beta]) answer('csrf', 'tie', same, { repo });
    const order = (dashboardState(db) as any).projects.map((p: any) => p.repo);
    expect(order).toEqual(legacyProjects().map((p: any) => p.repo));
    expect(new Set(order).size).toBe(3);
  });
});

describe('the memory counts, read in one pass, are what three statements read', () => {
  const insertEntry = (type: string | null, opts: { kind?: string; deleted?: boolean; superseded?: boolean; tags?: string[] } = {}) => {
    const id = Number(
      run(
        `INSERT INTO memory_entries (entry_uid, project, session_id, kind, type, title, occurred_at, deleted_at, superseded_by)
         VALUES (?, 'p', 's', ?, ?, 't', '2026-03-02T00:00:00.000Z', ?, ?)`,
        `m-${Math.random()}`, opts.kind ?? 'observation', type, opts.deleted ? '2026-03-03T00:00:00.000Z' : null, opts.superseded ? 1 : null,
      ).lastInsertRowid,
    );
    for (const tag of opts.tags ?? []) run('INSERT INTO memory_entry_tags (entry_id, tag) VALUES (?, ?)', id, tag);
    return id;
  };

  it('counts every type and tag when nothing is deleted, with types of equal size in type order', () => {
    // 'untyped' is a type someone may write, as well as the name of having none.
    for (const type of ['feature', 'bugfix', null, 'untyped', 'bugfix', 'feature', 'decision']) insertEntry(type, { tags: ['auth', 'docs'] });
    insertEntry('note-type', { kind: 'note', tags: ['auth'] });
    insertEntry('bugfix', { superseded: true });
    insertEntry('feature');
    expectRollupsToMatchLegacy('nothing deleted');
    const memory = (dashboardState(db) as any).memory;
    expect(memory.deleted).toBe(0);
    expect(memory.notes).toBe(1);
    expect(memory.tags[0]).toEqual({ tag: 'auth', n: 8 });
  });

  it('counts only what is not deleted once something is, and drops a type nothing live is left in', () => {
    insertEntry('bugfix', { tags: ['auth'] });
    insertEntry('bugfix', { tags: ['auth', 'git'], deleted: true });
    insertEntry('retired-type', { deleted: true, tags: ['git'] });
    insertEntry(null, { tags: ['git'] });
    insertEntry(null, { deleted: true });
    expectRollupsToMatchLegacy('something deleted');
    const memory = (dashboardState(db) as any).memory;
    expect(memory.deleted).toBe(3);
    expect(memory.types.map((t: any) => t.type).sort()).toEqual(['bugfix', 'untyped']);
    expect(memory.tags).toEqual([{ tag: 'auth', n: 1 }, { tag: 'git', n: 1 }]);
  });

  it('has no types, no tags and no entries to count in a database with none', () => {
    expect((dashboardState(db) as any).memory).toMatchObject({ entries: 0, entries_total: 0, superseded: 0, deleted: 0, notes: 0, types: [], tags: [] });
  });
});

describe('the sessions of a build with the same newest event keep SQLite\'s order for their ids', () => {
  it('compares ids by the bytes SQLite does, where JavaScript compares UTF-16 units', () => {
    // 'a' < 'ab' < 'b' by any rule; U+FFFF (three bytes) sorts before an emoji (four bytes, a surrogate pair in
    // UTF-16, which sorts first there), and an accented letter sorts after every ASCII one.
    for (const session of ['b', 'ab', 'a', '\u{1F600}', '￿', 'é', 'a']) evidence('/p', '/p', session, at('09:00'));
    const sessions = (dashboardState(db) as any).memory_sessions.map((r: any) => r.session_id);
    const bySqlite = all<{ session_id: string }>(
      'SELECT session_id FROM evidence_events GROUP BY session_id, project ORDER BY max(occurred_at) DESC, session_id, project',
    ).map((r) => r.session_id);
    expect(sessions).toEqual(bySqlite);
    expect(sessions).toEqual(['a', 'ab', 'b', 'é', '￿', '\u{1F600}']);
  });
});

// ---------------------------------------------------------------------------
// What the page narrows a project to must not depend on how many rows the payload
// carries. The page builds its concept list for a project from the rows it holds
// (`recomputeScope`), so with the lists capped it would lose a concept whose only
// rows are old. The inventory says, per project, which concepts any row names
// (`concept_slugs`), from every row, and how many sessions it has.

type Inventory = ReturnType<typeof projectInventory>;

/** The page's `pid()`: the one place a row is given a project (`dashboard.html`). */
const pidOf = (inv: Inventory, raw: unknown, session: unknown): string => {
  const v = raw == null ? '' : String(raw).trim();
  if (!v) return (session && inv.sessions[session as string]) || '~';
  return inv.aliases[v] ?? v;
};

/**
 * `recomputeScope`, `loggedInScope` and `attemptsInScope`, run over every row there is
 * (what the page held when nothing was capped): per project, the slugs its rows name and
 * the sessions they belong to.
 */
function scopeOfEveryRow(inv: Inventory) {
  const slugs = new Map<string, Set<string>>();
  const sessions = new Map<string, Set<string>>();
  const note = (raw: unknown, session: string | null, slug: string) => {
    const id = pidOf(inv, raw, session);
    (slugs.get(id) ?? slugs.set(id, new Set()).get(id)!).add(slug);
    if (session) (sessions.get(id) ?? sessions.set(id, new Set()).get(id)!).add(session);
  };
  for (const a of legacyAttempts(1e9)) note(a.repo, a.session_id, a.slug);
  for (const l of legacyLogged()) note(l.repo, l.session_id, l.slug);
  return { slugs, sessions };
}

/** The same, from the rows a payload carries. */
function scopeOfPayload(inv: Inventory, state: any, id: string): Set<string> {
  const out = new Set<string>();
  for (const a of state.attempts) if (pidOf(inv, a.repo, a.session_id) === id) out.add(a.slug);
  for (const l of state.logged) if (pidOf(inv, l.repo, l.session_id) === id) out.add(l.slug);
  return out;
}

describe('the concepts a project is narrowed to', () => {
  it('are what the page derived from every row, for every project of the fixture and the rows that differ', () => {
    fx = seedFixture(db, path.join(tmp, 'fx'));
    seedExtras();
    // A session the gate does not place but whose own evidence does: its answers with no repository are
    // that project's for the page, and the inventory's answer counts say otherwise (as they always have).
    const gone = fx.repo.mixed;
    run("INSERT INTO gates (session_id, mode, repo) VALUES ('proof-s', 'ambient', NULL)");
    logged('cors-basics', 'proof-s', '2026-02-20 09:00:00', 'a line in a session with no repository');
    evidence(gone, gone, 'proof-s', at('09:00'));
    answer('key-rotation-jwks', 'proof-s', '2026-02-20 10:00:00', { repo: null });
    // And one nothing proves anything about.
    answer('react-lists-keys', 'nowhere-s', '2026-02-21 10:00:00', { repo: '  ' });
    answer('git-rebase', null, '2026-02-22 10:00:00', { repo: null });

    const inv = projectInventory(db);
    const { slugs } = scopeOfEveryRow(inv);
    for (const p of inv.projects) {
      expect(p.learning.concept_slugs, p.id).toEqual([...(slugs.get(p.id) ?? [])].sort());
    }
    // Every project the rows can name is in the inventory, so none is lost to a lookup that finds nothing.
    for (const id of slugs.keys()) expect(inv.projects.map((p) => p.id)).toContain(id);
    // The case that tells the page's reading from the inventory's apart is in this data.
    expect(inv.sessions['proof-s']).toBe(gone);
    expect(inv.projects.find((p) => p.id === gone)!.learning.concept_slugs).toContain('key-rotation-jwks');
    expect(inv.projects.find((p) => p.id === '~')!.learning.concept_slugs).toEqual(expect.arrayContaining(['react-lists-keys', 'git-rebase']));
  });

  it('are sorted, each once, and none for a project with no rows that name a concept', () => {
    fx = seedFixture(db, path.join(tmp, 'fx'));
    const inv = projectInventory(db);
    for (const p of inv.projects) {
      expect(p.learning.concept_slugs, p.id).toEqual([...new Set(p.learning.concept_slugs)].sort());
    }
    expect(inv.projects.find((p) => p.id === fx.repo.memoryOnly)!.learning.concept_slugs).toEqual([]);
    // A concept the work logged and a question was asked about is one entry, and review lines count too.
    expect(inv.projects.find((p) => p.id === fx.repo.mixed)!.learning.concept_slugs).toEqual(
      expect.arrayContaining(['csrf', 'refresh-token-rotation', 'git-rebase', 'git-stash']),
    );
  });

  describe('when the payload holds only the newest rows', () => {
    let repoA = '';
    let repoB = '';
    const OLD = '2026-01-01 00:00:00';
    const NEWER = '2030-01-01 00:00:00';

    /** A project whose only trace of three concepts is in its oldest rows, under newer rows of another. */
    beforeEach(() => {
      repoA = path.join(tmp, 'proj-a');
      repoB = path.join(tmp, 'proj-b');
      for (const r of [repoA, repoB]) fs.mkdirSync(path.join(r, '.git'), { recursive: true });
      const gate = db.prepare("INSERT INTO gates (session_id, mode, repo) VALUES (?, 'ambient', ?)");
      const line = db.prepare('INSERT INTO session_concepts (session_id, concept_id, context, ts, origin) VALUES (?, ?, ?, ?, ?)');
      const ask = db.prepare('INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, ts, repo) VALUES (?, ?, ?, ?, ?, 2, ?, ?)');
      db.transaction(() => {
        // Logged and never asked, in project A, before anything else.
        ['git-stash', 'git-rebase', 'cors-basics'].forEach((slug, i) => {
          gate.run(`old-line-${i}`, repoA);
          line.run(`old-line-${i}`, idOf(slug), 'an old line', OLD, 'work');
        });
        // Asked and never logged, in project A, before anything else.
        ['express-middleware', 'react-lists-keys'].forEach((slug, i) => {
          ask.run(idOf(slug), `old-ask-${i}`, 'q', 'a', 4, OLD, repoA);
        });
        // Then more of each than the payload carries, alternating between the two projects, on one concept.
        for (let i = 0; i < LOGGED_LIMIT + 300; i++) {
          gate.run(`new-line-${i}`, i % 2 ? repoA : repoB);
          line.run(`new-line-${i}`, idOf('csrf'), 'a new line', NEWER, 'work');
        }
        for (let i = 0; i < ATTEMPT_LIMIT + 300; i++) ask.run(idOf('csrf'), `new-ask-${i}`, 'q', 'a', 4, NEWER, i % 2 ? repoA : repoB);
      })();
    });

    it('still lists a concept whose only rows fell outside both caps', () => {
      const state = dashboardState(db) as any;
      const inv = projectInventory(db);
      // The payload no longer carries those rows, and says so …
      expect(state.logged).toHaveLength(LOGGED_LIMIT);
      expect(state).toMatchObject({ logged_shown: LOGGED_LIMIT, logged_total: LOGGED_LIMIT + 303, attempts_shown: ATTEMPT_LIMIT, attempts_total: ATTEMPT_LIMIT + 302 });
      const fromRows = scopeOfPayload(inv, state, repoA);
      expect([...fromRows]).toEqual(['csrf']);
      // … so a concept list built from them is missing five of the project's six concepts,
      // and the inventory, which reads every row, is not.
      const a = inv.projects.find((p) => p.id === repoA)!;
      expect(a.learning.concept_slugs).toEqual(['cors-basics', 'csrf', 'express-middleware', 'git-rebase', 'git-stash', 'react-lists-keys']);
      expect(a.learning.logged_concepts).toBe(4);
      expect(a.learning.assessed_concepts).toBe(3);
      expect(inv.projects.find((p) => p.id === repoB)!.learning.concept_slugs).toEqual(['csrf']);
      expect(a.learning.concept_slugs).toEqual([...scopeOfEveryRow(inv).slugs.get(repoA)!].sort());
    });

    it('counts every session of the project, which the rows the payload holds no longer do', () => {
      const state = dashboardState(db) as any;
      const inv = projectInventory(db);
      const { sessions } = scopeOfEveryRow(inv);
      const a = inv.projects.find((p) => p.id === repoA)!;
      // 3 + 2 old sessions, half of the newer lines' sessions and half of the newer answers' (a session is counted once).
      expect(a.learning.sessions).toBe(sessions.get(repoA)!.size);
      expect(a.learning.sessions).toBe(5 + (LOGGED_LIMIT + 300) / 2 + (ATTEMPT_LIMIT + 300) / 2);
      // Sessions the payload's rows can name, for the project: fewer.
      const held = new Set<string>();
      for (const l of state.logged) if (pidOf(inv, l.repo, l.session_id) === repoA) held.add(l.session_id);
      for (const x of state.attempts) if (pidOf(inv, x.repo, x.session_id) === repoA && x.session_id) held.add(x.session_id);
      expect(held.size).toBeLessThan(a.learning.sessions);
    });

    it('opens every one of those sessions whole, whether the payload holds it, part of it or none of it', () => {
      const state = dashboardState(db) as any;
      const every = legacyLogged();
      const everyAnswer = legacyAttempts(1e9);
      const held = new Set(state.logged.map((l: any) => l.session_id));
      // Equal times keep the order the rows were written in: the first thousand written are the ones shipped.
      expect(held.has('new-line-0')).toBe(true);
      expect(held.has('old-line-0')).toBe(false);
      expect(held.has(`new-line-${LOGGED_LIMIT + 299}`)).toBe(false);
      for (const session of ['old-line-0', 'old-line-2', 'old-ask-1', 'new-line-0', `new-line-${LOGGED_LIMIT + 299}`, 'new-ask-3', 'unknown']) {
        const { learning } = memorySessionPage(db, { session }) as any;
        expect(learning.logged, session).toEqual(every.filter((l: any) => l.session_id === session));
        expect(learning.attempts, session).toEqual(everyAnswer.filter((a: any) => a.session_id === session));
        expect(learning.attempts_total, session).toBe(learning.attempts.length);
      }
    });
  });
});

describe('the inventory\'s first and last time, read as instants', () => {
  it('reads both timestamp shapes, skips what is no time at all, and keeps ISO text out', () => {
    const repo = path.join(tmp, 'spans');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    run("INSERT INTO gates (session_id, mode, repo) VALUES ('sp-1', 'ambient', ?), ('sp-2', 'ambient', ?)", repo, repo);
    // SQLite's shape from attempts, an ISO shape from a logged line (as a hook writes it), a time with an offset,
    // a row with no time and one that is not a time: only the instants count.
    answer('csrf', 'sp-1', '2026-03-01 10:00:00', { repo });
    answer('csrf', 'sp-1', '2026-03-09 12:30:00', { repo });
    logged('csrf', 'sp-1', '2026-03-01T08:00:00.000Z', 'iso line');
    logged('git-stash', 'sp-2', '2026-02-28T23:30:00+02:00', 'offset line');
    logged('git-rebase', 'sp-2', '', 'empty time');
    logged('cors-basics', 'sp-2', 'not a time', 'no time at all');
    evidence(repo, repo, 'sp-1', '2026-02-27T23:00:00.000Z');
    evidence(repo, repo, 'sp-1', '2026-03-10T00:00:00.000Z');
    entry(repo, 'sp-1', '2026-03-15T00:00:00.000Z');
    const p = projectInventory(db).projects.find((x) => x.id === repo)!;
    expect(p.learning).toMatchObject({ first: '2026-02-28T21:30:00.000Z', last: '2026-03-09T12:30:00.000Z' });
    expect(p.memory).toMatchObject({ first: '2026-02-27T23:00:00.000Z', last: '2026-03-15T00:00:00.000Z' });
    expect(p).toMatchObject({ first_active: '2026-02-27T23:00:00.000Z', last_active: '2026-03-15T00:00:00.000Z' });
  });

  it('has no first and no last for a project nothing dated names', () => {
    const repo = path.join(tmp, 'undated');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    run("INSERT INTO gates (session_id, mode, repo) VALUES ('ud-1', 'ambient', ?)", repo);
    logged('csrf', 'ud-1', 'never', 'no time');
    const p = projectInventory(db).projects.find((x) => x.id === repo)!;
    expect(p.learning).toMatchObject({ first: null, last: null, sessions: 1 });
    expect(p.memory).toMatchObject({ first: null, last: null });
  });
});
