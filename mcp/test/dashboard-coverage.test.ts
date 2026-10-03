/**
 * The dashboard's edge rows and failure paths: shapes the fixture never
 * produces (rows written by older versions, hand edits, a deleted cwd) and the
 * write route's refusals. Every case pins EKLAVYA_HOME, so no real config is read.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  dashboardState, memoryEntry, memorySessionPage, projectInventory, settingsState, updateSetting,
  startDashboard, openInBrowser,
  retryAttempt,
} from '../src/dashboard.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { conceptBySlug } from '../src/store.js';
import { appendEvent, insertEntry, supersedeEntry } from '../src/memory/store.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let tmp = '';
const saved = { home: process.env.EKLAVYA_HOME, port: process.env.EKLAVYA_DASHBOARD_PORT, path: process.env.PATH };

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-dash-cov-')));
  process.env.EKLAVYA_HOME = path.join(tmp, 'home');
  dbFile = tempDbPath('dashboard-cov');
  db = openDb(dbFile);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of [['EKLAVYA_HOME', saved.home], ['EKLAVYA_DASHBOARD_PORT', saved.port], ['PATH', saved.path]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  db.close();
  cleanup(dbFile);
  fs.rmSync(tmp, { recursive: true, force: true });
});

const id = (slug: string) => conceptBySlug(db, slug)!.id;
const attempt = (slug: string, grade: number, extra: { repo?: string | null; ts?: string; session?: string } = {}) =>
  db.prepare('INSERT INTO attempts (concept_id, session_id, question, grade, difficulty, repo, ts) VALUES (?, ?, ?, ?, 1, ?, ?)')
    .run(id(slug), extra.session ?? 'cov-s', 'q', grade, extra.repo ?? null, extra.ts ?? new Date().toISOString());

describe('dashboardState on rows the tools never write', () => {
  it('opens with the default settings when the working directory is gone', () => {
    vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw Object.assign(new Error('ENOENT: uv_cwd'), { code: 'ENOENT' });
    });
    const s = dashboardState(db) as any;
    expect(s.config.cadence).toBe(DEFAULT_CONFIG.cadence);
    expect(s.config.focus).toBe(DEFAULT_CONFIG.focus);
  });

  it('names configured providers by kind and model only', () => {
    fs.mkdirSync(process.env.EKLAVYA_HOME!, { recursive: true });
    fs.writeFileSync(
      path.join(process.env.EKLAVYA_HOME!, 'config.json'),
      JSON.stringify({
        providers: {
          observer: { kind: 'anthropic', model: 'haiku' },
          embeddings: { kind: 'anthropic', model: 'claude-haiku', api_key_env: 'SECRET' },
        },
      }),
    );
    const s = dashboardState(db) as any;
    expect(s.health.providers.observer).toEqual({ kind: 'anthropic', model: 'haiku' });
    expect(s.health.providers.embeddings).toEqual({ kind: 'anthropic', model: 'claude-haiku' });
    expect(JSON.stringify(s.health.providers)).not.toContain('SECRET');
  });

  it('reads a concept answered with no mastery row, and an overdue date it cannot count', () => {
    attempt('csrf', 1);
    // A review date `Date.parse` reads but the dashboard's UTC parser does not.
    db.prepare('INSERT INTO mastery (concept_id, score, reps, next_review) VALUES (?, 0.2, 1, ?)').run(id('pkce'), '2020/01/01 10:00');
    attempt('pkce', 1);
    const s = dashboardState(db) as any;
    const csrf = s.concepts.find((c: any) => c.slug === 'csrf');
    expect(csrf).toMatchObject({ seen: true, reps: 0, owed: true, due: false, overdue_days: null });
    const pkce = s.concepts.find((c: any) => c.slug === 'pkce');
    expect(pkce).toMatchObject({ due: true, overdue_days: null });
  });

  it('skips an edge whose concept no longer exists', () => {
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO edges (from_concept, to_concept, relation) VALUES (?, 999999, 'related_to')").run(id('csrf'));
    const csrf = (dashboardState(db) as any).concepts.find((c: any) => c.slug === 'csrf');
    expect(csrf.related).not.toContain(undefined);
  });
});

describe('projectInventory on odd rows', () => {
  it('keeps unparseable and blank timestamps out of the activity span, names the root, and sorts idle projects by name', () => {
    attempt('csrf', 4, { repo: '/', ts: 'not a time' });
    attempt('pkce', 4, { repo: '/', ts: '' });
    db.prepare('INSERT INTO session_concepts (session_id, concept_id, origin) VALUES (?, ?, NULL)').run('legacy-s', id('csrf'));
    db.prepare("INSERT INTO project_levels (repo) VALUES ('/zz/beta'), ('/zz/alpha')").run();

    const { projects } = projectInventory(db);
    const root = projects.find((p) => p.id === '/')!;
    expect(root.name).toBe('/');
    expect(root.learning.first).toBeNull();
    expect(root.learning.answers).toBe(2);
    // The NULL-origin row counts as work, as a row from before origins were stored.
    const unattributed = projects.find((p) => p.kind === 'unattributed')!;
    expect(unattributed.learning.logged_concepts).toBe(1);
    const idle = projects.filter((p) => p.sources.join() === 'levels');
    expect(idle.map((p) => p.name)).toEqual(['alpha', 'beta']);
    expect(idle.every((p) => p.first_active === null && p.last_active === null)).toBe(true);
  });
});

describe('memory reads', () => {
  it('pages sessions with and without a filter', () => {
    const project = path.join(tmp, 'proj');
    for (const s of ['a', 'b', 'c']) {
      appendEvent(db, { eventUid: `ev-${s}`, project, sessionId: s, kind: 'tool_use', tool: 'Edit', title: 't', body: 'b' });
    }
    appendEvent(db, { eventUid: 'ev-other', project: path.join(tmp, 'other'), sessionId: 'x', kind: 'tool_use', tool: 'Edit', title: 't', body: 'b' });
    expect(memorySessionPage(db)).toMatchObject({ total: 4, page: 1, pages: 1 });
    const filtered = memorySessionPage(db, { project, per: 2, page: 2 }) as any;
    expect(filtered).toMatchObject({ total: 3, page: 2, pages: 2, per: 2 });
    expect(filtered.rows).toHaveLength(1);
  });

  it('links a superseded entry to its replacement', () => {
    const base = { project: tmp, sessionId: 's', narrative: 'n' };
    const stale = insertEntry(db, { ...base, title: 'old claim' });
    const fresh = insertEntry(db, { ...base, title: 'correction' });
    supersedeEntry(db, stale, fresh);
    expect((memoryEntry(db, stale) as any).replaced_by).toMatchObject({ id: fresh, title: 'correction' });
    expect((memoryEntry(db, fresh) as any).replaces).toEqual([expect.objectContaining({ id: stale })]);
  });
});

describe('settings', () => {
  it('reports no project for a root it cannot configure', () => {
    expect(settingsState(db, path.join(tmp, 'nowhere')).project).toBeNull();
  });

  it('refuses a body that is not an object, and a set with no value', () => {
    for (const body of [null, [], 'text']) {
      expect(updateSetting(db, body)).toEqual({ status: 400, body: { error: 'Expected a JSON object.' } });
    }
    expect(updateSetting(db, { scope: 'user', key: 'quiz.enabled' })).toEqual({
      status: 400, body: { error: 'Send a value, or unset: true.' },
    });
  });

  it('reports a write failure that is not an Error in its own words', () => {
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw 'disk said no';
    });
    expect(updateSetting(db, { scope: 'user', key: 'quiet', value: true })).toEqual({
      status: 400, body: { error: 'disk said no' },
    });
  });
});

describe('openInBrowser', () => {
  const waitFor = async (file: string) => {
    // Up to 5s: under the full suite, with the browser tests running beside it, spawning sh can take over 2.
    for (let i = 0; i < 250 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 20));
    // The opener writes the line and exits; give the write a moment to land whole.
    for (let i = 0; i < 20 && !fs.readFileSync(file, 'utf8').endsWith('\n'); i++) await new Promise((r) => setTimeout(r, 20));
    return fs.readFileSync(file, 'utf8');
  };

  it.skipIf(process.platform === 'win32')('hands the URL to the platform opener', async () => {
    const bin = path.join(tmp, 'bin');
    const out = path.join(tmp, 'opened.txt');
    fs.mkdirSync(bin);
    for (const name of ['open', 'xdg-open']) {
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$1" > ${JSON.stringify(out)}\n`, { mode: 0o755 });
    }
    process.env.PATH = `${bin}${path.delimiter}${saved.path}`;
    openInBrowser('http://127.0.0.1:1/x');
    expect(await waitFor(out)).toBe('http://127.0.0.1:1/x\n');
  });

  it('stays silent when there is no opener, or the URL cannot be handed over', async () => {
    process.env.PATH = path.join(tmp, 'empty');
    expect(() => openInBrowser('http://127.0.0.1:1/')).not.toThrow();
    // A NUL cannot be passed as an argument: spawn throws synchronously.
    expect(() => openInBrowser('http://127.0.0.1:1/\0')).not.toThrow();
    // The ENOENT arrives as an 'error' event; an unhandled one would fail the run.
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe('startDashboard', () => {
  const request = (
    port: number,
    opts: { path?: string; method?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean },
  ) =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: opts.path ?? '/', method: opts.method ?? 'GET', headers: opts.headers },
        (res) => {
          let text = '';
          res.on('data', (c) => (text += String(c)));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
        },
      );
      req.on('error', reject);
      if (opts.chunked) req.setHeader('transfer-encoding', 'chunked');
      req.end(opts.body);
    });

  async function withServer(d: DB, fn: (port: number, token: string) => Promise<void>) {
    const { url, close } = await startDashboard(d, { port: 0 });
    try {
      const port = Number(new URL(url).port);
      const html = (await request(port, {})).text;
      await fn(port, /name="eklavya-token" content="([0-9a-f]*)"/.exec(html)?.[1] ?? '');
    } finally {
      close();
    }
  }

  it('says who is serving on /api/health', async () => {
    await withServer(db, async (port) => {
      const res = await request(port, { path: '/api/health' });
      expect(res.status).toBe(200);
      expect(JSON.parse(res.text)).toMatchObject({ app: 'eklavya', pid: process.pid });
    });
  });

  it('answers 500 with the message when a read fails, and a generic one for a non-Error', async () => {
    const failing = (thrown: unknown) => ({ prepare: () => { throw thrown; } }) as unknown as DB;
    await withServer(failing(new Error('database is gone')), async (port) => {
      expect(await request(port, { path: '/api/state' })).toEqual({ status: 500, text: 'database is gone' });
    });
    await withServer(failing('odd'), async (port) => {
      expect(await request(port, { path: '/api/state' })).toEqual({ status: 500, text: 'error' });
    });
  });

  it('refuses a settings write with no content type, no token, bad JSON, or a body over the limit', async () => {
    await withServer(db, async (port, token) => {
      const origin = `http://127.0.0.1:${port}`;
      const post = (headers: Record<string, string>, body?: string | Buffer, chunked = false) =>
        request(port, { path: '/api/settings', method: 'POST', headers: { origin, ...headers }, body, chunked });

      expect((await post({ 'x-eklavya-token': token }, '{}')).status).toBe(415);
      expect((await post({ 'content-type': 'application/json' }, '{}')).status).toBe(403);
      const json = { 'content-type': 'application/json', 'x-eklavya-token': token };
      const bad = await post(json, '{not json');
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.text).error).toBe('Not valid JSON.');
      // No content-length to refuse up front: the limit is enforced while reading.
      const big = await post(json, Buffer.alloc(256 * 1024 + 1, 'a'), true);
      expect(big.status).toBe(413);
      expect(JSON.parse(big.text).error).toBe('Request too large.');
    });
  });

  it('falls back to a free port when the configured one is taken', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const taken = (blocker.address() as net.AddressInfo).port;
    process.env.EKLAVYA_DASHBOARD_PORT = String(taken);
    try {
      const { url, close } = await startDashboard(db);
      close();
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(Number(new URL(url).port)).not.toBe(taken);
    } finally {
      blocker.close();
    }
  });
});

describe('retryAttempt', () => {
  it('lets a database failure surface instead of dressing it as a refusal', () => {
    const file = tempDbPath('retry-closed');
    const other = openDb(file);
    other.close();
    expect(() => retryAttempt(other, { attempt_id: 1, picked: 'x' })).toThrow(/not open/);
    cleanup(file);
  });
});
