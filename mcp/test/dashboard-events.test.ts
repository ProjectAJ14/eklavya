/**
 * `GET /api/events`, the change cursor as a stream (issue #171, Phase 4, the
 * server half): what it sends and when, what watches while it is open and what
 * stops when it is not, every way the watching may fail, the writes that check
 * at once, and the bounds on how many streams it keeps.
 *
 * Writes from "another process" are made through a second connection to the
 * same database file, which is all a hook or the CLI is to this server. The
 * intervals are the route's own options, so a case runs in milliseconds; a case
 * that must not depend on `fs.watch` replaces it, and one that must not depend
 * on the floor makes the floor a minute. "Nothing is running" is read off what
 * the database is asked and which timers and watchers were made and released.
 * Every case pins EKLAVYA_HOME to a temporary directory.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  changeCursor, EVENTS_DEBOUNCE_MS, EVENTS_FLOOR_MS, EVENTS_KEEPALIVE_MS, EVENTS_MAX_STREAMS, LIVE_DEFAULTS, startDashboard,
  updateSetting, WRITES, type LiveOptions,
} from '../src/dashboard.js';
import { projectConfigPath } from '../src/paths.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let home = '';
let repo = '';
const saved = process.env.EKLAVYA_HOME;
const closers: (() => Promise<void>)[] = [];
const extraDbs: DB[] = [];
const clients: Stream[] = [];
/** What a browser's connection pool is: connections that stay open after a response. */
const keepAlive = new http.Agent({ keepAlive: true });

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-events-home-')));
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-events-repo-')));
  fs.mkdirSync(path.join(repo, '.git'));
  process.env.EKLAVYA_HOME = home;
  dbFile = tempDbPath('dashboard-events');
  db = openDb(dbFile);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients.splice(0)) c.end();
  keepAlive.destroy();
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const d of extraDbs.splice(0)) d.close();
  db.close();
  cleanup(dbFile);
  if (saved === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = saved;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `cond` holds; fails the case, with `what`, if it has not within `ms`. */
async function until(cond: () => boolean, what: string, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** The tools as a hook or the MCP server would call them, on the handle given: another process's connection, when it is a second one. */
const callOn = (d: DB, tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown>) =>
  tool.handler({ cwd: process.cwd(), ...args }, { db: d }) as any;
/** One answered question: the smallest write that moves the cursor the way a hook's would. */
function answer(d: DB = db, question = 'q', cwd?: string) {
  callOn(d, logSessionConcepts, { session_id: 'ev-s', concepts: [{ slug: 'csrf', context: 'chose SameSite=Lax' }], ...(cwd ? { cwd } : {}) });
  callOn(d, recordAttempt, { session_id: 'ev-s', slug: 'csrf', question, answer: 'a', grade: 4, difficulty: 2, ...(cwd ? { cwd } : {}) });
}
/** A second connection to the same file: what every other process on the machine is. */
function another(): DB {
  const d = openDb(dbFile);
  extraDbs.push(d);
  return d;
}

async function serve(live: Partial<LiveOptions> = {}, d: DB = db): Promise<string> {
  const { url, close } = await startDashboard(d, { port: 0, live });
  closers.push(close);
  return url;
}

/** One open event stream, read as the browser's `EventSource` would. */
interface Stream {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** Everything received, as sent. */
  text: () => string;
  /** The data of each `event: cursor`, in order. */
  cursors: () => string[];
  /** How many `: keep-alive` comments arrived. */
  comments: () => number;
  /** Resolves when the connection is over, from either end. */
  closed: Promise<void>;
  end: () => void;
}
function open(url: string, route = '/api/events', headers: http.OutgoingHttpHeaders = {}, pooled = false): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const u = new URL(url + route);
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname + u.search, headers, agent: pooled ? keepAlive : false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      // A stream the server cut surfaces here as a reset; the case reads it through `closed`.
      res.on('error', () => {});
      const closed = new Promise<void>((done) => res.on('close', () => done()));
      const stream: Stream = {
        status: res.statusCode ?? 0,
        headers: res.headers,
        text: () => text,
        cursors: () => [...text.matchAll(/^event: cursor\ndata: (.*)\n\n/gm)].map((m) => m[1]),
        comments: () => (text.match(/^: keep-alive\n\n/gm) ?? []).length,
        closed,
        end: () => req.destroy(),
      };
      clients.push(stream);
      resolve(stream);
    });
    req.on('error', reject);
  });
}
/** Opens a stream that must be a stream, and waits for its first event. */
async function stream(url: string): Promise<Stream> {
  const s = await open(url);
  expect(s.status).toBe(200);
  await until(() => s.cursors().length >= 1, 'the first event');
  return s;
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Buffer }
const raw = (url: string, route: string, headers: http.OutgoingHttpHeaders = {}, method = 'GET', body?: string): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const u = new URL(url + route);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
const json = (r: Reply): any => JSON.parse(r.body.toString('utf8'));

/** The page's write token and a POST that passes `acceptWrite`, as the page sends it. */
async function post(url: string, route: string, body: unknown): Promise<Reply> {
  const html = (await raw(url, '/')).body.toString('utf8');
  const token = /name="eklavya-token" content="([0-9a-f]+)"/.exec(html)![1];
  return raw(url, route, { origin: url, 'content-type': 'application/json', 'x-eklavya-token': token }, 'POST', JSON.stringify(body));
}

const CURSOR = /SELECT n FROM change_version/;
const STATE = /FROM concepts c\b/;
const watchDb = (d: DB = db) => vi.spyOn(d, 'prepare');
const reads = (spy: ReturnType<typeof watchDb>, re: RegExp = CURSOR) => spy.mock.calls.filter(([sql]) => re.test(String(sql))).length;

/** Every `fs.watch` the server makes, as a fake that never fires by itself: the case fires what it means to test. */
class FakeWatcher extends EventEmitter {
  close = vi.fn();
}
interface Watch {
  dir: string;
  opts: { persistent?: boolean; recursive?: boolean };
  fire: (name: string | null) => void;
  watcher: FakeWatcher;
}
function fakeWatch(): Watch[] {
  const made: Watch[] = [];
  vi.spyOn(fs, 'watch').mockImplementation(((dir: string, opts: Watch['opts'], listener: (event: string, name: string | null) => void) => {
    const watcher = new FakeWatcher();
    made.push({ dir: String(dir), opts, fire: (name) => listener('change', name), watcher });
    return watcher;
  }) as unknown as typeof fs.watch);
  return made;
}
/** `fs.watch` as a platform with none would have it. */
const brokenWatch = (code = 'ENOENT') =>
  vi.spyOn(fs, 'watch').mockImplementation((() => {
    throw Object.assign(new Error(`${code}: watch failed`), { code });
  }) as unknown as typeof fs.watch);

/** The server's own end of each event stream, in the order opened. */
function serverSide(): http.ServerResponse[] {
  const seen: http.ServerResponse[] = [];
  const real = http.ServerResponse.prototype.writeHead;
  vi.spyOn(http.ServerResponse.prototype, 'writeHead').mockImplementation(function (this: http.ServerResponse, ...args: unknown[]) {
    const headers = args[1] as Record<string, string> | undefined;
    if (String(headers?.['content-type']).startsWith('text/event-stream')) seen.push(this);
    return (real as (...a: unknown[]) => http.ServerResponse).apply(this, args);
  } as unknown as typeof http.ServerResponse.prototype.writeHead);
  return seen;
}

/** Slow enough that nothing in a case waits on it, and nothing in the real world would. */
const MINUTE = 60_000;
/** A floor and a debounce quick enough to see, and no early trigger a case does not mean to have. */
const FAST = { floorMs: 15, debounceMs: 15 };

describe('what the stream sends', () => {
  it('names its constants, and they are the contract', () => {
    expect(LIVE_DEFAULTS).toEqual({ floorMs: 1000, debounceMs: 150, keepAliveMs: 25_000, maxStreams: 32 });
    expect([EVENTS_FLOOR_MS, EVENTS_DEBOUNCE_MS, EVENTS_KEEPALIVE_MS, EVENTS_MAX_STREAMS]).toEqual([1000, 150, 25_000, 32]);
  });

  it('opens with the current cursor at once, in the event-stream format, behind the page\'s headers', async () => {
    answer();
    const url = await serve();
    const s = await open(url);
    expect(s.status).toBe(200);
    expect(s.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(s.headers['cache-control']).toBe('no-store');
    expect(s.headers['content-security-policy']).toContain("default-src 'self'");
    expect(s.headers['content-security-policy']).toContain("connect-src 'self'");
    expect(s.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(s.headers['x-content-type-options']).toBe('nosniff');
    expect(s.headers['x-frame-options']).toBe('DENY');
    expect(s.headers['referrer-policy']).toBe('no-referrer');

    await until(() => s.cursors().length === 1, 'the first event');
    // Exactly one event, a blank line after it, and nothing else yet.
    expect(s.text()).toBe(`event: cursor\ndata: ${changeCursor(db)}\n\n`);
    // The string `/api/state` carries, and `/api/cursor` serves.
    expect(json(await raw(url, '/api/state')).cursor).toBe(s.cursors()[0]);
    expect(json(await raw(url, '/api/cursor'))).toEqual({ cursor: s.cursors()[0] });
  });

  it('ignores a query string, as every route here does', async () => {
    const url = await serve();
    const s = await open(url, '/api/events?since=1');
    expect(s.status).toBe(200);
    await until(() => s.cursors().length === 1, 'the first event');
  });

  it('sends one more event when another process writes, and it is the new cursor', async () => {
    const url = await serve(FAST);
    const s = await stream(url);
    answer(another());
    await until(() => s.cursors().length === 2, 'the event for the write');
    expect(s.cursors()[1]).toBe(changeCursor(db));
    expect(s.cursors()[1]).not.toBe(s.cursors()[0]);
    // The page fetches what changed: it is a build the watcher has already made.
    expect(json(await raw(url, '/api/state')).cursor).toBe(s.cursors()[1]);
  });

  it('sends nothing when nothing changed, and never the same cursor twice in a row', async () => {
    const url = await serve(FAST);
    const s = await stream(url);
    await sleep(250);
    expect(s.cursors()).toHaveLength(1);

    // Reads, even of every payload, are not changes.
    await raw(url, '/api/state');
    await raw(url, '/api/projects');
    await sleep(100);
    expect(s.cursors()).toHaveLength(1);

    // One write: the floor, the file watch and the debounce all notice it, and it is told once.
    answer(another());
    await until(() => s.cursors().length === 2, 'the event for the write');
    await sleep(250);
    expect(s.cursors()).toHaveLength(2);
    answer(another(), 'second');
    await until(() => s.cursors().length === 3, 'the second event');
    await sleep(100);
    const all = s.cursors();
    expect(all).toHaveLength(3);
    for (let i = 1; i < all.length; i++) expect(all[i]).not.toBe(all[i - 1]);
  });

  it('keeps an idle stream alive with a comment, and the comment is not an event', async () => {
    const url = await serve({ floorMs: MINUTE, debounceMs: MINUTE, keepAliveMs: 20 });
    const s = await stream(url);
    await until(() => s.comments() >= 3, 'three keep-alives');
    expect(s.cursors()).toHaveLength(1);
    expect(s.text()).toMatch(/^event: cursor\ndata: .*\n\n(: keep-alive\n\n)+/);
  });

  it('tells a stream that connects while others are open only what they were told', async () => {
    // A change that lands between the floor's checks: the new stream's connect
    // is the first to see it, and the ones already open must hear it too, once.
    const url = await serve({ floorMs: MINUTE, debounceMs: MINUTE });
    const a = await stream(url);
    answer(another());
    const b = await stream(url);
    await until(() => a.cursors().length === 2, 'the open stream hears of the change');
    expect(b.cursors()).toEqual([changeCursor(db)]);
    expect(a.cursors()[1]).toBe(b.cursors()[0]);
    await sleep(50);
    expect(a.cursors()).toHaveLength(2);
    expect(b.cursors()).toHaveLength(1);
  });

  it('is on the default intervals when none are given, and an edit shows within two seconds', async () => {
    const url = await serve();
    const s = await stream(url);
    answer(another());
    await until(() => s.cursors().length === 2, 'the event for the write', 2000);
    expect(s.cursors()[1]).toBe(changeCursor(db));
  });
});

describe('the early trigger, on the real filesystem', () => {
  // The floor is a minute here, so only `fs.watch` can have produced the event.
  const EARLY = { floorMs: MINUTE, debounceMs: 20 };

  it('notices a write to the database through its -wal file', async () => {
    const url = await serve(EARLY);
    const s = await stream(url);
    answer(another());
    await until(() => s.cursors().length === 2, 'the event for the write', 3000);
    expect(s.cursors()[1]).toBe(changeCursor(db));
  });

  it('does not retrigger itself: its own reads of the database cause no check', async () => {
    const url = await serve(EARLY);
    await stream(url);
    const spy = watchDb();
    // The state is a build the memo may make, and a build is reads: ask for it first, then watch quiet.
    await raw(url, '/api/state');
    const before = reads(spy);
    await sleep(400);
    expect(reads(spy)).toBe(before);
  });

  it('notices the user config file changing', async () => {
    const url = await serve(EARLY);
    const s = await stream(url);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ cadence: 'end' }));
    await until(() => s.cursors().length === 2, 'the event for the config', 3000);
    expect(s.cursors()[1]).toBe(changeCursor(db));
  });

  it('notices a new artifact page', async () => {
    fs.mkdirSync(path.join(home, 'artifacts', 'p'), { recursive: true });
    const url = await serve(EARLY);
    const s = await stream(url);
    fs.writeFileSync(path.join(home, 'artifacts', 'p', 'x.html'), '<title>a new explainer</title>');
    await until(() => s.cursors().length === 2, 'the event for the page', 3000);
    expect(s.cursors()[1]).toBe(changeCursor(db));
  });

  it('notices a project\'s own config file changing', async () => {
    // A project that has answers: its settings file is in the cursor.
    answer(db, 'q', repo);
    fs.mkdirSync(path.dirname(projectConfigPath(repo)), { recursive: true });
    const url = await serve(EARLY);
    const s = await stream(url);
    expect(updateSetting(db, { scope: 'project', project: repo, key: 'cadence', value: 'end' }).status).toBe(200);
    await until(() => s.cursors().length === 2, 'the event for the project config', 3000);
    expect(s.cursors()[1]).toBe(changeCursor(db));
  });

  describe('keeps firing after a file is replaced, which is how every config write and most editors save', () => {
    // A temporary file renamed over the target. On Linux a recursive watch holds one watch per file
    // inode and so saw the first of these and never another: the floor is a minute here, so only the
    // early trigger can have told of the second and the third.
    const replace = (file: string, text: string, i: number) => {
      fs.writeFileSync(`${file}.tmp-${i}`, text);
      fs.renameSync(`${file}.tmp-${i}`, file);
    };

    it('a project\'s config file, rewritten three times by the write the dashboard and the CLI make', async () => {
      answer(db, 'q', repo);
      fs.mkdirSync(path.dirname(projectConfigPath(repo)), { recursive: true });
      const url = await serve(EARLY);
      const s = await stream(url);
      for (let i = 1; i <= 3; i++) {
        // Alternating values, so the cursor (a hash of the effective config) moves every time.
        expect(updateSetting(db, { scope: 'project', project: repo, key: 'cadence', value: i % 2 ? 'end' : 'as-you-go' }).status).toBe(200);
        await until(() => s.cursors().length === i + 1, `the event for rewrite ${i} of the project config`, 3000);
        expect(s.cursors()[i]).toBe(changeCursor(db));
      }
      // Four events in all, none the same as the one before it (the values alternate, so the cursor goes back and forth).
      expect(s.cursors()).toHaveLength(4);
      expect(s.cursors().every((cursor, i, all) => i === 0 || cursor !== all[i - 1])).toBe(true);
    });

    it('a project\'s config file that is plainly written over in place afterwards, too', async () => {
      answer(db, 'q', repo);
      const file = projectConfigPath(repo);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const url = await serve(EARLY);
      const s = await stream(url);
      replace(file, JSON.stringify({ project: repo, cadence: 'end' }), 1);
      await until(() => s.cursors().length === 2, 'the event for the replacement', 3000);
      fs.writeFileSync(file, JSON.stringify({ project: repo, cadence: 'as-you-go' }));
      await until(() => s.cursors().length === 3, 'the event for the write in place', 3000);
      expect(s.cursors()[2]).toBe(changeCursor(db));
    });

    it('an artifact page, replaced three times and then written in place', async () => {
      const page = path.join(home, 'artifacts', 'p', 'x.html');
      fs.mkdirSync(path.dirname(page), { recursive: true });
      fs.writeFileSync(page, '<title>first</title>');
      const url = await serve(EARLY);
      const s = await stream(url);
      for (let i = 1; i <= 3; i++) {
        // A different size each time: the cursor reads the folder's count, sizes and newest time.
        replace(page, `<title>replacement ${'x'.repeat(i * 7)}</title>`, i);
        await until(() => s.cursors().length === i + 1, `the event for replacement ${i} of the page`, 3000);
      }
      fs.writeFileSync(page, '<title>written in place, and longer than any before it</title>');
      await until(() => s.cursors().length === 5, 'the event for the write in place', 3000);
      expect(s.cursors()[4]).toBe(changeCursor(db));
    });

    it('a folder made after the stream opened, and the file written into it, and that file replaced again', async () => {
      answer(db, 'q', repo);
      fs.mkdirSync(path.join(home, 'projects'), { recursive: true });
      const url = await serve(EARLY);
      const s = await stream(url);
      const folder = path.dirname(projectConfigPath(repo));
      const watching = vi.spyOn(fs, 'watch');
      fs.mkdirSync(folder);
      await until(() => watching.mock.calls.some(([dir]) => String(dir) === folder), 'a watch on the new folder');

      expect(updateSetting(db, { scope: 'project', project: repo, key: 'cadence', value: 'end' }).status).toBe(200);
      await until(() => s.cursors().length === 2, 'the event for the first config written', 3000);
      expect(updateSetting(db, { scope: 'project', project: repo, key: 'cadence', value: 'as-you-go' }).status).toBe(200);
      await until(() => s.cursors().length === 3, 'the event for the config written over', 3000);
      expect(s.cursors()[2]).toBe(changeCursor(db));
    });
  });
});

describe('what it watches, and what it ignores', () => {
  const EARLY = { floorMs: MINUTE, debounceMs: 10 };

  /** How many cursor reads one file event leads to once the debounce has passed. */
  async function checks(fire: () => void): Promise<number> {
    const spy = watchDb();
    fire();
    await sleep(90);
    const n = reads(spy);
    spy.mockRestore();
    return n;
  }

  it('watches the database directory, the config directory, the project config area and the artifacts folder, and keeps none of them the process alive', async () => {
    const made = fakeWatch();
    await stream(await serve(EARLY));
    // None is recursive: a recursive watch on Linux stops seeing a file once it has been replaced.
    expect(made.map((w) => [w.dir, w.opts])).toEqual([
      [path.dirname(dbFile), { persistent: false, recursive: false }],
      [home, { persistent: false, recursive: false }],
      [path.join(home, 'projects'), { persistent: false, recursive: false }],
      [path.join(home, 'artifacts'), { persistent: false, recursive: false }],
    ]);
  });

  it('also watches each folder of the project config area and of the artifacts folder, on its own, and no other entry', async () => {
    for (const dir of ['projects/-tmp-a', 'projects/-tmp-b', 'artifacts/p', 'artifacts/.hidden']) fs.mkdirSync(path.join(home, dir), { recursive: true });
    fs.writeFileSync(path.join(home, 'artifacts', 'note.txt'), 'a file in the root is no folder');
    const made = fakeWatch();
    await stream(await serve(EARLY));
    const dirs = made.map((w) => w.dir);
    // A root, then its folders (in the order the directory lists them).
    expect(dirs.slice(0, 3)).toEqual([path.dirname(dbFile), home, path.join(home, 'projects')]);
    expect(dirs.slice(3, 5).sort()).toEqual([path.join(home, 'projects', '-tmp-a'), path.join(home, 'projects', '-tmp-b')]);
    expect(dirs.slice(5)).toEqual([path.join(home, 'artifacts'), path.join(home, 'artifacts', 'p')]);
    expect(made.every((w) => w.opts.recursive === false && w.opts.persistent === false)).toBe(true);
  });

  it('reacts to the -wal file by name and to nothing else in the database directory', async () => {
    const made = fakeWatch();
    await stream(await serve(EARLY));
    const dir = made[0];
    // The main file and -shm are touched by every reader: never a trigger.
    expect(await checks(() => dir.fire('knowledge.db'))).toBe(0);
    expect(await checks(() => dir.fire('knowledge.db-shm'))).toBe(0);
    expect(await checks(() => dir.fire('knowledge.db-journal'))).toBe(0);
    expect(await checks(() => dir.fire(null))).toBe(0);
    expect(await checks(() => dir.fire('knowledge.db-wal'))).toBe(1);
  });

  it('reacts to the config file by name and to nothing else in the home directory', async () => {
    const made = fakeWatch();
    await stream(await serve(EARLY));
    const dir = made[1];
    expect(await checks(() => dir.fire('knowledge.db-wal'))).toBe(0);
    expect(await checks(() => dir.fire('config.json.eklavya-bak'))).toBe(0);
    expect(await checks(() => dir.fire('dashboard.log'))).toBe(0);
    expect(await checks(() => dir.fire('config.json'))).toBe(1);
  });

  it('reacts to a project\'s config file and to no other file in the project folder', async () => {
    fs.mkdirSync(path.join(home, 'projects', '-tmp-repo'), { recursive: true });
    const made = fakeWatch();
    await stream(await serve(EARLY));
    const folder = made[3];
    expect(folder.dir).toBe(path.join(home, 'projects', '-tmp-repo'));
    // A platform that cannot name the file: nothing to match, and nothing thrown out of the watch's callback.
    expect(await checks(() => folder.fire(null))).toBe(0);
    expect(await checks(() => folder.fire('packs'))).toBe(0);
    expect(await checks(() => folder.fire('config.json.tmp-1234'))).toBe(0);
    expect(await checks(() => folder.fire('config.json'))).toBe(1);
  });

  it('reacts to any change in the project area itself, which is a folder made, renamed or removed', async () => {
    const made = fakeWatch();
    await stream(await serve(EARLY));
    const area = made[2];
    expect(area.dir).toBe(path.join(home, 'projects'));
    // The area lists what is there now whoever it names, so a platform that cannot name the entry is no worse off.
    expect(await checks(() => area.fire(null))).toBe(1);
    expect(await checks(() => area.fire('-tmp-repo'))).toBe(1);
  });

  it('reacts to anything in an artifacts folder, and to any change in the artifacts folder itself', async () => {
    fs.mkdirSync(path.join(home, 'artifacts', 'p'), { recursive: true });
    const made = fakeWatch();
    await stream(await serve(EARLY));
    const [root, folder] = [made[3], made[4]];
    expect([root.dir, folder.dir]).toEqual([path.join(home, 'artifacts'), path.join(home, 'artifacts', 'p')]);
    expect(await checks(() => folder.fire('x.html'))).toBe(1);
    expect(await checks(() => folder.fire('x.html.tmp-77'))).toBe(1);
    expect(await checks(() => folder.fire(null))).toBe(0);
    expect(await checks(() => root.fire('p'))).toBe(1);
  });

  it('watches a folder made after the stream opened, and drops the watch for one that went', async () => {
    const made = fakeWatch();
    await stream(await serve(EARLY));
    expect(made.map((w) => w.dir)).toEqual([path.dirname(dbFile), home, path.join(home, 'projects'), path.join(home, 'artifacts')]);
    const area = made[2];
    const folder = path.join(home, 'projects', '-tmp-new');

    // The folder appears, and the area says so: a watch is made for it, and the check also asked for
    // is what sees a file already written into it by the time the watch was made.
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'config.json'), '{}');
    expect(await checks(() => area.fire('-tmp-new'))).toBe(1);
    expect(made).toHaveLength(5);
    expect(made[4].dir).toBe(folder);
    expect(await checks(() => made[4].fire('config.json'))).toBe(1);

    // The same news again makes no second watch for it.
    await checks(() => area.fire('-tmp-new'));
    expect(made).toHaveLength(5);
    expect(made[4].watcher.close).not.toHaveBeenCalled();

    // The folder goes: its watch is closed, once, and nothing watches it any more.
    fs.rmSync(folder, { recursive: true });
    await checks(() => area.fire('-tmp-new'));
    expect(made[4].watcher.close).toHaveBeenCalledTimes(1);
    await checks(() => area.fire('-tmp-new'));
    expect(made[4].watcher.close).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(5);

    // And if it comes back, it is watched again, by a new watch.
    fs.mkdirSync(folder);
    await checks(() => area.fire('-tmp-new'));
    expect(made).toHaveLength(6);
    expect(made[5].dir).toBe(folder);
  });

  it('makes a new watch for a folder whose watch failed, once the area next reports', async () => {
    fs.mkdirSync(path.join(home, 'artifacts', 'p'), { recursive: true });
    const made = fakeWatch();
    await stream(await serve(EARLY));
    const [root, folder] = [made[3], made[4]];
    folder.watcher.emit('error', Object.assign(new Error('EPERM: watch lost'), { code: 'EPERM' }));
    expect(folder.watcher.close).toHaveBeenCalledTimes(1);
    expect(made).toHaveLength(5);

    await checks(() => root.fire('p'));
    // A new watch for the same folder, and the failed one is not closed a second time.
    expect(made).toHaveLength(6);
    expect(made[5].dir).toBe(folder.dir);
    expect(folder.watcher.close).toHaveBeenCalledTimes(1);
    expect(await checks(() => made[5].fire('x.html'))).toBe(1);
  });

  it('drops every folder watch of an area that has itself gone, and keeps the others', async () => {
    fs.mkdirSync(path.join(home, 'artifacts', 'p'), { recursive: true });
    fs.mkdirSync(path.join(home, 'artifacts', 'q'), { recursive: true });
    fs.mkdirSync(path.join(home, 'projects', '-tmp-repo'), { recursive: true });
    const made = fakeWatch();
    await stream(await serve(EARLY));
    expect(made.map((w) => w.dir)).toEqual(expect.arrayContaining([path.join(home, 'projects', '-tmp-repo')]));
    expect(made).toHaveLength(7);
    const closed = () => made.map((w) => w.watcher.close.mock.calls.length);
    // The artifacts folder cannot be listed any more.
    fs.rmSync(path.join(home, 'artifacts'), { recursive: true });
    await checks(() => made[4].fire('p'));
    expect(closed()).toEqual([0, 0, 0, 0, 0, 1, 1]);
  });

  it('turns a burst of file events into one check and one event', async () => {
    const made = fakeWatch();
    const url = await serve({ floorMs: MINUTE, debounceMs: 40 });
    const s = await stream(url);
    const writer = another();
    const spy = watchDb();
    // Eight writes land, and the watcher hears of each of them, three ways, in the same turn.
    for (let i = 0; i < 8; i++) {
      answer(writer, `burst-${i}`);
      made[0].fire('knowledge.db-wal');
      made[1].fire('config.json');
      made[3].fire('p/x.html');
    }
    await until(() => s.cursors().length === 2, 'the event for the burst');
    await sleep(120);
    expect(s.cursors()).toHaveLength(2);
    expect(s.cursors()[1]).toBe(changeCursor(db));
    // Twenty-four file events, one check: one rebuild of the state, and a handful of cursor
    // reads (the check's own and the rebuild's), not one per event.
    expect(reads(spy, STATE)).toBe(1);
    expect(reads(spy, CURSOR)).toBeLessThanOrEqual(4);
  });
});

describe('every way the watching can fail leaves the floor working', () => {
  it('runs on the floor alone when no watch can be made', async () => {
    const watch = brokenWatch('ENOENT');
    const url = await serve({ floorMs: 15, debounceMs: MINUTE });
    const s = await stream(url);
    // Every target was tried, none could be made, and the stream does not mind.
    expect(watch).toHaveBeenCalledTimes(4);
    answer(another());
    await until(() => s.cursors().length === 2, 'the event on the floor');
    expect(s.cursors()[1]).toBe(changeCursor(db));
  });

  /** `fs.watch` that refuses the directories `refuse` names (the platform's watch limit, a permission) and fakes the rest. */
  function watchRefusing(refuse: Set<string>): Watch[] {
    const made: Watch[] = [];
    vi.spyOn(fs, 'watch').mockImplementation(((dir: string, opts: Watch['opts'], listener: (e: string, n: string | null) => void) => {
      if (refuse.has(String(dir))) throw Object.assign(new Error('ENOSPC: no watch can be made here'), { code: 'ENOSPC' });
      const watcher = new FakeWatcher();
      made.push({ dir: String(dir), opts, fire: (n) => listener('change', n), watcher });
      return watcher;
    }) as unknown as typeof fs.watch);
    return made;
  }

  it('skips an area it cannot watch, folders and all, and keeps the others', async () => {
    fs.mkdirSync(path.join(home, 'projects', '-tmp-repo'), { recursive: true });
    fs.mkdirSync(path.join(home, 'artifacts', 'p'), { recursive: true });
    const made = watchRefusing(new Set([path.join(home, 'projects')]));
    const url = await serve({ floorMs: MINUTE, debounceMs: 10 });
    const s = await stream(url);
    // Not the project area, and none of its folders (without the area's own watch a new folder would go unseen).
    expect(made.map((w) => w.dir)).toEqual([path.dirname(dbFile), home, path.join(home, 'artifacts'), path.join(home, 'artifacts', 'p')]);
    // What it could watch still works.
    answer(another());
    made[0].fire('knowledge.db-wal');
    await until(() => s.cursors().length === 2, 'the event from the -wal watch');
  });

  it('skips a folder it cannot watch, and tries it again when its area next reports', async () => {
    fs.mkdirSync(path.join(home, 'artifacts', 'p'), { recursive: true });
    fs.mkdirSync(path.join(home, 'artifacts', 'q'), { recursive: true });
    const refuse = new Set([path.join(home, 'artifacts', 'p')]);
    const made = watchRefusing(refuse);
    await stream(await serve({ floorMs: MINUTE, debounceMs: 10 }));
    expect(made.map((w) => w.dir)).toEqual([path.dirname(dbFile), home, path.join(home, 'projects'), path.join(home, 'artifacts'), path.join(home, 'artifacts', 'q')]);

    // The limit is lifted: the area reports, and the folder that had none is watched, the one that had is not made twice.
    refuse.clear();
    made[3].fire('p');
    expect(made.map((w) => w.dir).slice(5)).toEqual([path.join(home, 'artifacts', 'p')]);
  });

  it('drops a watch that reports an error and goes on', async () => {
    const made = fakeWatch();
    const url = await serve({ floorMs: 15, debounceMs: MINUTE });
    const s = await stream(url);
    for (const w of made) w.watcher.emit('error', Object.assign(new Error('EPERM: watch lost'), { code: 'EPERM' }));
    expect(made.every((w) => w.watcher.close.mock.calls.length === 1)).toBe(true);
    // The error did not take the process, the stream or the floor with it.
    answer(another());
    await until(() => s.cursors().length === 2, 'the event on the floor');
  });

  it('survives a cursor that cannot be read on a check, and tells of the next change', async () => {
    const url = await serve({ floorMs: 15, debounceMs: MINUTE });
    const s = await stream(url);
    const real = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (CURSOR.test(sql)) throw new Error('SQLITE_BUSY: database is locked');
      return real(sql);
    }) as typeof db.prepare);
    const failed = reads(spy);
    await sleep(100);
    // Several checks failed, and the stream is open, and nothing was thrown out of a timer.
    expect(reads(spy)).toBeGreaterThan(failed);
    expect(s.cursors()).toHaveLength(1);
    spy.mockRestore();
    answer(another());
    await until(() => s.cursors().length === 2, 'the event once the database answers');
  });

  it('refuses a connect it cannot read the cursor for, as an ordinary 500, and starts nothing', async () => {
    const watch = fakeWatch();
    const timers = vi.spyOn(globalThis, 'setInterval');
    const url = await serve(FAST);
    const real = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (CURSOR.test(sql)) throw new Error('SQLITE_BUSY: database is locked');
      return real(sql);
    }) as typeof db.prepare);
    const timersBefore = timers.mock.calls.length;
    const r = await raw(url, '/api/events');
    expect(r.status).toBe(500);
    expect(r.headers['content-type']).toBe('text/plain');
    expect(r.body.toString()).toContain('database is locked');
    expect(watch).toHaveLength(0);
    expect(timers.mock.calls.length).toBe(timersBefore);
    spy.mockRestore();
    // Still serving.
    expect((await stream(url)).status).toBe(200);
  });

  it('still tells of a change when the memo cannot be rebuilt, and reports the error where it is asked for', async () => {
    const url = await serve(FAST);
    const s = await stream(url);
    const real = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (STATE.test(sql)) throw new Error('SQLITE_CORRUPT: the state cannot be built');
      return real(sql);
    }) as typeof db.prepare);
    answer(another());
    await until(() => s.cursors().length === 2, 'the event despite the failed refresh');
    const r = await raw(url, '/api/state');
    expect(r.status).toBe(500);
    expect(r.body.toString()).toContain('the state cannot be built');
  });
});

describe('the memo is refreshed before anyone is told', () => {
  it('builds the state, then writes the event, and the fetch that follows builds nothing', async () => {
    const url = await serve(FAST);
    const responses = serverSide();
    const s = await stream(url);
    const order: string[] = [];
    const real = db.prepare.bind(db);
    const prepared = vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
      if (STATE.test(sql)) order.push('build');
      return real(sql);
    }) as typeof db.prepare);
    const write = responses[0].write.bind(responses[0]);
    vi.spyOn(responses[0], 'write').mockImplementation(((chunk: string) => {
      if (String(chunk).startsWith('event: cursor')) order.push('event');
      return write(chunk);
    }) as typeof responses[0]['write']);

    answer(another());
    await until(() => s.cursors().length === 2, 'the event');
    expect(order).toEqual(['build', 'event']);

    prepared.mockClear();
    const state = json(await raw(url, '/api/state'));
    expect(reads(prepared, STATE)).toBe(0);
    expect(state.cursor).toBe(s.cursors()[1]);
  });
});

describe('the writes check at once', () => {
  it('a settings save is told to every open stream without waiting for the floor or the file watch', async () => {
    // Both are a minute away, so only the write itself can have produced these.
    const url = await serve({ floorMs: MINUTE, debounceMs: MINUTE });
    const a = await stream(url);
    const b = await stream(url);
    const saved = await post(url, '/api/settings', { scope: 'user', key: 'cadence', value: 'end' });
    expect(saved.status).toBe(200);
    await until(() => a.cursors().length === 2 && b.cursors().length === 2, 'both streams to hear of the save', 1500);
    expect(a.cursors()[1]).toBe(changeCursor(db));
    expect(b.cursors()[1]).toBe(a.cursors()[1]);
  });

  it('a write the handler refuses checks too, and a check that finds nothing says nothing', async () => {
    const url = await serve({ floorMs: MINUTE, debounceMs: MINUTE });
    const s = await stream(url);
    const spy = watchDb();
    const refused = await post(url, '/api/settings', { scope: 'user', key: 'no.such.key', value: 1 });
    expect(refused.status).toBe(400);
    expect(reads(spy)).toBe(1);
    await sleep(50);
    expect(s.cursors()).toHaveLength(1);
  });

  it('is exactly one cursor read per write with a stream open, and none with no stream open', async () => {
    const url = await serve({ floorMs: MINUTE, debounceMs: MINUTE });
    const watch = fakeWatch();
    // The warm build the server makes after it listens reads the cursor too: let it finish first.
    await sleep(60);
    // `/api/feedback/opened` reads no cursor of its own, so what is counted is the check.
    let spy = watchDb();
    expect((await post(url, '/api/feedback/opened', { via: 'direct' })).status).toBe(200);
    expect(reads(spy)).toBe(0);
    expect(watch).toHaveLength(0);
    spy.mockRestore();

    await stream(url);
    spy = watchDb();
    expect((await post(url, '/api/feedback/opened', { via: 'direct' })).status).toBe(200);
    expect(reads(spy)).toBe(1);
  });
});

describe('nothing runs without a stream', () => {
  it('has no timer and no watch until the first stream, shares them between streams, and releases every one after the last', async () => {
    const made = fakeWatch();
    const created = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const url = await serve(FAST);

    // Serving, reading and refusing are not streams.
    await raw(url, '/api/state');
    await raw(url, '/api/events', {}, 'POST');
    await raw(url, '/api/events', {}, 'HEAD');
    await raw(url, '/api/events', { host: 'evil.example' });
    expect(made).toHaveLength(0);
    expect(created).not.toHaveBeenCalled();

    const a = await stream(url);
    const b = await stream(url);
    // Two timers (the floor and the keep-alive) and four watches, once, whatever the number of streams.
    expect(created).toHaveBeenCalledTimes(2);
    expect(made).toHaveLength(4);

    // One goes: the other still has its floor.
    a.end();
    await sleep(80);
    const spy = watchDb();
    await sleep(80);
    expect(reads(spy)).toBeGreaterThan(0);
    expect(made.some((w) => w.watcher.close.mock.calls.length > 0)).toBe(false);
    spy.mockRestore();

    // The last goes: every timer is cleared and every watch closed.
    b.end();
    await until(() => made.every((w) => w.watcher.close.mock.calls.length === 1), 'every watch to be closed');
    const ids = created.mock.results.map((r) => r.value);
    for (const id of ids) expect(cleared.mock.calls.map(([c]) => c)).toContain(id);

    // And nothing asks the database anything any more.
    const quiet = watchDb();
    await sleep(120);
    expect(reads(quiet)).toBe(0);
    quiet.mockRestore();

    // The next stream starts it all again, from nothing.
    const c = await stream(url);
    expect(created).toHaveBeenCalledTimes(4);
    expect(made).toHaveLength(8);
    const again = watchDb();
    await sleep(80);
    expect(reads(again)).toBeGreaterThan(0);
    c.end();
  });

  it('does not run a check that was waiting on the debounce when the last stream went', async () => {
    const made = fakeWatch();
    const url = await serve({ floorMs: MINUTE, debounceMs: 60 });
    const s = await stream(url);
    answer(another());
    made[0].fire('knowledge.db-wal');
    s.end();
    await until(() => made.every((w) => w.watcher.close.mock.calls.length === 1), 'the watch to be released');
    const spy = watchDb();
    await sleep(150);
    expect(reads(spy)).toBe(0);
  });

  it('stops when the last stream errors, as when it closes', async () => {
    const made = fakeWatch();
    const url = await serve(FAST);
    const responses = serverSide();
    const a = await stream(url);
    const b = await stream(url);
    // A write to a dead socket can surface as an error on the response: it is cut, the other is not.
    responses[0].emit('error', Object.assign(new Error('write ECONNRESET'), { code: 'ECONNRESET' }));
    await a.closed;
    expect(made.some((w) => w.watcher.close.mock.calls.length > 0)).toBe(false);
    answer(another());
    await until(() => b.cursors().length === 2, 'the other stream to be told');
    expect(a.cursors()).toHaveLength(1);

    responses[1].emit('error', new Error('write EPIPE'));
    await b.closed;
    await until(() => made.every((w) => w.watcher.close.mock.calls.length === 1), 'the watch to be released');
  });
});

describe('a slow client does not hold the others', () => {
  it('cuts the stream that will not take a write and keeps telling the rest', async () => {
    const url = await serve(FAST);
    const responses = serverSide();
    const slow = await stream(url);
    const quick = await stream(url);
    // The slow reader's buffer is full: the write says so.
    vi.spyOn(responses[0], 'write').mockReturnValue(false);
    answer(another());
    await until(() => quick.cursors().length === 2, 'the quick stream to be told');
    await slow.closed;
    expect(slow.cursors()).toHaveLength(1);

    // And the watcher is still there for the one that remains.
    answer(another(), 'again');
    await until(() => quick.cursors().length === 3, 'the quick stream to be told again');
  });
});

describe('closing the server', () => {
  it('ends every open stream and resolves, with no timer or watch left, and again harmlessly', async () => {
    const made = fakeWatch();
    const { url, close } = await startDashboard(db, { port: 0, live: FAST });
    // One stream on a connection that would stay open, as a browser's does, and one that would not.
    const a = await open(url, '/api/events', {}, true);
    const b = await stream(url);
    await until(() => a.cursors().length === 1, 'the first event');

    // An open stream would hold the server open for ever: it resolves, in time, because the streams ended.
    await Promise.race([close(), sleep(3000).then(() => { throw new Error('close() did not resolve with streams open'); })]);
    await Promise.all([a.closed, b.closed]);
    expect(made.every((w) => w.watcher.close.mock.calls.length === 1)).toBe(true);
    // Not a truncated read: the stream was ended, not cut.
    expect(a.text().endsWith('\n\n')).toBe(true);

    const spy = watchDb();
    await sleep(100);
    expect(reads(spy)).toBe(0);
    await expect(raw(url, '/api/cursor')).rejects.toMatchObject({ code: 'ECONNREFUSED' });

    await expect(close()).resolves.toBeUndefined();
    await expect(close()).resolves.toBeUndefined();
  });

  it('resolves once the server has closed, so a request still being answered finishes first', async () => {
    const { url, close } = await startDashboard(db, { port: 0, live: FAST });
    const html = (await raw(url, '/')).body.toString('utf8');
    const token = /name="eklavya-token" content="([0-9a-f]+)"/.exec(html)![1];
    const u = new URL(url);
    // A write whose body has not all arrived: the server is waiting on the rest of it.
    const req = http.request({
      host: u.hostname, port: u.port, path: '/api/settings', method: 'POST', agent: false,
      headers: { origin: url, 'content-type': 'application/json', 'x-eklavya-token': token, 'content-length': '2' },
    });
    const status = new Promise<number>((resolve, reject) => {
      req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
      req.on('error', reject);
    });
    req.write('{');
    await sleep(50);

    let closed = false;
    const closing = close().then(() => { closed = true; });
    await sleep(100);
    expect(closed).toBe(false);
    req.end('}');
    await closing;
    // `{}` names no scope: the handler's own 400, answered in full before the server let go.
    expect(await status).toBe(400);
  });

  it('resolves with no stream ever opened, and with the warm build still pending', async () => {
    const { close } = await startDashboard(db, { port: 0, live: FAST });
    await expect(close()).resolves.toBeUndefined();
  });

  it('opens no stream for a request that was already on a connection when it closed, and does not hold the close open', async () => {
    const made = fakeWatch();
    const timers = vi.spyOn(globalThis, 'setInterval');
    const { url, close } = await startDashboard(db, { port: 0, live: FAST });
    const html = (await raw(url, '/')).body.toString('utf8');
    const token = /name="eklavya-token" content="([0-9a-f]+)"/.exec(html)![1];
    const port = Number(new URL(url).port);

    // A write whose body has not all arrived: the connection is mid-request when close() runs.
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    socket.on('data', (chunk) => (received += chunk));
    socket.on('error', () => {});
    const over = new Promise<void>((done) => socket.on('close', () => done()));
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(
      `POST /api/settings HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: ${url}\r\nContent-Type: application/json\r\n` +
        `X-Eklavya-Token: ${token}\r\nContent-Length: 2\r\n\r\n{`,
    );
    await sleep(50);

    let closed = false;
    const closing = close().then(() => { closed = true; });
    await sleep(50);
    expect(closed).toBe(false);

    // The rest of the body, and the next request on the same connection, in one chunk.
    const timersBefore = timers.mock.calls.length;
    socket.write(`}GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    await Promise.race([over, sleep(3000).then(() => { throw new Error('the connection was held open'); })]);
    await Promise.race([closing, sleep(3000).then(() => { throw new Error('close() did not resolve'); })]);

    // The write was answered in full, and the stream was refused: said so, and nothing was started for it.
    expect(received).toMatch(/^HTTP\/1\.1 400 /);
    const refusal = received.slice(received.indexOf('HTTP/1.1', 8));
    expect(refusal).toMatch(/^HTTP\/1\.1 503 /);
    expect(refusal).toMatch(/connection: close/i);
    expect(refusal).toContain('The dashboard is shutting down.');
    expect(received).not.toContain('text/event-stream');
    expect(made).toHaveLength(0);
    expect(timers.mock.calls.length).toBe(timersBefore);
    expect(closed).toBe(true);
  });
});

describe('how many streams it keeps', () => {
  it('refuses the stream over the cap with a 503 and a plain-text reason, and takes one again when a stream goes', async () => {
    const url = await serve({ ...FAST, maxStreams: 2 });
    const a = await stream(url);
    await stream(url);

    const refused = await raw(url, '/api/events');
    expect(refused.status).toBe(503);
    expect(refused.headers['content-type']).toBe('text/plain');
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.headers['x-content-type-options']).toBe('nosniff');
    expect(refused.body.toString()).toBe('Too many open event streams.\n');

    // The refused one cost nothing: the two open still work.
    answer(another());
    await until(() => a.cursors().length === 2, 'an open stream to be told');

    a.end();
    // The server notices the close in its own time: ask until it has room.
    let status = 503;
    for (let i = 0; i < 200 && status !== 200; i++) {
      status = (await open(url)).status;
      if (status !== 200) await sleep(10);
    }
    expect(status).toBe(200);
  });

  it('is thirty-two by default', async () => {
    const url = await serve({ floorMs: MINUTE, debounceMs: MINUTE, keepAliveMs: MINUTE });
    const open32 = await Promise.all(Array.from({ length: EVENTS_MAX_STREAMS }, () => open(url)));
    expect(open32.every((s) => s.status === 200)).toBe(true);
    expect((await raw(url, '/api/events')).status).toBe(503);
  });
});

describe('it is one more read route behind the same handler', () => {
  it('answers 403 to a Host that is not loopback, and to a cross-origin Origin, and opens nothing', async () => {
    const watch = fakeWatch();
    const url = await serve(FAST);
    const rebound = await raw(url, '/api/events', { host: 'evil.example' });
    expect(rebound.status).toBe(403);
    expect(rebound.body.toString()).toContain('loopback');
    expect(rebound.headers['content-type']).toBe('text/plain');

    const foreign = await raw(url, '/api/events', { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(watch).toHaveLength(0);

    // A loopback Origin, as a page on another local port sends, is the same as any other read.
    const s = await open(url, '/api/events', { origin: 'http://localhost:3000' });
    expect(s.status).toBe(200);
  });

  it('is GET only: any other method is a 405 that says so, and a HEAD opens nothing', async () => {
    const watch = fakeWatch();
    const url = await serve(FAST);
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await raw(url, '/api/events', {}, method);
      expect(r.status, method).toBe(405);
      expect(r.headers.allow, method).toBe('GET');
      expect(r.body.toString(), method).toContain('read-only');
      expect(r.headers['content-security-policy'], method).toContain("default-src 'self'");
    }
    // A HEAD has no stream to open: it is answered as it always was for this path, and returns.
    const head = await raw(url, '/api/events', {}, 'HEAD');
    expect(head.status).toBe(404);
    expect(head.headers['content-type']).toBe('text/plain');
    expect(head.body).toHaveLength(0);
    // Not a route by prefix or by case.
    expect((await raw(url, '/api/events/')).status).toBe(404);
    expect((await raw(url, '/api/Events')).status).toBe(404);
    expect(watch).toHaveLength(0);
  });

  it('leaves every other route\'s 405 as it was', async () => {
    const url = await serve(FAST);
    const read = await raw(url, '/api/state', {}, 'POST');
    expect(read.status).toBe(405);
    expect(read.headers.allow).toBe('GET, HEAD');
    expect(read.body.toString()).toBe(`This route is read-only. Writes: ${Object.keys(WRITES).join(', ')}.\n`);
    const write = await raw(url, '/api/settings', {}, 'PUT');
    expect(write.status).toBe(405);
    expect(write.headers.allow).toBe('GET, HEAD, POST');
    // A HEAD of an ordinary read is still answered as a GET without a body.
    const head = await raw(url, '/api/cursor', {}, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toHaveLength(0);
  });

  it('leaves /api/cursor and /api/health as they were while a stream is open', async () => {
    const url = await serve(FAST);
    const s = await stream(url);
    expect(json(await raw(url, '/api/cursor'))).toEqual({ cursor: s.cursors()[0] });
    expect(json(await raw(url, '/api/health')).app).toBe('eklavya');
  });
});

describe('a database with no file', () => {
  it('has no -wal to watch, and the floor carries it', async () => {
    const memory = openDb(':memory:');
    extraDbs.push(memory);
    const made = fakeWatch();
    const url = await serve({ floorMs: 15, debounceMs: MINUTE }, memory);
    const s = await stream(url);
    expect(made.map((w) => w.dir)).toEqual([home, path.join(home, 'projects'), path.join(home, 'artifacts')]);
    answer(memory);
    await until(() => s.cursors().length === 2, 'the event on the floor');
    expect(s.cursors()[1]).toBe(changeCursor(memory));
  });
});
