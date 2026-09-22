import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { findRepoConfig } from '../src/config.js';
import { projectKey } from '../src/store.js';
import { insertEntry, recordReceipt } from '../src/memory/store.js';
import { ESTIMATOR } from '../src/memory/tokens.js';
import {
  memoryFileHistory,
  memoryGet,
  memorySearch,
  memoryStatus,
  memoryTimeline,
} from '../src/tools/memory_read_tools.js';
import { memoryCorrect, memoryDelete, memoryWrite } from '../src/tools/memory_write_tools.js';

let dbFile = '';
let db: DB;
let home = '';
let cwd = '';
let project = '';
const envBackup = { ...process.env };

/** Handlers take (args, ctx); ctx is just the db — same dialect as tools.test.ts. */
const call = <T>(tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown> = {}): T =>
  tool.handler({ cwd, ...args }, { db }) as T;

/** A real git root, because `projectKey` is what scopes every one of these tools. */
function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
}

function write(args: Record<string, unknown>): number {
  return call<{ id: number }>(memoryWrite, args).id;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cwd-'));
  gitInit(cwd);
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
  dbFile = tempDbPath('memory-tools');
  db = openDb(dbFile);
  project = projectKey(findRepoConfig(cwd).repoRoot);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  process.env = { ...envBackup };
});

describe('memory_search', () => {
  it('returns identifiers and titles, never the narrative', () => {
    write({
      title: 'Refresh cookie rotation',
      body: 'Every use rotates the cookie because reuse detection needs a one-shot token.',
      files: ['src/auth.ts'],
    });

    const result = call<any>(memorySearch, { query: 'refresh cookie rotation' });
    expect(result.count).toBe(1);
    expect(result.results[0].title).toBe('Refresh cookie rotation');
    expect(result.results[0].files).toEqual(['src/auth.ts']);
    expect(Object.keys(result.results[0]).sort()).toEqual(['files', 'id', 'occurred_at', 'score', 'title', 'type']);
    // The whole point of the two-stage read: the body costs nothing until asked for.
    expect(JSON.stringify(result)).not.toContain('reuse detection');
  });

  it('defaults to this project and crosses over only when asked', () => {
    write({ title: 'Kingfisher cache warmup', body: 'Warms on boot.' });
    insertEntry(db, {
      project: '/tmp/some-other-repo',
      title: 'Kingfisher cache warmup elsewhere',
      narrative: 'Another codebase entirely.',
    });

    const scoped = call<any>(memorySearch, { query: 'kingfisher' });
    expect(scoped.count).toBe(1);
    expect(scoped.project).toBe(project);

    const wide = call<any>(memorySearch, { query: 'kingfisher', all_projects: true });
    expect(wide.count).toBe(2);
    expect(wide.project).toBeNull();
  });
});

describe('memory_get', () => {
  it('hydrates the entry and charges the receipt that proposed it', () => {
    const id = write({ title: 'Quota backoff', body: 'Retry with jitter; the provider 429s in bursts.' });

    const receiptId = recordReceipt(db, {
      project,
      scope: 'test',
      method: ESTIMATOR,
      delivery: 'confirmed',
      items: [{ entryId: id, sourceTokens: 500, sentTokens: 20 }],
    });
    const delivered = () =>
      (db.prepare('SELECT delivered_tokens AS n FROM context_receipts WHERE id = ?').get(receiptId) as { n: number }).n;
    const before = delivered();

    const result = call<any>(memoryGet, { ids: [id], receipt_id: receiptId });
    expect(result.entries[0].narrative).toContain('Retry with jitter');
    expect(result.entries[0].generator).toBe('manual');
    expect(result.entries[0].event_ids).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.charged_to).toBe(receiptId);

    // The index stage's optimistic figure is only honest once the detail it led
    // to is added to the same receipt.
    expect(delivered()).toBeGreaterThan(before);
  });

  it('names the ids it could not find rather than silently shortening the list', () => {
    const id = write({ title: 'Only one' });
    const result = call<any>(memoryGet, { ids: [id, 9999] });
    expect(result.count).toBe(1);
    expect(result.missing).toEqual([9999]);
  });
});

describe('memory_timeline', () => {
  it('pages stably: two pages, no overlap, no gaps', () => {
    const ids = ['one', 'two', 'three', 'four', 'five'].map((n) => write({ title: `Note ${n}` }));

    const first = call<any>(memoryTimeline, { limit: 2, offset: 0 });
    const second = call<any>(memoryTimeline, { limit: 2, offset: 2 });
    const third = call<any>(memoryTimeline, { limit: 2, offset: 4 });

    expect(first.total).toBe(5);
    const paged = [...first.entries, ...second.entries, ...third.entries].map((e: any) => e.id);
    expect(new Set(paged).size).toBe(5);
    expect([...paged].sort()).toEqual([...ids].sort());
    // Re-reading a page gives the same page.
    expect(call<any>(memoryTimeline, { limit: 2, offset: 2 }).entries).toEqual(second.entries);
  });
});

describe('memory_file_history', () => {
  it('finds entries by a path fragment, newest first', () => {
    write({ title: 'Touched auth', body: 'x', files: ['src/auth.ts'] });
    write({ title: 'Touched routes', body: 'y', files: ['src/routes.ts'] });

    const result = call<any>(memoryFileHistory, { file: 'auth.ts' });
    expect(result.count).toBe(1);
    expect(result.entries[0].title).toBe('Touched auth');
  });
});

describe('memory_write', () => {
  it('redacts a secret in the body before it is stored', () => {
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz012345';
    const result = call<any>(memoryWrite, { title: 'Deploy notes', body: `Used ${token} for the release.` });
    expect(result.redacted).toBe(true);
    expect(result.redacted_kinds).toContain('github-token');

    const stored = call<any>(memoryGet, { ids: [result.id] }).entries[0];
    expect(stored.narrative).toContain('[redacted:github-token]');
    expect(stored.narrative).not.toContain(token);
    // Nothing anywhere else kept a copy.
    const row = db.prepare('SELECT narrative FROM memory_entries WHERE id = ?').get(result.id) as { narrative: string };
    expect(row.narrative).not.toContain(token);
  });
});

describe('memory_correct', () => {
  it('supersedes: the stale row leaves retrieval and stays in the timeline', () => {
    const staleId = write({ title: 'Zebra protocol uses UDP', body: 'Observed on the wire.' });

    const result = call<any>(memoryCorrect, { id: staleId, title: 'Zebra protocol uses TCP', body: 'Re-checked.' });
    expect(result.superseded).toBe(staleId);
    expect(result.id).not.toBe(staleId);

    const found = call<any>(memorySearch, { query: 'zebra protocol' });
    expect(found.results.map((r: any) => r.id)).toEqual([result.id]);

    // The original is never edited, so the audit trail still holds both.
    const timelineIds = call<any>(memoryTimeline, { limit: 50 }).entries.map((e: any) => e.id);
    expect(timelineIds).toContain(staleId);
    expect(timelineIds).toContain(result.id);
    expect(db.prepare('SELECT title FROM memory_entries WHERE id = ?').get(staleId)).toEqual({
      title: 'Zebra protocol uses UDP',
    });
  });

  it('refuses an empty correction and an unknown id', () => {
    expect(call<any>(memoryCorrect, { id: 1 }).error).toBe('nothing_to_correct');
    expect(call<any>(memoryCorrect, { id: 9999, title: 'x' }).error).toBe('not_found');
  });
});

describe('memory_delete', () => {
  it('removes the entry from search', () => {
    const id = write({ title: 'Quokka migration notes', body: 'Ran the backfill twice.' });
    expect(call<any>(memorySearch, { query: 'quokka' }).count).toBe(1);

    expect(call<any>(memoryDelete, { id }).deleted).toBe(true);
    expect(call<any>(memorySearch, { query: 'quokka' }).count).toBe(0);
  });
});

describe('memory_status', () => {
  it('answers on an empty database without throwing', () => {
    const result = call<any>(memoryStatus);
    expect(result.project).toBe(project);
    expect(result.entries).toBe(0);
    expect(result.pending_events).toBe(0);
    expect(result.queue).toEqual({ pending: 0, paused: 0, failed: 0, oldest: null });
    expect(result.newest_evidence).toBeNull();
    expect(result.savings).toEqual({ kind: 'none' });
    expect(result.summarizer).toBe('local-v1');
    expect(result.provider_configured).toBe(false);
  });

  it('counts what this project has remembered', () => {
    write({ title: 'Something' });
    expect(call<any>(memoryStatus).entries).toBe(1);
  });
});
