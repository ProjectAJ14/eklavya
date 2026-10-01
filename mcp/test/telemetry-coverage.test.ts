import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import {
  countCommand, countUse, installId, readState, startBackgroundTelemetry, statePath, writeState,
} from '../src/telemetry.js';
import { assertSafe, buildEvents, post, sendNow, sendOne, type TelemetryEvent } from '../src/telemetry-send.js';
import { createArtifact } from '../src/artifacts.js';

const ENV = ['EKLAVYA_HOME', 'EKLAVYA_DB', 'EKLAVYA_TELEMETRY', 'DO_NOT_TRACK', 'CI', 'EKLAVYA_RUNTIME'] as const;
const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
let tmp = '';
let home = '';
let db: DB;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-telemetry-cov-'));
  home = path.join(tmp, 'home');
  process.env.EKLAVYA_HOME = home;
  process.env.EKLAVYA_DB = path.join(home, 'knowledge.db');
  delete process.env.EKLAVYA_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  db = openDb();
});

afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** An installed runtime, outside CI: the one place a ping can go out. */
function installed(): void {
  delete process.env.CI;
  delete process.env.EKLAVYA_RUNTIME;
  const pkg = path.join(home, 'runtime', 'node_modules', 'eklavya');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"version": "9.9.9"}');
}

/** Answers every POST with `ok`, recording the bodies. No network. */
function stubFetch(ok = true): { url: string; body: any }[] {
  const calls: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok } as Response;
  });
  return calls;
}

/** Stands in for a database of any shape: every statement answers the same way. */
function fakeDb(get: () => unknown, all: () => unknown[] = () => []): DB {
  return { prepare: () => ({ get, all, run: () => ({}) }) } as unknown as DB;
}

describe('telemetry state', () => {
  it('reads a state file holding something other than an object as empty', () => {
    fs.writeFileSync(statePath(), 'null');
    expect(readState()).toEqual({});
  });

  it('loses a write it cannot make instead of throwing', () => {
    process.env.EKLAVYA_HOME = path.join(tmp, 'a-file');
    fs.writeFileSync(process.env.EKLAVYA_HOME, '');
    expect(() => writeState({ sent_at: 'x' })).not.toThrow();
    expect(readState()).toEqual({});
  });

  it('makes one install id and keeps it', () => {
    const id = installId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readState().created_at).toBeTruthy();
    expect(installId()).toBe(id);
  });
});

describe('startBackgroundTelemetry', () => {
  const now = Date.parse('2026-09-24T10:00:00Z');

  it('records nothing when the ping is off', () => {
    process.env.DO_NOT_TRACK = '1';
    startBackgroundTelemetry(now);
    expect(fs.existsSync(statePath())).toBe(false);
  });

  it('records the day once, and does not send twice on the day a ping went out', () => {
    installed();
    writeState({ announced_at: new Date(now).toISOString(), sent_at: new Date(now - 3_600_000).toISOString() });
    startBackgroundTelemetry(now);
    startBackgroundTelemetry(now);
    expect(readState().active_days).toEqual(['2026-09-24']);
    expect(readState().attempt_at).toBeUndefined();
  });

  it('sends the day after the last ping', () => {
    installed();
    writeState({ announced_at: new Date(now).toISOString(), sent_at: new Date(now - 86_400_000).toISOString() });
    startBackgroundTelemetry(now);
    expect(readState().attempt_at).toBe(new Date(now).toISOString());
  });

  it('swallows a failure rather than cost the session start', () => {
    expect(() => startBackgroundTelemetry(NaN)).not.toThrow();
  });
});

describe('countCommand', () => {
  const counted = () => db.prepare('SELECT name, n FROM usage_counts').all();

  it('counts into the database as it is', () => {
    countCommand('cli:doctor');
    expect(counted()).toEqual([{ name: 'cli:doctor', n: 1 }]);
  });

  it('counts nothing when off, when there is no database, or when it cannot be opened', () => {
    process.env.EKLAVYA_TELEMETRY = 'off';
    countCommand('cli:doctor');
    delete process.env.EKLAVYA_TELEMETRY;
    process.env.EKLAVYA_DB = path.join(tmp, 'missing.db');
    countCommand('cli:doctor');
    expect(fs.existsSync(process.env.EKLAVYA_DB)).toBe(false);
    process.env.EKLAVYA_DB = tmp; // a directory: exists, cannot be opened
    expect(() => countCommand('cli:doctor')).not.toThrow();
    expect(counted()).toEqual([]);
  });

  it('skips a count on a database without the table', () => {
    const bare = new Database(':memory:');
    expect(() => countUse(bare, 'cli:doctor')).not.toThrow();
    bare.close();
  });
});

describe('buildEvents', () => {
  const params = (events: TelemetryEvent[], name: string) => events.find((e) => e.name === name)!.params;

  it('counts project settings, without reading anything but the flags', () => {
    const projects = path.join(home, 'projects');
    const put = (name: string, body?: string) => {
      fs.mkdirSync(path.join(projects, name), { recursive: true });
      if (body !== undefined) fs.writeFileSync(path.join(projects, name, 'config.json'), body);
    };
    put('empty', '{}');
    put('quiet', '{"quiz": {"enabled": false}}');
    put('legacy', '{"mode": "off"}');
    put('nomem', '{"memory": {"enabled": false}}');
    put('unset');
    put('broken', '{not json');
    fs.writeFileSync(path.join(projects, 'stray-file'), '');
    const settings = params(buildEvents(db), 'settings');
    expect(settings).toMatchObject({
      project_configs: 4, projects_quiz_off: 2, projects_memory_off: 1, projects_with_settings: 3,
    });
  });

  it('counts artifacts and explainers, new since the last ping and in total', () => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'proj-'));
    createArtifact({ title: 'Old page', cwd, now: new Date('2000-01-01T00:00:00Z') });
    createArtifact({ title: 'New page', cwd });
    createArtifact({ title: 'Why', kind: 'explainer', cwd });
    createArtifact({ title: 'Old why', kind: 'explainer', cwd, now: new Date('2000-01-01T00:00:00Z') });
    expect(params(buildEvents(db), 'artifacts')).toEqual({
      artifacts_total: 2, artifacts_new: 1, explainers_total: 2, explainers_new: 1,
    });
  });

  it('names the providers, the update error and the install age from state', () => {
    fs.writeFileSync(
      path.join(home, 'config.json'),
      JSON.stringify({ providers: { observer: { kind: 'anthropic', model: 'haiku' }, embeddings: { kind: 'anthropic', model: 'x' } } }),
    );
    fs.writeFileSync(path.join(home, 'update.json'), '{"error": "npm view failed"}');
    const now = Date.parse('2026-09-24T10:00:00Z');
    const events = buildEvents(db, now, { created_at: '2026-09-14T10:00:00Z', active_days: ['2026-09-24', '2026-09-01'] });
    expect(params(events, 'daily_active')).toMatchObject({ install_age_days: 10, active_days_7d: 1, update_error: 'other' });
    expect(params(events, 'settings')).toMatchObject({ observer: 'anthropic', embeddings: 'anthropic' });

    fs.writeFileSync(path.join(home, 'update.json'), '{"error": "offline", "error_class": "network"}');
    expect(params(buildEvents(db, now), 'daily_active').update_error).toBe('network');
  });

  it('reports a feature with no kind under its own name', () => {
    db.prepare("INSERT INTO usage_counts (day, name, n) VALUES ('2000-01-01', 'bare', 3)").run();
    expect(buildEvents(db)).toContainEqual({ name: 'feature_use', params: { kind: 'bare', feature: 'bare', count: 3 } });
  });

  it('reads zero for a count it cannot read, and a database size it cannot stat', () => {
    process.env.EKLAVYA_DB = path.join(tmp, 'nowhere.db');
    const none = buildEvents(fakeDb(() => undefined));
    expect(params(none, 'learning').questions_total).toBe(0);
    expect(params(none, 'memory').db_mb).toBe(0);
    expect(none.some((e) => e.name === 'feature_use')).toBe(false);

    const text = buildEvents(fakeDb(() => ({ n: '7' }), () => { throw new Error('no table'); }));
    expect(params(text, 'learning').questions_total).toBe(7);
    const junk = buildEvents(fakeDb(() => ({ n: 'seven' })));
    expect(params(junk, 'learning').questions_total).toBe(0);
    const broken = buildEvents(fakeDb(() => { throw new Error('busy'); }));
    expect(params(broken, 'learning').questions_total).toBe(0);
    expect(() => assertSafe(broken)).not.toThrow();
  });
});

describe('assertSafe', () => {
  it('refuses a bad event name, too many params and a bad param name', () => {
    expect(() => assertSafe([{ name: 'Bad Name', params: {} }])).toThrow(/bad event name/);
    const many = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`p${i}`, i]));
    expect(() => assertSafe([{ name: 'settings', params: many }])).toThrow(/25 params/);
    expect(() => assertSafe([{ name: 'settings', params: { 'Bad-Key': 1 } }])).toThrow(/bad param/);
    expect(() => assertSafe([{ name: 'settings', params: { on: true, n: 1 } }])).not.toThrow();
  });
});

describe('post and send', () => {
  it('posts in batches of 25 with engagement time, and stops at the first refusal', async () => {
    const calls = stubFetch();
    const events = Array.from({ length: 30 }, () => ({ name: 'feature_use', params: { count: 1 } }));
    expect(await post(events, 'id-1')).toBe(true);
    expect(calls.map((c) => c.body.events.length)).toEqual([25, 5]);
    expect(calls[0]!.body.client_id).toBe('id-1');
    expect(calls[0]!.body.events[0].params.engagement_time_msec).toBe(1);
    expect(calls[0]!.url).toContain('measurement_id=');

    const refused = stubFetch(false);
    expect(await post(events, 'id-1')).toBe(false);
    expect(refused).toHaveLength(1);
  });

  it('refuses to post an unsafe event', async () => {
    const calls = stubFetch();
    await expect(post([{ name: 'settings', params: { where: '/Users/x' } }], 'id')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('moves the window and clears sent counters on success, and keeps both on failure', async () => {
    installed();
    const now = Date.parse('2026-09-24T10:00:00Z');
    db.prepare("INSERT INTO usage_counts (day, name, n) VALUES ('2026-09-23', 'cli:doctor', 1), ('2026-09-24', 'cli:doctor', 1)").run();

    stubFetch(false);
    expect(await sendNow(db, now)).toBe(false);
    expect(readState().sent_at).toBeUndefined();

    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    expect(await sendNow(db, now)).toBe(false);

    const calls = stubFetch();
    expect(await sendNow(db, now)).toBe(true);
    expect(calls[0]!.body.events.map((e: TelemetryEvent) => e.name)).toContain('feature_use');
    expect(readState().sent_at).toBe(new Date(now).toISOString());
    expect(db.prepare('SELECT day FROM usage_counts').all()).toEqual([{ day: '2026-09-24' }]);
  });

  it('still reports success when the sent counters cannot be cleared', async () => {
    installed();
    stubFetch();
    const busy = { prepare: () => { throw new Error('busy'); } } as unknown as DB;
    expect(await sendNow(busy)).toBe(true);
  });

  it('sends one event in the open, and nothing when it cannot send', async () => {
    const calls = stubFetch();
    await sendOne('uninstall', { purge: true });
    expect(calls).toHaveLength(0);

    installed();
    await sendOne('uninstall', { purge: true });
    await sendOne('uninstall');
    expect(calls[0]!.body.events[0]).toMatchObject({ name: 'uninstall', params: { purge: true, version: '9.9.9' } });
    expect(calls[1]!.body.events[0].params.purge).toBeUndefined();

    vi.stubGlobal('fetch', async () => { throw new Error('offline'); });
    await expect(sendOne('uninstall')).resolves.toBeUndefined();
  });
});
