import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig, type NotificationSink } from '../src/config.js';
import { notify } from '../src/memory/notify.js';

let dbFile: string;
let db: DB;

const EVENT = { id: 'cov-1', kind: 'session_summary', project: '/work/repo', title: 't', body: 'b' };

function configWith(sinks: NotificationSink[]): EklavyaConfig {
  return { ...DEFAULT_CONFIG, notifications: { ...DEFAULT_CONFIG.notifications, enabled: true, sinks } };
}

const ledger = () =>
  (db.prepare("SELECT value FROM meta WHERE key LIKE 'notified:cov-1:%'").all() as { value: string }[]).map(
    (r) => JSON.parse(r.value) as { ok: boolean; n: number; detail?: string },
  );

beforeEach(() => {
  dbFile = tempDbPath('eklavya-notify-cov');
  db = openDb(dbFile);
});

afterEach(() => {
  if (db.open) db.close();
  cleanup(dbFile);
});

describe('webhook sinks', () => {
  let server: http.Server;
  let url = '';
  let status = 200;
  const bodies: unknown[] = [];

  beforeEach(async () => {
    bodies.length = 0;
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        bodies.push(JSON.parse(data));
        res.writeHead(status).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });

  afterEach(async () => {
    await new Promise((r) => server.close(r));
  });

  it('posts the payload as JSON and records the delivery', async () => {
    status = 204;
    expect(await notify(db, configWith([{ kind: 'webhook', target: url }]), EVENT)).toEqual([{ sink: 'webhook', ok: true }]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ id: 'cov-1', title: 't', body: 'b' });
    expect(ledger()).toEqual([expect.objectContaining({ ok: true, n: 1 })]);
  });

  it('reports a rejecting endpoint with its status', async () => {
    status = 503;
    expect(await notify(db, configWith([{ kind: 'webhook', target: url }]), EVENT)).toEqual([
      { sink: 'webhook', ok: false, detail: 'HTTP 503' },
    ]);
    expect(ledger()[0]).toMatchObject({ ok: false, n: 1, detail: 'HTTP 503' });
  });
});

describe('command sinks', () => {
  it('reports a non-zero exit', async () => {
    expect(await notify(db, configWith([{ kind: 'command', target: 'false' }]), EVENT)).toEqual([
      { sink: 'command', ok: false, detail: 'exit 1' },
    ]);
  });

  it('treats a command that closed stdin early as delivered when it exits cleanly', async () => {
    // A payload far past the pipe buffer, to a command that never reads it.
    const big = { ...EVENT, data: { blob: 'x'.repeat(1024 * 1024) } };
    expect(await notify(db, configWith([{ kind: 'command', target: 'true' }]), big)).toEqual([{ sink: 'command', ok: true }]);
  });

  it('reports a command that cannot even be spawned', async () => {
    const [result] = await notify(db, configWith([{ kind: 'command', target: '' }]), EVENT);
    expect(result).toMatchObject({ sink: 'command', ok: false });
    expect(result!.detail).toMatch(/file/);
  });
});

describe('the delivery ledger fails towards not re-sending', () => {
  const file = () => `${tempDbPath('eklavya-notify-cov-sink')}.jsonl`;

  it('treats a ledger row it cannot parse as spent', async () => {
    const target = file();
    const sinks = [{ kind: 'file' as const, target }];
    await notify(db, configWith([{ kind: 'webhook', target: 'http://127.0.0.1:1/' }]), EVENT);
    db.prepare("UPDATE meta SET value = 'not json' WHERE key LIKE 'notified:cov-1:%'").run();
    // Same target fingerprint as the unparseable row: no attempt.
    expect(await notify(db, configWith([{ kind: 'webhook', target: 'http://127.0.0.1:1/' }]), EVENT)).toEqual([]);
    expect(await notify(db, configWith(sinks), EVENT)).toEqual([{ sink: 'file', ok: true }]);
    expect(fs.readFileSync(target, 'utf8').trim().split('\n')).toHaveLength(1);
    cleanup(target);
  });

  it('honours a row written by the version that keyed the whole event', async () => {
    const target = file();
    db.prepare("INSERT INTO meta (key, value) VALUES ('notified:cov-1', '1')").run();
    expect(await notify(db, configWith([{ kind: 'file', target }]), EVENT)).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
    cleanup(target);
  });

  it('sends nothing when the database cannot say whether it already sent', async () => {
    const target = file();
    db.close();
    expect(await notify(db, configWith([{ kind: 'file', target }]), EVENT)).toEqual([]);
    expect(fs.existsSync(target)).toBe(false);
    cleanup(target);
  });

  it('still delivers when the ledger write is refused', async () => {
    const target = file();
    const refusing = new Proxy(db, {
      get(real, prop) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (sql.includes('INSERT')) throw new Error('database is locked');
            return real.prepare(sql);
          };
        }
        return Reflect.get(real, prop, real) as unknown;
      },
    });
    expect(await notify(refusing, configWith([{ kind: 'file', target }]), EVENT)).toEqual([{ sink: 'file', ok: true }]);
    expect(ledger()).toEqual([]);
    cleanup(target);
  });

  it('reports a non-Error failure as text', async () => {
    // `kind` is read for the ledger, then by the dispatch that fails, then for the result.
    let reads = 0;
    const sink = {
      target: '/unused',
      get kind(): 'file' {
        reads += 1;
        if (reads === 2) throw 'sink misconfigured';
        return 'file';
      },
    } as NotificationSink;
    expect(await notify(db, configWith([sink]), EVENT)).toEqual([
      { sink: 'file', ok: false, detail: 'sink misconfigured' },
    ]);
  });
});
