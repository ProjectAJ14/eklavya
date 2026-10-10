/**
 * The dashboard serves a build once per cursor (issue #171, Phase 3): what is
 * memoized and for how long, what a write does to it, what is never memoized,
 * the warm build at start, and the headers that let a browser keep the static
 * files and the page.
 *
 * "The builder did not run" is read off the SQL the database was asked to
 * prepare, not off a counter in the code under test: a repeat that is really
 * served from the memo prepares the cursor's statements and nothing else.
 * Every case pins EKLAVYA_HOME to a temporary directory.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  changeCursor, configurableProjects, etagMatches, MEMO_TTL_MS, PAGE_CACHE_ENTRIES, settingsState, startDashboard,
  updateSetting,
} from '../src/dashboard.js';
// The static files are copied into dist/assets by the build, so their headers are read from the built server.
import { startDashboard as startBuilt } from '../dist/dashboard.js';
import { writeConfigFile } from '../src/config.js';
import { projectConfigPath } from '../src/paths.js';
import { appendEvent, insertEntry } from '../src/memory/store.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let home = '';
let repo = '';
const saved = process.env.EKLAVYA_HOME;
const closers: (() => void)[] = [];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-memo-home-'));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-memo-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.EKLAVYA_HOME = home;
  dbFile = tempDbPath('dashboard-memo');
  db = openDb(dbFile);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const close of closers.splice(0)) close();
  db.close();
  cleanup(dbFile);
  if (saved === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

const call = (tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown>) =>
  tool.handler({ cwd: process.cwd(), ...args }, { db }) as any;

/** One answered question: the smallest write that moves the cursor the way a hook's would. */
function answer(question = 'q') {
  call(logSessionConcepts, { session_id: 'memo-s', concepts: [{ slug: 'csrf', context: 'chose SameSite=Lax' }] });
  call(recordAttempt, { session_id: 'memo-s', slug: 'csrf', question, answer: 'a', grade: 4, difficulty: 2 });
}

/** Memory seen from a project that never answered anything: its settings file is in no cursor. */
function memoryOnly(project = repo) {
  appendEvent(db, { eventUid: `m-${Math.random()}`, project, sessionId: 'mem-s', kind: 'tool_use', tool: 'Edit', title: 't', body: 'b' });
}

async function serve(d: DB = db, start: typeof startDashboard = startDashboard): Promise<string> {
  const { url, close } = await start(d, { port: 0 });
  closers.push(close);
  return url;
}

/** The next turn of the event loop after anything already queued, which is where the warm build runs. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
const raw = (url: string, route: string, headers: http.OutgoingHttpHeaders = {}, method = 'GET'): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const u = new URL(url + route);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
const json = (r: Reply): any => JSON.parse(r.body.toString('utf8'));

/** The statements the database was asked to prepare while a spy was on it. */
const watch = (d: DB = db) => vi.spyOn(d, 'prepare');
const ran = (spy: ReturnType<typeof watch>, re: RegExp) => spy.mock.calls.filter(([sql]) => re.test(String(sql))).length;
const STATE = /FROM concepts c\b/;
const INVENTORY = /SELECT project, count\(\*\) AS n FROM context_receipts GROUP BY project/;
const CURSOR = /SELECT n FROM change_version/;
const MEMORY_PAGE = /SELECT count\(\*\) AS n FROM memory_entries e/;
const MEMORY_ENTRY = /SELECT \* FROM memory_entries WHERE id = \?/;
const SESSIONS_PAGE = /SELECT session_id, project FROM \(\s+SELECT session_id, project, max\(occurred_at\) AS last FROM evidence_events/;
const FEEDBACK_LIST = /SELECT COUNT\(\*\) AS n FROM feedback_items WHERE acknowledged_at IS NOT NULL/;
const FEEDBACK_ITEM = /SELECT \* FROM feedback_items WHERE id = \?/;
const CORRECTION = /FROM attempts a JOIN concepts c ON c.id = a.concept_id\s+WHERE a.id IN/;

/** Moves the clock the memo reads, by `ms`, without touching the dates the payload is built from. */
function skew(ms: () => number) {
  const real = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => real() + ms());
}

describe('/api/state is built once per cursor', () => {
  it('serves a repeat from the memo, byte for byte, and builds nothing', async () => {
    answer();
    const url = await serve();
    const first = await raw(url, '/api/state');
    expect(first.status).toBe(200);

    const spy = watch();
    const second = await raw(url, '/api/state');
    expect(second.body.equals(first.body)).toBe(true);
    expect(ran(spy, STATE)).toBe(0);
    // Exactly one read of the cursor, which is what decides it.
    expect(ran(spy, CURSOR)).toBe(1);
    // `generated_at` still says when the build happened, not when it was served.
    expect(json(second).generated_at).toBe(json(first).generated_at);
  });

  it('rebuilds after an answer, and the cursor in the body moves', async () => {
    answer('first');
    const url = await serve();
    const before = json(await raw(url, '/api/state'));
    answer('second');
    const spy = watch();
    const after = json(await raw(url, '/api/state'));
    expect(ran(spy, STATE)).toBe(1);
    expect(after.cursor).not.toBe(before.cursor);
    expect(after.cursor).toBe(changeCursor(db));
    expect(after.totals.answers).toBe(before.totals.answers + 1);
  });

  it('rebuilds after a settings save, and the payload carries the new dial', async () => {
    const url = await serve();
    const before = json(await raw(url, '/api/state'));
    expect(before.config.cadence).toBe('as-you-go');
    expect(updateSetting(db, { scope: 'user', key: 'cadence', value: 'end' }).status).toBe(200);
    const after = json(await raw(url, '/api/state'));
    expect(after.config.cadence).toBe('end');
    expect(after.cursor).not.toBe(before.cursor);
  });

  it('rebuilds after a new artifact, and lists it', async () => {
    const url = await serve();
    const before = json(await raw(url, '/api/state'));
    expect(before.artifacts).toEqual([]);
    const page = path.join(home, 'artifacts', 'p', 'x.html');
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, '<title>a new explainer</title>');
    const after = json(await raw(url, '/api/state'));
    expect(after.artifacts.map((a: any) => a.title)).toEqual(['a new explainer']);
    expect(after.cursor).not.toBe(before.cursor);
  });

  it('never labels a build with a cursor newer than the rows it read', async () => {
    // A write that lands while the state is being built: the memo took its cursor
    // first, so the next request sees a newer one and rebuilds. Read after the
    // build, the stale payload would have been served as current.
    const real = db.prepare.bind(db);
    let landed = false;
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (!landed && STATE.test(sql)) {
        landed = true;
        real('UPDATE change_version SET n = n + 1').run();
      }
      return real(sql);
    }) as never);
    const url = await serve();
    await tick(); // the warm build, with the write landing inside it
    expect(ran(spy, STATE)).toBe(1);
    const served = json(await raw(url, '/api/state'));
    expect(ran(spy, STATE)).toBe(2);
    expect(served.cursor).toBe(changeCursor(db));
  });

  it('expires after a minute, because scores decay with the clock', async () => {
    answer();
    const url = await serve();
    await raw(url, '/api/state');
    let later = 0;
    skew(() => later);
    const spy = watch();

    // The real time the test itself takes rides on top of the skew, hence the margin.
    later = MEMO_TTL_MS - 5_000;
    await raw(url, '/api/state');
    expect(ran(spy, STATE)).toBe(0);

    later = MEMO_TTL_MS + 1;
    const rebuilt = json(await raw(url, '/api/state'));
    expect(ran(spy, STATE)).toBe(1);
    expect(rebuilt.cursor).toBe(changeCursor(db));

    // The new build is the memo's now, and starts its own minute.
    await raw(url, '/api/state');
    expect(ran(spy, STATE)).toBe(1);
  });

  it('does not trust a build from the future when the clock steps back', async () => {
    const url = await serve();
    await raw(url, '/api/state');
    skew(() => -5_000);
    const spy = watch();
    await raw(url, '/api/state');
    expect(ran(spy, STATE)).toBe(1);
  });

  it('keeps each database to its own memo', async () => {
    answer();
    const otherFile = tempDbPath('dashboard-memo-other');
    const other = openDb(otherFile);
    try {
      const a = await serve(db);
      const b = await serve(other);
      const ofA = json(await raw(a, '/api/state'));
      const ofB = json(await raw(b, '/api/state'));
      expect(ofA.totals.answers).toBe(1);
      expect(ofB.totals.answers).toBe(0);

      // A write to one moves only its own: the other is still served from its memo.
      answer('again');
      const spyA = watch(db);
      const spyB = watch(other);
      expect(json(await raw(a, '/api/state')).totals.answers).toBe(2);
      expect(json(await raw(b, '/api/state')).totals.answers).toBe(0);
      expect(ran(spyA, STATE)).toBe(1);
      expect(ran(spyB, STATE)).toBe(0);
    } finally {
      vi.restoreAllMocks();
      for (const close of closers.splice(0)) close();
      other.close();
      cleanup(otherFile);
    }
  });
});

describe('what the cursor leaves out on purpose', () => {
  it('shows a review that could not be made on the next read, though the cursor holds still', async () => {
    // `feedback_reviewed` has no change triggers (migrate.test.ts pins it), so
    // this row moves no cursor; the page still has to say so when it loads.
    const url = await serve();
    const before = json(await raw(url, '/api/state'));
    expect(before.feedback.failed).toBe(false);
    const cursor = changeCursor(db);
    db.prepare("INSERT INTO feedback_reviewed (session_id, outcome) VALUES ('s', 'failed')").run();
    expect(changeCursor(db)).toBe(cursor);

    const spy = watch();
    const after = json(await raw(url, '/api/state'));
    expect(ran(spy, STATE)).toBe(1);
    expect(after.feedback.failed).toBe(true);

    // And back: the next session reviewed clean.
    db.prepare("INSERT INTO feedback_reviewed (session_id, outcome) VALUES ('t', 'nothing')").run();
    expect(json(await raw(url, '/api/state')).feedback.failed).toBe(false);
  });

  it('reads an older schema without the table as nothing failed', async () => {
    const url = await serve();
    db.exec('DROP TABLE feedback_reviewed');
    expect(json(await raw(url, '/api/state')).feedback.failed).toBe(false);
  });
});

describe('/api/cursor is never memoized', () => {
  it('reads the live cursor on every request and builds nothing', async () => {
    const url = await serve();
    await raw(url, '/api/state');
    const spy = watch();
    const before = json(await raw(url, '/api/cursor')).cursor;
    answer();
    const after = json(await raw(url, '/api/cursor')).cursor;
    expect(after).not.toBe(before);
    expect(after).toBe(changeCursor(db));
    expect(ran(spy, STATE)).toBe(0);
  });
});

describe('the project inventory is built once per database version', () => {
  it('serves /api/projects and the Settings list from one build', async () => {
    memoryOnly();
    const url = await serve();
    const first = json(await raw(url, '/api/projects'));
    expect(first.projects.map((p: any) => p.id)).toContain(repo);

    const spy = watch();
    expect(json(await raw(url, '/api/projects'))).toEqual(first);
    expect(configurableProjects(db).map((p) => p.id)).toEqual([repo]);
    expect(settingsState(db, null).projects).toEqual([expect.objectContaining({ id: repo })]);
    expect(ran(spy, INVENTORY)).toBe(0);
  });

  it('rebuilds when the database moves', async () => {
    memoryOnly();
    const url = await serve();
    await raw(url, '/api/projects');
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-memo-repo2-')));
    try {
      fs.mkdirSync(path.join(other, '.git'));
      memoryOnly(other);
      const spy = watch();
      const after = json(await raw(url, '/api/projects'));
      expect(ran(spy, INVENTORY)).toBe(1);
      expect(after.projects.map((p: any) => p.id).sort()).toEqual([repo, other].sort());
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('survives a settings save and a new artifact, which it does not read', async () => {
    memoryOnly();
    const url = await serve();
    await raw(url, '/api/projects');
    const spy = watch();
    expect(updateSetting(db, { scope: 'user', key: 'cadence', value: 'end' }).status).toBe(200);
    const page = path.join(home, 'artifacts', 'p', 'x.html');
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, '<title>x</title>');
    const cursorBefore = changeCursor(db);
    await raw(url, '/api/projects');
    expect(configurableProjects(db)).toHaveLength(1);
    expect(changeCursor(db)).toBe(cursorBefore);
    expect(ran(spy, INVENTORY)).toBe(0);
  });

  it('expires after a minute, because whether a checkout exists is read from the disk', () => {
    memoryOnly();
    expect(configurableProjects(db)).toHaveLength(1);
    fs.rmSync(path.join(repo, '.git'), { recursive: true });
    // Inside the minute the Settings list is the one it built; that is the price of not scanning on every click.
    expect(configurableProjects(db)).toHaveLength(1);
    let later = 0;
    skew(() => later);
    later = MEMO_TTL_MS;
    expect(configurableProjects(db)).toEqual([]);
    expect(configurableProjects(db, { fresh: true })).toEqual([]);
  });

  it('is rebuilt for a write, which is never validated against the memo', () => {
    memoryOnly();
    const body = { scope: 'project', project: repo, key: 'cadence', value: 'end' };
    expect(configurableProjects(db)).toHaveLength(1);

    // The checkout is deleted after the memo was built: a stale list would still accept the write.
    fs.rmSync(path.join(repo, '.git'), { recursive: true });
    expect(configurableProjects(db)).toHaveLength(1);
    expect(updateSetting(db, body)).toMatchObject({ status: 400, body: { error: expect.stringMatching(/not one this dashboard can configure/) } });
    expect(fs.existsSync(projectConfigPath(repo))).toBe(false);
    // The fresh picture became the memo's, so the page stops offering it at once.
    expect(configurableProjects(db)).toEqual([]);

    // And the other way: a checkout made after the memo was built can be written to.
    fs.mkdirSync(path.join(repo, '.git'));
    expect(updateSetting(db, body).status).toBe(200);
    expect(configurableProjects(db)).toHaveLength(1);
  });
});

describe('the other reads are memoized per URL', () => {
  const remember = (title: string, extra: { events?: number; body?: string } = {}) => {
    const ids: number[] = [];
    for (let i = 0; i < (extra.events ?? 1); i++) {
      ids.push(appendEvent(db, {
        eventUid: `${title}-${i}`, project: repo, sessionId: 'mem-s', kind: 'tool_use', tool: 'Edit', title,
        body: extra.body ?? 'diff body',
      }).id);
    }
    return insertEntry(db, { project: repo, sessionId: 'mem-s', type: 'bugfix', title, narrative: 'what happened', eventIds: ids });
  };

  it('answers a repeat of each one without building it', async () => {
    const id = remember('served once');
    const url = await serve();
    const routes: [string, RegExp][] = [
      ['/api/memory?per=1', MEMORY_PAGE],
      [`/api/memory/entry?id=${id}`, MEMORY_ENTRY],
      ['/api/memory/sessions?per=5', SESSIONS_PAGE],
      ['/api/feedback/list', FEEDBACK_LIST],
    ];
    const first = await Promise.all(routes.map(([route]) => raw(url, route)));
    const spy = watch();
    for (const [i, [route, builder]] of routes.entries()) {
      const again = await raw(url, route);
      expect(again.status, route).toBe(200);
      expect(again.body.equals(first[i]!.body), route).toBe(true);
      expect(ran(spy, builder), route).toBe(0);
    }
  });

  it('rebuilds them after a write', async () => {
    remember('before');
    const url = await serve();
    expect(json(await raw(url, '/api/memory')).total).toBe(1);
    remember('after');
    const spy = watch();
    expect(json(await raw(url, '/api/memory')).total).toBe(2);
    expect(ran(spy, MEMORY_PAGE)).toBe(1);
  });

  it('keys each response by its whole URL', async () => {
    remember('one');
    remember('two');
    const url = await serve();
    const small = json(await raw(url, '/api/memory?per=1'));
    const large = json(await raw(url, '/api/memory?per=2'));
    expect(small.rows).toHaveLength(1);
    expect(large.rows).toHaveLength(2);
    const spy = watch();
    expect(json(await raw(url, '/api/memory?per=1'))).toEqual(small);
    expect(json(await raw(url, '/api/memory?per=2'))).toEqual(large);
    expect(ran(spy, MEMORY_PAGE)).toBe(0);
  });

  it('keeps a bounded number, dropping the least recently used', async () => {
    const url = await serve();
    const at = (n: number) => `/api/memory?per=${n}`;
    for (let n = 1; n <= PAGE_CACHE_ENTRIES; n++) await raw(url, at(n));
    // Reading the oldest makes it the newest, so the next one in pushes out the second.
    await raw(url, at(1));
    await raw(url, at(PAGE_CACHE_ENTRIES + 1));

    const spy = watch();
    await raw(url, at(1));
    expect(ran(spy, MEMORY_PAGE)).toBe(0);
    await raw(url, at(2));
    expect(ran(spy, MEMORY_PAGE)).toBe(1);
  });

  it('serves but does not keep a response past the size cap', async () => {
    const id = remember('a very long evidence trail', { events: 300, body: 'x'.repeat(5000) });
    const url = await serve();
    const route = `/api/memory/entry?id=${id}`;
    const first = await raw(url, route);
    expect(first.body.length).toBeGreaterThan(1024 * 1024);
    const spy = watch();
    const second = await raw(url, route);
    expect(second.body.equals(first.body)).toBe(true);
    expect(ran(spy, MEMORY_ENTRY)).toBe(1);
  });

  it('does not keep an entry that is not there', async () => {
    const url = await serve();
    const spy = watch();
    for (let i = 0; i < 2; i++) expect((await raw(url, '/api/memory/entry?id=404404')).status).toBe(404);
    expect(ran(spy, MEMORY_ENTRY)).toBe(2);
  });

  it('never memoizes one feedback item or a correction, which are read live', async () => {
    const url = await serve();
    await tick(); // the warm build reads corrections too, and is not what is being counted
    const spy = watch();
    for (let i = 0; i < 2; i++) {
      await raw(url, '/api/feedback?id=1');
      await raw(url, '/api/attempts/correction?id=1');
    }
    expect(ran(spy, FEEDBACK_ITEM)).toBe(2);
    expect(ran(spy, CORRECTION)).toBe(2);
    // Neither asks for the cursor: a read that nothing is kept for has nothing to compare.
    expect(ran(spy, CURSOR)).toBe(0);
  });
});

describe('/api/settings is memoized, and never past what its files say', () => {
  const settings = (url: string, project: string | null = repo) =>
    raw(url, `/api/settings${project ? `?project=${encodeURIComponent(project)}` : ''}`);

  beforeEach(() => {
    fs.writeFileSync(path.join(home, 'config.json'), '{}');
    memoryOnly();
  });

  /** How many files the cursor reads on its own (the effective config is part of it). */
  const cursorReads = () => {
    const reads = vi.spyOn(fs, 'readFileSync');
    reads.mockClear();
    changeCursor(db);
    const n = reads.mock.calls.length;
    reads.mockClear();
    return { reads, n };
  };

  it('serves a repeat having read only what the cursor reads', async () => {
    const url = await serve();
    const first = await settings(url);
    const { reads, n } = cursorReads();
    const second = await settings(url);
    expect(second.body.equals(first.body)).toBe(true);
    expect(reads).toHaveBeenCalledTimes(n);
    // A page that is not in the memo reads the files themselves, so the count above means something.
    reads.mockClear();
    await settings(url, null);
    expect(reads.mock.calls.length).toBeGreaterThan(n);
  });

  it('shows a project setting written from the terminal for a project that never answered', async () => {
    // `eklavya config set --project` writes the file and nothing else: no row, so no
    // change counter, and the cursor hashes only projects with answers.
    const url = await serve();
    expect(json(await settings(url)).project.set.cadence).toBeUndefined();
    writeConfigFile(projectConfigPath(repo), { project: repo, cadence: 'end' });
    expect(json(await settings(url)).project.set.cadence).toBe('end');
    writeConfigFile(projectConfigPath(repo), { project: repo, cadence: 'as-you-go' });
    expect(json(await settings(url)).project.set.cadence).toBe('as-you-go');
  });

  it('shows the user file as it is after a save made through the page', async () => {
    const url = await serve();
    expect(json(await settings(url)).user.set.cadence).toBeUndefined();
    expect(updateSetting(db, { scope: 'user', key: 'cadence', value: 'end' }).status).toBe(200);
    expect(json(await settings(url)).user.set.cadence).toBe('end');
  });

  it('is dropped by a save even if no file looks different', async () => {
    // A rewrite within one clock tick, with the same size and a reused inode,
    // would look the same to a stat; the save itself says so. Every stat reads
    // the same here, from before the page is first read.
    const real = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, opts?: { bigint?: boolean }) =>
      opts?.bigint ? { ino: 1n, size: 1n, mtimeNs: 1n } : real(file, opts as never)) as never);
    const url = await serve();
    expect(json(await settings(url)).project.set.cadence).toBeUndefined();
    const cursorBefore = changeCursor(db);
    expect(updateSetting(db, { scope: 'project', project: repo, key: 'cadence', value: 'end' }).status).toBe(200);
    expect(changeCursor(db)).toBe(cursorBefore);
    expect(json(await settings(url)).project.set.cadence).toBe('end');
  });

  it('is rebuilt after a minute, for what it reads from the disk and the clock', async () => {
    const url = await serve();
    await settings(url);
    let later = 0;
    skew(() => later);
    const { reads, n } = cursorReads();
    later = MEMO_TTL_MS - 5_000;
    await settings(url);
    expect(reads).toHaveBeenCalledTimes(n);
    later = MEMO_TTL_MS + 1;
    reads.mockClear();
    await settings(url);
    expect(reads.mock.calls.length).toBeGreaterThan(n);
  });

  it('keeps a page for each project it is asked about', async () => {
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-memo-repo2-')));
    try {
      fs.mkdirSync(path.join(other, '.git'));
      memoryOnly(other);
      const url = await serve();
      const mine = json(await settings(url, repo));
      const theirs = json(await settings(url, other));
      expect([mine.project.id, theirs.project.id]).toEqual([repo, other]);
      expect(mine.projects.map((p: any) => p.id).sort()).toEqual([repo, other].sort());
      // Each is its own entry, and each is written to its own file.
      writeConfigFile(projectConfigPath(other), { project: other, cadence: 'end' });
      expect(json(await settings(url, other)).project.set.cadence).toBe('end');
      expect(json(await settings(url, repo)).project.set.cadence).toBeUndefined();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps the pages a save does not touch', async () => {
    const url = await serve();
    await raw(url, '/api/memory?per=3');
    await settings(url);
    const spy = watch();
    // A project write for a project that never answered moves no cursor.
    expect(updateSetting(db, { scope: 'project', project: repo, key: 'cadence', value: 'end' }).status).toBe(200);
    await raw(url, '/api/memory?per=3');
    expect(ran(spy, MEMORY_PAGE)).toBe(0);
  });

  it('forgets nothing when there is nothing to forget', () => {
    expect(updateSetting(db, { scope: 'user', key: 'cadence', value: 'end' }).status).toBe(200);
  });
});

describe('the first build is made when the server starts', () => {
  it('runs after the server is listening, not before', async () => {
    const spy = watch();
    const url = await serve();
    // The bind resolved without waiting for it: nothing has touched the database yet.
    expect(spy).not.toHaveBeenCalled();
    expect((await raw(url, '/api/health')).status).toBe(200);
    await tick();
    expect(ran(spy, STATE)).toBe(1);
    expect(ran(spy, INVENTORY)).toBe(1);
  });

  it('leaves the first request nothing to build', async () => {
    answer();
    const url = await serve();
    await tick();
    const spy = watch();
    expect((await raw(url, '/api/state')).status).toBe(200);
    expect((await raw(url, '/api/projects')).status).toBe(200);
    expect(ran(spy, STATE)).toBe(0);
    expect(ran(spy, INVENTORY)).toBe(0);
  });

  it('is cancelled by close()', async () => {
    const spy = watch();
    const { close } = await startDashboard(db, { port: 0 });
    close();
    await tick();
    await tick();
    expect(spy).not.toHaveBeenCalled();
  });

  it('fails open on a database that has been closed', async () => {
    const url = await serve();
    db.close();
    // Reaching the end is the assertion: a throw in the warm build would be an uncaught exception.
    await tick();
    await tick();
    expect((await raw(url, '/api/health')).status).toBe(200);
  });

  it('fails open on a database that is busy, and the first request builds it instead', async () => {
    vi.spyOn(db, 'prepare').mockImplementation(() => {
      throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    });
    const url = await serve();
    await tick();
    await tick();
    expect((await raw(url, '/api/health')).status).toBe(200);
    vi.restoreAllMocks();
    expect((await raw(url, '/api/state')).status).toBe(200);
  });

  it('does not keep the process alive', async () => {
    const scheduled = vi.spyOn(globalThis, 'setImmediate');
    await serve();
    // The warm build is the one immediate that has been told it may be left behind.
    const timers = scheduled.mock.results.map((r) => r.value as NodeJS.Immediate);
    expect(timers.some((t) => !t.hasRef())).toBe(true);
  });
});

describe('what a browser may keep', () => {
  const SECURITY = ['content-security-policy', 'x-content-type-options', 'x-frame-options', 'referrer-policy'];

  it('keeps the tokens and the mascot for an hour, under the security headers', async () => {
    const url = await serve(db, startBuilt as never);
    for (const route of ['/tokens.css', '/brand/mascot/mascot.js', '/brand/mascot/mascot.css', '/mascot.html']) {
      const r = await raw(url, route);
      expect(r.status, route).toBe(200);
      expect(r.headers['cache-control'], route).toBe('private, max-age=3600');
      for (const h of SECURITY) expect(r.headers[h], `${route} ${h}`).toBeDefined();
    }
  });

  it('never caches what the learner changes', async () => {
    const url = await serve();
    for (const route of ['/api/state', '/api/projects', '/api/settings', '/api/memory', '/api/memory/sessions',
      '/api/cursor', '/api/health', '/api/feedback/list', '/manifest.webmanifest', '/nope']) {
      expect((await raw(url, route)).headers['cache-control'], route).toBe('no-store');
    }
  });

  describe('the page', () => {
    it('goes out with no-cache and a tag of what was sent, which carries this start\'s token', async () => {
      const url = await serve();
      const r = await raw(url, '/');
      expect(r.status).toBe(200);
      expect(r.headers['cache-control']).toBe('no-cache');
      expect(r.headers.etag).toMatch(/^"[0-9a-f]{32}"$/);
      expect(r.body.toString()).toMatch(/name="eklavya-token" content="[0-9a-f]{48}"/);
      expect((await raw(url, '/')).headers.etag).toBe(r.headers.etag);
      expect((await raw(url, '/index.html')).headers.etag).toBe(r.headers.etag);
    });

    it('answers a matching tag with a 304, no body and the security headers', async () => {
      const url = await serve();
      const { headers } = await raw(url, '/');
      for (const route of ['/', '/index.html']) {
        const r = await raw(url, route, { 'if-none-match': headers.etag });
        expect(r.status, route).toBe(304);
        expect(r.body.length, route).toBe(0);
        expect(r.headers.etag, route).toBe(headers.etag);
        expect(r.headers['cache-control'], route).toBe('no-cache');
        for (const h of SECURITY) expect(r.headers[h], `${route} ${h}`).toBeDefined();
      }
      expect((await raw(url, '/', { 'if-none-match': headers.etag }, 'HEAD')).status).toBe(304);
    });

    it('reads every legal shape of If-None-Match', async () => {
      const url = await serve();
      const tag = (await raw(url, '/')).headers.etag as string;
      const hit: (string | string[])[] = [
        tag, `W/${tag}`, ` ${tag} `, `"other", ${tag}`, `${tag},"other"`, `W/"other",W/${tag}`, '*', [`"other"`, tag],
      ];
      for (const value of hit) {
        expect((await raw(url, '/', { 'if-none-match': value })).status, JSON.stringify(value)).toBe(304);
      }
      const miss: string[] = ['"other"', 'W/"other"', tag.slice(1, -1), '', 'garbage', `"${tag.slice(1, -1)}x"`, '**'];
      for (const value of miss) {
        expect((await raw(url, '/', { 'if-none-match': value })).status, JSON.stringify(value)).toBe(200);
      }
    });

    it('is a different tag when the file on disk is edited, so a reload in development shows the edit', async () => {
      const url = await serve();
      const before = (await raw(url, '/')).headers.etag as string;
      const real = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathLike, ...rest: unknown[]) => {
        const text = (real as (...a: unknown[]) => unknown)(file, ...rest);
        return String(file).endsWith('dashboard.html') ? String(text).replace('</title>', ' (edited)</title>') : text;
      }) as never);
      const r = await raw(url, '/', { 'if-none-match': before });
      expect(r.status).toBe(200);
      expect(r.headers.etag).not.toBe(before);
      expect(r.body.toString()).toContain('(edited)</title>');
    });

    it('is a different tag after a restart, so an old page is replaced rather than revalidated', async () => {
      const first = await serve();
      const old = (await raw(first, '/')).headers.etag as string;
      const second = await serve();
      const r = await raw(second, '/', { 'if-none-match': old });
      expect(r.status).toBe(200);
      expect(r.headers.etag).not.toBe(old);
    });
  });
});

describe('etagMatches', () => {
  const tag = '"abc"';
  it('compares weakly, over a list, and treats * as any', () => {
    expect(etagMatches(undefined, tag)).toBe(false);
    expect(etagMatches('*', tag)).toBe(true);
    expect(etagMatches('  *  ', tag)).toBe(true);
    expect(etagMatches('"abc"', tag)).toBe(true);
    expect(etagMatches('W/"abc"', tag)).toBe(true);
    expect(etagMatches('"x", W/"y" , "abc"', tag)).toBe(true);
    expect(etagMatches('"x","y"', tag)).toBe(false);
    expect(etagMatches('abc', tag)).toBe(false);
    expect(etagMatches('', tag)).toBe(false);
    expect(etagMatches('"abcd"', tag)).toBe(false);
  });
});
