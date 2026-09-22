import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { notify, queuePausedAlert, sessionWrapUp } from '../src/memory/notify.js';

let dbFile: string;
let db: DB;
let dir: string;
let sinkFile: string;

function configWith(over: Partial<EklavyaConfig['notifications']>): EklavyaConfig {
  return { ...DEFAULT_CONFIG, notifications: { ...DEFAULT_CONFIG.notifications, ...over } };
}

function readSink(): Record<string, unknown>[] {
  if (!fs.existsSync(sinkFile)) return [];
  return fs
    .readFileSync(sinkFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  dbFile = tempDbPath('eklavya-notify');
  db = openDb(dbFile);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-sink-'));
  sinkFile = path.join(dir, 'events.jsonl');
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(dir, { recursive: true, force: true });
});

const EVENT = {
  id: 'evt-1',
  kind: 'session_summary',
  project: '/work/repo',
  title: 'Session finished',
  body: 'Three entries recorded.',
};

describe('outbound notifications', () => {
  it('sends nothing at all when nothing is configured', async () => {
    // The default. An upgrade must never turn a local install into one that
    // talks to the network.
    expect(await notify(db, DEFAULT_CONFIG, EVENT)).toEqual([]);
    expect(readSink()).toHaveLength(0);
  });

  it('sends nothing when sinks exist but the feature is off', async () => {
    const config = configWith({ enabled: false, sinks: [{ kind: 'file', target: sinkFile }] });
    expect(await notify(db, config, EVENT)).toEqual([]);
    expect(readSink()).toHaveLength(0);
  });

  it('delivers to a configured sink', async () => {
    const config = configWith({ enabled: true, sinks: [{ kind: 'file', target: sinkFile }] });
    const results = await notify(db, config, EVENT);
    expect(results).toEqual([{ sink: 'file', ok: true }]);
    expect(readSink()).toHaveLength(1);
    expect(readSink()[0]!.title).toBe('Session finished');
  });

  it('delivers once, however many times the same event is raised', async () => {
    // A Stop hook fires more than once, a session resumes, a second worker
    // runs. None of those is a second wrap-up.
    const config = configWith({ enabled: true, sinks: [{ kind: 'file', target: sinkFile }] });
    await notify(db, config, EVENT);
    await notify(db, config, EVENT);
    await notify(db, config, EVENT);
    expect(readSink()).toHaveLength(1);
  });

  it('redacts a secret before it reaches the sink, because a send cannot be recalled', async () => {
    const config = configWith({ enabled: true, sinks: [{ kind: 'file', target: sinkFile }] });
    await notify(db, config, {
      ...EVENT,
      id: 'evt-secret',
      body: 'deploy failed with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123',
    });
    const raw = fs.readFileSync(sinkFile, 'utf8');
    expect(raw).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(raw).toContain('[redacted:github-token]');
  });

  it('honours a sink that asked for one kind of event', async () => {
    const config = configWith({
      enabled: true,
      sinks: [{ kind: 'file', target: sinkFile, events: ['queue_paused'] }],
    });
    await notify(db, config, EVENT);
    expect(readSink()).toHaveLength(0);
    await notify(db, config, queuePausedAlert({ project: '/work/repo', errorClass: 'auth', failed: 2 }));
    expect(readSink()).toHaveLength(1);
  });

  it('reports a failing sink instead of throwing into the caller', async () => {
    // This runs at a session seam. A dead webhook must not end a turn with an
    // error the developer has to read.
    const config = configWith({
      enabled: true,
      sinks: [{ kind: 'command', target: '/nonexistent/eklavya-notify-hook' }],
    });
    const results = await notify(db, config, { ...EVENT, id: 'evt-broken' });
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.sink).toBe('command');
  });

  it('delivers on a later pass to a sink that was down, instead of losing the notification', async () => {
    // A webhook down for thirty seconds, or a file sink on a full disk. The
    // event is raised once; the delivery has to survive the outage.
    const blocked = path.join(dir, 'busy');
    fs.writeFileSync(blocked, 'not a directory');
    const config = configWith({ enabled: true, sinks: [{ kind: 'file', target: path.join(blocked, 'events.jsonl') }] });

    const first = await notify(db, config, { ...EVENT, id: 'evt-outage' });
    expect(first[0]!.ok).toBe(false);

    fs.unlinkSync(blocked);
    const second = await notify(db, config, { ...EVENT, id: 'evt-outage' });
    expect(second[0]!.ok).toBe(true);
    expect(fs.readFileSync(path.join(blocked, 'events.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('does not re-send to a sink that already accepted it while retrying the one that did not', async () => {
    // The whole point of keying per sink: a retry must not be a second copy
    // for everyone else on the list.
    const blocked = path.join(dir, 'busy');
    fs.writeFileSync(blocked, 'not a directory');
    const config = configWith({
      enabled: true,
      sinks: [
        { kind: 'file', target: sinkFile },
        { kind: 'file', target: path.join(blocked, 'events.jsonl') },
      ],
    });

    expect((await notify(db, config, { ...EVENT, id: 'evt-mixed' })).map((r) => r.ok)).toEqual([true, false]);
    fs.unlinkSync(blocked);
    expect(await notify(db, config, { ...EVENT, id: 'evt-mixed' })).toEqual([{ sink: 'file', ok: true }]);
    expect(readSink()).toHaveLength(1);
  });

  it('gives up on a sink that keeps failing rather than retrying it forever', async () => {
    const config = configWith({
      enabled: true,
      sinks: [{ kind: 'command', target: '/nonexistent/eklavya-notify-hook' }],
    });
    const event = { ...EVENT, id: 'evt-hopeless' };
    for (let i = 0; i < 3; i += 1) expect(await notify(db, config, event)).toHaveLength(1);
    // The fourth pass makes no attempt at all.
    expect(await notify(db, config, event)).toEqual([]);
  });

  it('drops a notification that has aged out instead of retrying it', async () => {
    // A queue that paused two days ago is noise by the time the sink is back.
    const blocked = path.join(dir, 'busy');
    fs.writeFileSync(blocked, 'not a directory');
    const config = configWith({ enabled: true, sinks: [{ kind: 'file', target: path.join(blocked, 'events.jsonl') }] });
    await notify(db, config, { ...EVENT, id: 'evt-stale' });

    const row = db.prepare("SELECT key, value FROM meta WHERE key LIKE 'notified:evt-stale:%'").get() as {
      key: string;
      value: string;
    };
    const aged = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      JSON.stringify({ ...JSON.parse(row.value), first: aged }),
      row.key,
    );

    fs.unlinkSync(blocked);
    expect(await notify(db, config, { ...EVENT, id: 'evt-stale' })).toEqual([]);
    expect(fs.existsSync(path.join(blocked, 'events.jsonl'))).toBe(false);
  });

  it('keys a session wrap-up on the session, so one session is one message', () => {
    const a = sessionWrapUp({ project: '/work/repo', sessionId: 's1', entries: 3, questions: 2, passed: 2 });
    const b = sessionWrapUp({ project: '/work/repo', sessionId: 's1', entries: 9, questions: 4, passed: 1 });
    expect(a.id).toBe(b.id);
  });
});
