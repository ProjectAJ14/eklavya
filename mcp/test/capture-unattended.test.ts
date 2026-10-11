import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { record } from '../src/hooks/capture-lib.js';
import type { ResolvedConfig } from '../src/config.js';
import type { EvidenceIdentity } from '../src/memory/identity.js';
import { cleanup, tempDbPath } from './helpers.js';

const resolved = { config: DEFAULT_CONFIG } as unknown as ResolvedConfig;
const identity: EvidenceIdentity = {
  project: '/repo/x',
  checkout: '/repo/x',
  sessionId: 's1',
  agentId: null,
  host: 'claude-code',
} as EvidenceIdentity;

let dbFile = '';
let db: DB;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.CLAUDE_CODE_SESSION_ATTENDED;
  dbFile = tempDbPath('eklavya-unattended');
  db = openDb(dbFile);
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_SESSION_ATTENDED;
  else process.env.CLAUDE_CODE_SESSION_ATTENDED = saved;
  db.close();
  cleanup(dbFile);
});

const count = () => (db.prepare('SELECT COUNT(*) n FROM evidence_events').get() as { n: number }).n;

describe('an unattended session (claude -p, evals, scripts)', () => {
  it('records no prompt, reply or start, so it never opens a batch', () => {
    process.env.CLAUDE_CODE_SESSION_ATTENDED = '0';
    for (const kind of ['prompt', 'assistant', 'lifecycle'] as const) {
      expect(record(db, resolved, identity, { kind, title: kind, body: 'hello' })).toBe(false);
    }
    expect(count()).toBe(0);
  });

  it('still records the work it does to the project', () => {
    process.env.CLAUDE_CODE_SESSION_ATTENDED = '0';
    expect(record(db, resolved, identity, { kind: 'tool_use', tool: 'Bash', title: 'Bash', body: 'ls' })).toBe(true);
    expect(count()).toBe(1);
  });

  it('records everything when the session is attended or the host says nothing', () => {
    process.env.CLAUDE_CODE_SESSION_ATTENDED = '1';
    expect(record(db, resolved, identity, { kind: 'prompt', title: 'prompt', body: 'hi' })).toBe(true);
    delete process.env.CLAUDE_CODE_SESSION_ATTENDED;
    expect(record(db, resolved, identity, { kind: 'assistant', title: 'assistant', body: 'ok' })).toBe(true);
    expect(count()).toBe(2);
  });
});
