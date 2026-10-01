import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { capture, captureOrSpool, drainSpool, prepare } from '../src/memory/capture.js';
import type { EvidenceIdentity } from '../src/memory/identity.js';
import { spoolPath } from '../src/memory/spool.js';

const PROJECT = '/tmp/demo-repo';
const IDENTITY: EvidenceIdentity = { project: PROJECT, checkout: PROJECT, sessionId: 's1', agentId: null, host: 'claude-code' };
const config = (): EklavyaConfig => structuredClone(DEFAULT_CONFIG);

let dbFile: string;
let db: DB;
let home: string;
let priorHome: string | undefined;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-capture-cov');
  db = openDb(dbFile);
  priorHome = process.env.EKLAVYA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  process.env.EKLAVYA_HOME = home;
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
  db.close();
  cleanup(dbFile);
});

const off = () => {
  const c = config();
  c.memory.enabled = false;
  return c;
};

describe('capture outcomes', () => {
  it('keeps a file event that names no files at all', () => {
    const input = prepare(config(), IDENTITY, { kind: 'file_edit', body: 'edited something' });
    expect(input?.files).toEqual([]);
  });

  it('reports excluded, stored and duplicate from capture', () => {
    const ev = { kind: 'tool_use' as const, body: 'ran the build', occurredAt: '2026-01-01T00:00:00.000Z' };
    expect(capture(db, off(), IDENTITY, ev)).toBe('excluded');
    expect(capture(db, config(), IDENTITY, ev)).toBe('stored');
    expect(capture(db, config(), IDENTITY, ev)).toBe('duplicate');
  });

  it('reports excluded, stored and duplicate from captureOrSpool', () => {
    const ev = { kind: 'tool_use' as const, body: 'ran the tests', occurredAt: '2026-01-01T00:00:00.000Z' };
    expect(captureOrSpool(db, off(), IDENTITY, ev)).toBe('excluded');
    expect(captureOrSpool(db, config(), IDENTITY, ev)).toBe('stored');
    expect(captureOrSpool(db, config(), IDENTITY, ev)).toBe('duplicate');
    expect(fs.existsSync(spoolPath())).toBe(false);
  });
});

describe('drainSpool', () => {
  it('skips records without an identity and still commits the claim', () => {
    const valid = prepare(config(), IDENTITY, { kind: 'note', body: 'kept', occurredAt: '2026-01-02T00:00:00.000Z' })!;
    fs.mkdirSync(path.dirname(spoolPath()), { recursive: true });
    const lines = [null, 7, { eventUid: 'x' }, { project: PROJECT }, valid].map((r) => JSON.stringify(r));
    fs.writeFileSync(spoolPath(), `${lines.join('\n')}\n`);

    expect(drainSpool(db)).toEqual({ replayed: 1, skipped: 4 });
    expect(fs.readdirSync(path.dirname(spoolPath()))).toEqual([]);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM evidence_events').get() as { n: number }).n;
    expect(n).toBe(1);
  });
});
