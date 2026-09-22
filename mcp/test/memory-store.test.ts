import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import {
  addCandidate,
  appendEvent,
  batchEvents,
  batchSession,
  chargeDetail,
  claimJob,
  countEntries,
  deleteEntry,
  failJob,
  finishJob,
  insertEntry,
  pendingCandidates,
  pendingEventCount,
  receiptTotals,
  recordReceipt,
  resumePaused,
  supersedeEntry,
  timeline,
} from '../src/memory/store.js';
import { hybridSearch, keywordSearch, semanticSearch } from '../src/memory/search.js';
import { eventUid } from '../src/memory/identity.js';
import { redact, pathExcluded, isOwnTraffic } from '../src/memory/privacy.js';
import { savingsFrom, savingsLine } from '../src/memory/tokens.js';

const PROJECT = '/tmp/demo-repo';

let dbFile: string;
let db: DB;

function event(body: string, over: Partial<Parameters<typeof appendEvent>[1]> = {}) {
  return appendEvent(db, {
    eventUid: eventUid({ host: 'claude-code', sessionId: 's1', kind: 'tool_use', occurredAt: body, body }),
    project: PROJECT,
    sessionId: 's1',
    kind: 'tool_use',
    body,
    ...over,
  });
}

beforeEach(() => {
  dbFile = tempDbPath('eklavya-memory');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
});

describe('evidence capture', () => {
  it('is idempotent on event_uid so replay cannot duplicate a hook capture', () => {
    const first = event('edited auth.ts');
    const second = event('edited auth.ts');
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(pendingEventCount(db, PROJECT)).toBe(1);
  });

  it('batches accepted events and queues exactly one job for them', () => {
    event('a');
    event('b');
    const batch = batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'session_seam' });
    expect(batch?.eventCount).toBe(2);
    expect(pendingEventCount(db, PROJECT)).toBe(0);
    expect(batchEvents(db, batch!.batchId)).toHaveLength(2);
    // Nothing left to batch: a second call must not produce an empty job.
    expect(batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'session_seam' })).toBeNull();
  });
});

describe('jobs', () => {
  it('leases a job, and an expired lease makes it claimable again', () => {
    event('a');
    batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'manual' });
    const mine = claimJob(db, 'worker-1');
    expect(mine).not.toBeNull();
    expect(claimJob(db, 'worker-2')).toBeNull();

    db.prepare("UPDATE memory_jobs SET lease_until = '2000-01-01T00:00:00.000Z'").run();
    const stolen = claimJob(db, 'worker-2');
    expect(stolen?.id).toBe(mine!.id);
    finishJob(db, stolen!.id, 'worker-2');
    expect(claimJob(db, 'worker-3')).toBeNull();
  });

  it('pauses on auth failure and gives up on malformed output', () => {
    event('a');
    batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'manual' });
    const job = claimJob(db, 'w')!;
    failJob(db, job.id, 'w', 'auth', 'no key');
    expect((db.prepare('SELECT status FROM memory_jobs WHERE id = ?').get(job.id) as { status: string }).status).toBe('paused');

    db.prepare("UPDATE memory_jobs SET status = 'pending'").run();
    const again = claimJob(db, 'w')!;
    failJob(db, again.id, 'w', 'malformed', 'bad json');
    expect((db.prepare('SELECT status FROM memory_jobs WHERE id = ?').get(job.id) as { status: string }).status).toBe('failed');
  });

  it('hides a paused job from the worker until the documented resume runs', () => {
    event('a');
    batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'manual' });
    const job = claimJob(db, 'w')!;
    failJob(db, job.id, 'w', 'auth', 'rejected key');

    // The auto path — every hook seam — must leave it alone, whatever the
    // attempt count, or a dead credential is re-spent once per session.
    expect(claimJob(db, 'hook')).toBeNull();
    db.prepare('UPDATE memory_jobs SET attempts = 5').run();

    // `eklavya memory process` is what doctor tells the developer to run.
    expect(resumePaused(db)).toBe(1);
    const resumed = claimJob(db, 'w2');
    expect(resumed?.id).toBe(job.id);
    // Reset, not carried: one claim of a five-attempt job fails it outright.
    expect(resumed?.attempts).toBe(1);
    expect(resumePaused(db)).toBe(0);
  });

  it('holds a transient failure back until its cooldown passes', () => {
    event('a');
    batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'manual' });
    const job = claimJob(db, 'w')!;
    failJob(db, job.id, 'w', 'transient', 'timeout', 5, () => 0);

    const row = db.prepare('SELECT status, next_attempt FROM memory_jobs WHERE id = ?').get(job.id) as {
      status: string;
      next_attempt: string | null;
    };
    expect(row.status).toBe('pending');
    // First attempt, zero jitter: half of the 30s window.
    expect(Date.parse(row.next_attempt!) - Date.now()).toBeGreaterThan(10_000);
    expect(claimJob(db, 'hook')).toBeNull();

    db.prepare("UPDATE memory_jobs SET next_attempt = '2000-01-01T00:00:00.000Z'").run();
    expect(claimJob(db, 'hook')?.id).toBe(job.id);
  });
});

describe('entries and retrieval', () => {
  function seed() {
    insertEntry(db, {
      project: PROJECT,
      sessionId: 's1',
      title: 'Refresh cookie rotation',
      narrative: 'Rotated the refresh cookie on every use and stored the jti.',
      facts: ['httpOnly is set on the refresh cookie'],
      files: ['src/auth.ts'],
      tags: ['auth', 'cookies'],
      type: 'feature',
    });
    insertEntry(db, {
      project: PROJECT,
      title: 'SQLite WAL checkpointing',
      narrative: 'Checkpoint starvation under concurrent readers.',
      files: ['src/db.ts'],
      tags: ['sqlite'],
      type: 'discovery',
    });
    insertEntry(db, {
      project: '/tmp/other-repo',
      title: 'Refresh cookie rotation elsewhere',
      narrative: 'A different codebase entirely.',
      type: 'feature',
    });
  }

  it('keeps retrieval inside the project unless asked otherwise', () => {
    seed();
    expect(keywordSearch(db, 'refresh cookie', { project: PROJECT })).toHaveLength(1);
    expect(keywordSearch(db, 'refresh cookie', { project: PROJECT, allProjects: true })).toHaveLength(2);
  });

  it('treats a multi-word query as terms, not a phrase', () => {
    seed();
    expect(keywordSearch(db, 'rotation cookie refresh', { project: PROJECT })).toHaveLength(1);
    expect(keywordSearch(db, 'checkpoint (starvation?)', { project: PROJECT })).toHaveLength(1);
    expect(keywordSearch(db, '', { project: PROJECT })).toHaveLength(0);
  });

  it('finds a morphological variant semantically that keyword search misses', () => {
    seed();
    expect(keywordSearch(db, 'checkpointed', { project: PROJECT })).toHaveLength(0);
    expect(semanticSearch(db, 'checkpointed', { project: PROJECT }).length).toBeGreaterThan(0);
    expect(hybridSearch(db, 'checkpointed', { project: PROJECT }).length).toBeGreaterThan(0);
  });

  it('hides superseded and deleted entries from retrieval but keeps the audit trail', () => {
    seed();
    const replacement = insertEntry(db, {
      project: PROJECT,
      title: 'Refresh cookie rotation corrected',
      narrative: 'The jti is stored hashed, not raw.',
    });
    const stale = keywordSearch(db, 'refresh cookie rotation', { project: PROJECT })[0]!.entry.id;
    supersedeEntry(db, stale, replacement);
    expect(keywordSearch(db, 'jti', { project: PROJECT })).toHaveLength(1);
    expect(keywordSearch(db, 'rotated', { project: PROJECT })).toHaveLength(0);
    expect(timeline(db, { project: PROJECT }).some((e) => e.id === stale)).toBe(true);

    deleteEntry(db, replacement);
    expect(keywordSearch(db, 'jti', { project: PROJECT })).toHaveLength(0);
    expect(countEntries(db, PROJECT)).toBe(2);
  });
});

describe('savings receipts', () => {
  it('records base and delivered tokens, and a detail fetch revises the same episode', () => {
    const entry = insertEntry(db, { project: PROJECT, title: 'A thing', narrative: 'x'.repeat(400) });
    const receipt = recordReceipt(db, {
      project: PROJECT,
      scope: 'session_start',
      method: 'chars4-v1',
      delivery: 'confirmed',
      items: [{ entryId: entry, sourceTokens: 100, sentTokens: 10 }],
    });
    let totals = receiptTotals(db, PROJECT);
    expect(savingsFrom({ baseTokens: totals.base, deliveredTokens: totals.delivered, delivery: 'confirmed' })).toEqual({
      kind: 'saving',
      percent: 90,
      base: 100,
      delivered: 10,
    });

    chargeDetail(db, receipt, entry, 95);
    totals = receiptTotals(db, PROJECT);
    // The index line stays on the receipt; the detail is charged on top of it,
    // which is the point -- the episode gets more expensive, not cheaper.
    expect(totals.delivered).toBe(105);
  });

  it('never dresses an unconfirmed or negative result as a saving', () => {
    expect(savingsFrom({ baseTokens: 0, deliveredTokens: 0, delivery: 'confirmed' }).kind).toBe('none');
    expect(savingsFrom({ baseTokens: 100, deliveredTokens: 10, delivery: 'prepared' }).kind).toBe('unavailable');
    const over = savingsFrom({ baseTokens: 10, deliveredTokens: 40, delivery: 'confirmed' });
    expect(over).toEqual({ kind: 'overhead', tokens: 30, base: 10, delivered: 40 });
    expect(savingsLine(over)).toBe('Reuse overhead: 30 tokens (estimated)');
  });
});

describe('learning candidates', () => {
  it('stores a candidate without touching mastery or attempts', () => {
    const entry = insertEntry(db, { project: PROJECT, title: 'Used a WAL checkpoint' });
    addCandidate(db, { entryId: entry, slug: 'wal-checkpointing', name: 'WAL checkpointing', domain: 'sqlite', confidence: 0.6, project: PROJECT });
    expect(pendingCandidates(db, PROJECT)).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM mastery').get() as { n: number }).n).toBe(0);
  });
});

describe('privacy filter', () => {
  it('redacts secrets before anything is stored', () => {
    const out = redact('export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 and password: hunter2000');
    expect(out.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(out.text).not.toContain('hunter2000');
    expect(out.redacted).toBe(true);
  });

  it('excludes secret-bearing paths and Eklavya its own traffic', () => {
    expect(pathExcluded('/repo/.env.local')).toBe(true);
    expect(pathExcluded('/repo/src/auth.ts')).toBe(false);
    expect(isOwnTraffic('mcp__plugin_eklavya_eklavya__record_attempt', '{}')).toBe(true);
    expect(isOwnTraffic('Edit', 'src/auth.ts')).toBe(false);
  });
});
