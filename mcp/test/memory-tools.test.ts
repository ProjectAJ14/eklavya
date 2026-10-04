import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { findRepoConfig } from '../src/config.js';
import { projectKey } from '../src/store.js';
import { appendEvent, insertEntry, readTotals, recordReceipt } from '../src/memory/store.js';
import { recall } from '../src/memory/recall.js';
import { DEFAULT_CONFIG } from '../src/config.js';
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

  it('hands back the raw evidence bodies only when asked, capped and marked', () => {
    const long = 'x'.repeat(2000);
    const event = appendEvent(db, {
      eventUid: 'evidence-hydration-1',
      project,
      sessionId: 'session-1',
      kind: 'tool_use',
      tool: 'Edit',
      body: long,
      files: ['src/auth.ts'],
      occurredAt: '2025-10-04T11:30:00.000Z',
    });
    const id = insertEntry(db, {
      project,
      title: 'Cookie rotation',
      narrative: 'Rotated on every use.',
      eventIds: [event.id],
    });

    // The index exists to avoid sending this, so the default has to stay quiet.
    const plain = call<any>(memoryGet, { ids: [id] });
    expect(plain.entries[0].event_ids).toEqual([event.id]);
    expect(plain.entries[0].evidence_events).toBeUndefined();

    const hydrated = call<any>(memoryGet, { ids: [id], include_evidence: true }).entries[0];
    expect(hydrated.evidence_events).toHaveLength(1);
    const [got] = hydrated.evidence_events;
    expect(got).toMatchObject({
      id: event.id,
      kind: 'tool_use',
      tool: 'Edit',
      occurred_at: '2025-10-04T11:30:00.000Z',
      files: ['src/auth.ts'],
      truncated: true,
    });
    expect(got.body).toHaveLength(1500);
  });

  it('charges the receipt for the evidence it hydrated, not only for the entry', () => {
    const event = appendEvent(db, {
      eventUid: 'evidence-charge-1',
      project,
      sessionId: 'session-1',
      kind: 'tool_use',
      body: 'y'.repeat(1200),
    });
    const id = insertEntry(db, { project, title: 'Charged', eventIds: [event.id] });

    const receipt = () =>
      recordReceipt(db, {
        project,
        scope: 'test',
        method: ESTIMATOR,
        delivery: 'confirmed',
        items: [{ entryId: id, sourceTokens: 500, sentTokens: 20 }],
      });
    const delivered = (receiptId: number) =>
      (db.prepare('SELECT delivered_tokens AS n FROM context_receipts WHERE id = ?').get(receiptId) as { n: number }).n;

    const lean = receipt();
    call<any>(memoryGet, { ids: [id], receipt_id: lean });
    const fat = receipt();
    call<any>(memoryGet, { ids: [id], receipt_id: fat, include_evidence: true });

    // A saving that does not count the evidence it sent is not a saving.
    expect(delivered(fat)).toBeGreaterThan(delivered(lean));
  });

  it('names the ids it could not find rather than silently shortening the list', () => {
    const id = write({ title: 'Only one' });
    const result = call<any>(memoryGet, { ids: [id, 9999] });
    expect(result.count).toBe(1);
    expect(result.missing).toEqual([9999]);
  });
});

describe('memory_get scope', () => {
  const OTHER = '/tmp/some-other-repo';

  it('withholds another project\'s entry unless every project was asked for', () => {
    const mine = write({ title: 'Heron deploy order', body: 'Database first.' });
    const theirs = insertEntry(db, { project: OTHER, title: 'Heron elsewhere', narrative: 'Private to them.' });

    const scoped = call<any>(memoryGet, { ids: [mine, theirs, 9999] });
    expect(scoped.entries.map((e: any) => e.id)).toEqual([mine]);
    expect(scoped.other_project).toEqual([theirs]);
    expect(scoped.missing).toEqual([9999]);
    expect(JSON.stringify(scoped)).not.toContain('Private to them');

    const wide = call<any>(memoryGet, { ids: [mine, theirs], all_projects: true });
    expect(wide.entries.map((e: any) => [e.id, e.project])).toEqual([
      [mine, project],
      [theirs, OTHER],
    ]);
    expect(wide.other_project).toEqual([]);
  });

  it('reads an entry written from a worktree of this checkout', () => {
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], {
      cwd,
      stdio: 'pipe',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    });
    const tree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-wt-')), 'tree');
    execFileSync('git', ['worktree', 'add', '-q', tree], { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
    try {
      const id = write({ title: 'Egret worktree note', cwd: tree });
      expect(call<any>(memoryGet, { ids: [id] }).entries).toHaveLength(1);
      expect(call<any>(memoryGet, { ids: [id], cwd: tree }).entries).toHaveLength(1);
      expect(call<any>(memoryDelete, { id, cwd: tree }).deleted).toBe(true);
    } finally {
      fs.rmSync(path.dirname(tree), { recursive: true, force: true });
    }
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

  it('refuses another project\'s entry and changes neither project', () => {
    const theirs = insertEntry(db, { project: '/tmp/some-other-repo', title: 'Ibis uses UDP', narrative: 'Theirs.' });
    const before = db.prepare('SELECT * FROM memory_entries ORDER BY id').all();

    const result = call<any>(memoryCorrect, { id: theirs, title: 'Ibis uses TCP' });
    expect(result).toMatchObject({ error: 'other_project', project: '/tmp/some-other-repo' });
    expect(db.prepare('SELECT * FROM memory_entries ORDER BY id').all()).toEqual(before);
  });

  it('writes nothing when the supersession fails, so a retry corrects once', () => {
    const staleId = write({ title: 'Osprey cache ttl is 60s' });
    // A fixture-only fault at the last write of the correction.
    db.exec(`CREATE TRIGGER fail_supersede BEFORE UPDATE OF superseded_by ON memory_entries
             BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    expect(() => call<any>(memoryCorrect, { id: staleId, title: 'Osprey cache ttl is 300s' })).toThrow(/injected/);
    expect(db.prepare('SELECT id, superseded_by FROM memory_entries').all()).toEqual([
      { id: staleId, superseded_by: null },
    ]);

    db.exec('DROP TRIGGER fail_supersede');
    const result = call<any>(memoryCorrect, { id: staleId, title: 'Osprey cache ttl is 300s' });
    expect(call<any>(memorySearch, { query: 'osprey' }).results.map((r: any) => r.id)).toEqual([result.id]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get()).toEqual({ n: 2 });
  });

  it('lets only the first of two corrections of one entry through', () => {
    const staleId = write({ title: 'Plover runs nightly' });
    const first = call<any>(memoryCorrect, { id: staleId, title: 'Plover runs hourly' });
    const second = call<any>(memoryCorrect, { id: staleId, title: 'Plover runs weekly' });
    expect(second.error).toBe('already_superseded');
    expect(second.detail).toContain(String(first.id));
    expect(call<any>(memorySearch, { query: 'plover' }).results.map((r: any) => r.id)).toEqual([first.id]);
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

  it('refuses another project\'s entry, soft or hard, and leaves it in place', () => {
    const theirs = insertEntry(db, { project: '/tmp/some-other-repo', title: 'Wren notes', narrative: 'Theirs.' });
    for (const hard of [false, true]) {
      expect(call<any>(memoryDelete, { id: theirs, hard })).toMatchObject({ error: 'other_project' });
    }
    expect(db.prepare('SELECT deleted_at FROM memory_entries WHERE id = ?').get(theirs)).toEqual({ deleted_at: null });
    expect(call<any>(memoryDelete, { id: 9999 }).error).toBe('not_found');
  });
});

describe('memory_status', () => {
  it('answers on an empty database without throwing', () => {
    const result = call<any>(memoryStatus);
    expect(result.project).toBe(project);
    expect(result.entries).toBe(0);
    expect(result.pending_events).toBe(0);
    expect(result.queue).toEqual({ pending: 0, paused: 0, failed: 0, quarantined: 0, oldest: null });
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

/**
 * Issue #83: `receipt_id` is optional, so the receipts alone could not tell a
 * session that never read memory from one that read it without linking the
 * read. Every read tool call is logged on its own, ids and sizes only.
 */
describe('memory read log', () => {
  type Read = { tool: string; project: string; session_id: string; receipt_id: number | null; entry_ids: string; outcome: string; latency_ms: number; result_tokens: number };
  const reads = () => db.prepare('SELECT * FROM memory_reads ORDER BY id').all() as Read[];

  it('links a detail fetch to the receipt its recall block carried', () => {
    const id = write({ title: 'Quota backoff', body: 'Retry with jitter; the provider 429s in bursts.' });
    const block = recall(db, structuredClone(DEFAULT_CONFIG), { project, sessionId: 'session-1' });
    // What the model reads is the block, so the id comes from the block.
    const receiptId = Number(/receipt="(\d+)"/.exec(block.block!)![1]);
    expect(receiptId).toBe(block.receiptId);

    const result = call<any>(memoryGet, { ids: [id], receipt_id: receiptId });
    expect(result.charged_to).toBe(receiptId);
    const detail = db
      .prepare("SELECT entry_id FROM context_receipt_items WHERE receipt_id = ? AND stage = 'detail'")
      .all(receiptId);
    expect(detail).toEqual([{ entry_id: id }]);
    expect(reads()).toEqual([
      expect.objectContaining({ tool: 'memory_get', project, receipt_id: receiptId, entry_ids: `[${id}]`, outcome: 'ok' }),
    ]);
  });

  it('logs a read without a receipt as unlinked, rather than losing it', () => {
    const id = write({ title: 'Quota backoff', body: 'Retry with jitter; the provider 429s in bursts.' });
    call<any>(memoryGet, { ids: [id] });
    call<any>(memorySearch, { query: 'quota backoff' });
    call<any>(memoryTimeline, {});
    call<any>(memoryFileHistory, { file: 'nothing-here.ts' });

    expect(reads().map((r) => [r.tool, r.receipt_id, r.outcome])).toEqual([
      ['memory_get', null, 'ok'],
      ['memory_search', null, 'ok'],
      ['memory_timeline', null, 'ok'],
      ['memory_file_history', null, 'empty'],
    ]);
    const [get] = reads();
    expect(get!.session_id).toBeTruthy();
    expect(get!.result_tokens).toBeGreaterThan(0);
    expect(get!.latency_ms).toBeGreaterThanOrEqual(0);
    expect(readTotals(db, project)).toMatchObject({ reads: 4, linked: 0, unlinked: 4, empty: 1, errors: 0 });
    // And memory_status reports them next to the receipts.
    const status = call<any>(memoryStatus);
    expect(status.reads).toMatchObject({ reads: 4, unlinked: 4 });
    expect(status.host_acknowledgement).toBe('unavailable');
  });

  it('never stores what was asked or what came back', () => {
    write({ title: 'Secretive title', body: 'A narrative nobody should find in the read log.' });
    call<any>(memorySearch, { query: 'secretive narrative query words' });
    const row = JSON.stringify(reads());
    expect(row).not.toMatch(/Secretive|narrative|query words/);
  });

  it('answers a receipt that is gone, unlinked, instead of failing the read', () => {
    const id = write({ title: 'Quota backoff', body: 'Retry with jitter.' });
    const result = call<any>(memoryGet, { ids: [id], receipt_id: 999_999 });
    expect(result.count).toBe(1);
    expect(result.charged_to).toBeNull();
    expect(reads()[0]).toMatchObject({ receipt_id: null, outcome: 'ok' });
  });

  it('logs a failed read as an error and still throws it', () => {
    const id = write({ title: 'Quota backoff', body: 'Retry with jitter.' });
    db.exec('DROP TABLE memory_entry_tags');
    expect(() => call<any>(memoryGet, { ids: [id] })).toThrow();
    expect(reads()).toEqual([expect.objectContaining({ tool: 'memory_get', outcome: 'error', entry_ids: '[]', result_tokens: 0 })]);
  });

  it('answers the read even when the log cannot be written', () => {
    const id = write({ title: 'Quota backoff', body: 'Retry with jitter.' });
    db.exec('DROP TABLE memory_reads');
    expect(call<any>(memoryGet, { ids: [id] }).count).toBe(1);
  });
});
