import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { capture, captureOrSpool, drainSpool, prepare, type HostEvent } from '../src/memory/capture.js';
import type { EvidenceIdentity } from '../src/memory/identity.js';
import { spoolPath } from '../src/memory/spool.js';
import { LocalSummarizer } from '../src/memory/summarize.js';
import { processPending, pruneEvidence, writeSessionSummary } from '../src/memory/worker.js';
import { appendEvent, batchSession, claimJob, insertEntry, timeline, type EntryRow } from '../src/memory/store.js';
import { search } from '../src/memory/search.js';

const PROJECT = '/tmp/demo-repo';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123';

const IDENTITY: EvidenceIdentity = {
  project: PROJECT,
  checkout: PROJECT,
  sessionId: 's1',
  agentId: null,
  host: 'claude-code',
};

/** A fresh deep copy: a test that mutates the shared default poisons the rest. */
function config(over: Partial<EklavyaConfig> = {}): EklavyaConfig {
  return { ...structuredClone(DEFAULT_CONFIG), ...over };
}

function event(over: Partial<HostEvent> = {}): HostEvent {
  return { kind: 'tool_use', body: 'ran the build', ...over };
}

let dbFile: string;
let db: DB;
let home: string;
let priorHome: string | undefined;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-capture');
  db = openDb(dbFile);
  // The spool joins EKLAVYA_HOME, so without this a test would append to the
  // real learner's spool file.
  priorHome = process.env.EKLAVYA_HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  process.env.EKLAVYA_HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (priorHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = priorHome;
  fs.rmSync(home, { recursive: true, force: true });
  db.close();
  cleanup(dbFile);
});

describe('capture gating', () => {
  it('captures nothing at all when memory is disabled or capture is off', () => {
    const disabled = config();
    disabled.memory.enabled = false;
    expect(prepare(disabled, IDENTITY, event())).toBeNull();

    const off = config();
    off.memory.capture = 'off';
    expect(prepare(off, IDENTITY, event())).toBeNull();
  });

  it('keeps the shape of a session on minimal but drops the per-file traffic', () => {
    const minimal = config();
    minimal.memory.capture = 'minimal';

    expect(prepare(minimal, IDENTITY, event({ kind: 'prompt', body: 'add refresh rotation' }))).not.toBeNull();
    expect(prepare(minimal, IDENTITY, event({ kind: 'lifecycle', body: 'session started' }))).not.toBeNull();
    expect(prepare(minimal, IDENTITY, event({ kind: 'file_read', body: 'cat auth.ts' }))).toBeNull();
    expect(prepare(minimal, IDENTITY, event({ kind: 'tool_use', body: 'ran the build' }))).toBeNull();
  });

  it('never captures Eklavya its own traffic, which would quiz the learner on the quiz', () => {
    expect(prepare(config(), IDENTITY, event({ tool: 'mcp__plugin_eklavya_eklavya__record_attempt' }))).toBeNull();
    expect(prepare(config(), IDENTITY, event({ body: '[Eklavya checkpoint] log the concepts' }))).toBeNull();
    expect(prepare(config(), IDENTITY, event({ tool: 'Edit', body: 'src/auth.ts' }))).not.toBeNull();
  });
});

describe('privacy on the way in', () => {
  it('stores a redacted body, so the raw secret is never on disk to leak later', () => {
    expect(capture(db, config(), IDENTITY, event({ body: `export GITHUB_TOKEN=${SECRET}` }))).toBe('stored');

    const row = db.prepare('SELECT body, redacted FROM evidence_events').get() as {
      body: string;
      redacted: number;
    };
    expect(row.body).not.toContain(SECRET);
    expect(row.redacted).toBe(1);
  });

  it('never lets an excluded path back in through the event body', () => {
    // Keeping the event for its body is how the path rule gets bypassed: the
    // diff of a .env file is the .env file.
    const dropped = prepare(
      config(),
      IDENTITY,
      event({ kind: 'file_edit', body: 'API_KEY=hunter2000', files: [`${PROJECT}/.env`] }),
    );
    expect(dropped).toBeNull();

    const partial = prepare(
      config(),
      IDENTITY,
      event({ kind: 'file_edit', body: 'two files', files: [`${PROJECT}/.env`, `${PROJECT}/src/auth.ts`] }),
    );
    expect(partial?.files).toEqual(['src/auth.ts']);
  });

  it('adds configured patterns and paths to the built-ins rather than replacing them', () => {
    const cfg = config();
    cfg.privacy.redact_patterns = ['ACME-\\d{4}'];
    cfg.privacy.exclude_paths = ['vendor/'];

    const redacted = prepare(cfg, IDENTITY, event({ body: `ticket ACME-1234 used ${SECRET}` }));
    expect(redacted?.body).not.toContain('ACME-1234');
    expect(redacted?.body).not.toContain(SECRET);
    expect(redacted?.redacted).toBe(true);

    const files = prepare(
      cfg,
      IDENTITY,
      event({ kind: 'file_edit', body: 'x', files: [`${PROJECT}/vendor/lib.js`, `${PROJECT}/src/auth.ts`] }),
    );
    expect(files?.files).toEqual(['src/auth.ts']);
    // The built-in list still applies with a configured one present.
    expect(
      prepare(cfg, IDENTITY, event({ kind: 'file_edit', body: 'x', files: [`${PROJECT}/.env`] })),
    ).toBeNull();
  });
});

describe('the spool', () => {
  it('writes a sanitised record when the database is unreachable', () => {
    expect(captureOrSpool(null, config(), IDENTITY, event({ body: `export GITHUB_TOKEN=${SECRET}` }))).toBe('spooled');

    const spooled = fs.readFileSync(spoolPath(), 'utf8');
    // The degraded path must not be the one that writes the secret the healthy
    // path removes.
    expect(spooled).not.toContain(SECRET);
    expect(JSON.parse(spooled.trim()).project).toBe(PROJECT);
  });

  it('replays a spooled event into the database exactly once, however often it drains', () => {
    const outcome = captureOrSpool(null, config(), IDENTITY, event({ body: 'edited auth.ts' }));
    expect(outcome).toBe('spooled');
    const record = JSON.parse(fs.readFileSync(spoolPath(), 'utf8').trim());

    expect(drainSpool(db)).toEqual({ replayed: 1, skipped: 0 });
    expect(drainSpool(db)).toEqual({ replayed: 0, skipped: 0 });

    // Even the same record spooled again converges, because event_uid is the
    // idempotency key rather than the spool file being read only once.
    fs.appendFileSync(spoolPath(), `${JSON.stringify(record)}\n`, 'utf8');
    expect(drainSpool(db)).toEqual({ replayed: 0, skipped: 1 });
    expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_events').get() as { n: number }).n).toBe(1);
  });
});

describe('the job worker', () => {
  function batch(): number {
    capture(db, config(), IDENTITY, event({ kind: 'prompt', body: 'add refresh token rotation' }));
    capture(db, config(), IDENTITY, event({ kind: 'file_edit', body: 'rotated the cookie', files: [`${PROJECT}/src/auth.ts`] }));
    return batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'session_seam' })!.batchId;
  }

  it('turns a batch into an entry and leaves nothing half-done behind it', async () => {
    const batchId = batch();
    const result = await processPending(db, config(), { maxJobs: 1 });

    expect(result.processed).toBe(1);
    expect(result.entries).toBeGreaterThanOrEqual(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number }).n).toBeGreaterThanOrEqual(1);
    // Never the provider: the default config has no observer configured.
    expect((db.prepare('SELECT DISTINCT generator FROM memory_entries').all() as { generator: string }[])).toEqual([
      { generator: 'local-v1' },
    ]);

    const statuses = db
      .prepare('SELECT DISTINCT status FROM evidence_events WHERE batch_id = ?')
      .all(batchId) as { status: string }[];
    expect(statuses).toEqual([{ status: 'summarized' }]);
    expect((db.prepare('SELECT status FROM memory_jobs').get() as { status: string }).status).toBe('done');
  });

  it('survives a summariser failure and leaves the job for the next caller to retry', async () => {
    batch();
    vi.spyOn(LocalSummarizer.prototype, 'summarize').mockRejectedValue(new Error('summariser exploded'));

    const result = await processPending(db, config(), { maxJobs: 1 });
    expect(result).toEqual({ processed: 0, entries: 0, failed: 1, skipped: 0, stopped: 'limit' });

    // A transient failure must not consume the work: the batch is still there
    // and the job is queued. It is held back for a cooldown first — the next
    // caller is usually the next hook, seconds away, and reclaiming it there
    // would spend every attempt inside one bad minute.
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT status FROM memory_jobs').get() as { status: string }).status).toBe('pending');
    expect(claimJob(db, 'someone-else')).toBeNull();

    db.prepare("UPDATE memory_jobs SET next_attempt = '2000-01-01T00:00:00.000Z'").run();
    expect(claimJob(db, 'someone-else')).not.toBeNull();
  });
});

describe('session summaries', () => {
  /** One batch of real work, summarised. `at` keeps the ordering deterministic. */
  async function observation(prompt: string, file: string, at: string, sessionId = 's1'): Promise<void> {
    capture(db, config(), { ...IDENTITY, sessionId }, event({ kind: 'prompt', body: prompt, occurredAt: at }));
    capture(
      db,
      config(),
      { ...IDENTITY, sessionId },
      event({ kind: 'file_edit', body: `edited ${file}`, files: [`${PROJECT}/${file}`], occurredAt: at }),
    );
    batchSession(db, { project: PROJECT, sessionId, reason: 'session_seam' });
    await processPending(db, config(), { maxJobs: 1 });
  }

  function summaries(sessionId = 's1'): EntryRow[] {
    return timeline(db, { project: PROJECT, sessionId, kind: 'session_summary' });
  }

  it('rolls a session of real work into exactly one summary entry at the seam', async () => {
    await observation('add refresh token rotation', 'src/auth.ts', '2026-01-01T09:00:00.000Z');
    await observation('fix the failing migration', 'src/migrations/013.sql', '2026-01-01T10:00:00.000Z');

    expect(writeSessionSummary(db, PROJECT, 's1')).not.toBeNull();

    const rows = summaries();
    expect(rows.length).toBe(1);
    expect(rows[0]!.generator).toBe('session-rollup-v1');
    // It names the work rather than restating one batch of it.
    expect(rows[0]!.narrative).toContain('refresh token rotation');
    expect(rows[0]!.narrative).toContain('failing migration');
    // It sorts above the observations it covers, which is what makes it the
    // first thing the next session's recall is handed.
    expect(timeline(db, { project: PROJECT, sessionId: 's1' })[0]!.kind).toBe('session_summary');
  });

  it('refreshes the one row as the session grows instead of writing a summary per seam', async () => {
    await observation('add refresh token rotation', 'src/auth.ts', '2026-01-01T09:00:00.000Z');
    await observation('fix the failing migration', 'src/migrations/013.sql', '2026-01-01T10:00:00.000Z');
    const first = writeSessionSummary(db, PROJECT, 's1');

    await observation('rename the spool helper', 'src/memory/spool.ts', '2026-01-01T11:00:00.000Z');
    const second = writeSessionSummary(db, PROJECT, 's1');

    expect(second).toBe(first);
    expect(summaries().length).toBe(1);
    expect(summaries()[0]!.narrative).toContain('spool helper');
    // And the derived indexes moved with it: a stale vector is a summary that
    // semantic recall still answers with last hour's work.
    const vectors = db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE entry_id = ?').get(first) as {
      n: number;
    };
    expect(vectors.n).toBe(1);
  });

  it('is findable by search like any other entry', async () => {
    await observation('add refresh token rotation', 'src/auth.ts', '2026-01-01T09:00:00.000Z');
    await observation('fix the failing migration', 'src/migrations/013.sql', '2026-01-01T10:00:00.000Z');
    writeSessionSummary(db, PROJECT, 's1');

    for (const mode of ['keyword', 'semantic', 'hybrid'] as const) {
      const hits = search(db, 'refresh token rotation', mode, { project: PROJECT });
      expect(hits.some((h) => h.entry.kind === 'session_summary')).toBe(true);
    }
  });

  it('writes nothing for a session with nothing worth summarising', async () => {
    // Nothing at all.
    expect(writeSessionSummary(db, PROJECT, 'empty')).toBeNull();

    // And one observation is not a session worth summarising either: the
    // summary would be that observation retyped, competing with its own source
    // for a bounded recall budget for ever.
    await observation('add refresh token rotation', 'src/auth.ts', '2026-01-01T09:00:00.000Z', 'solo');
    expect(writeSessionSummary(db, PROJECT, 'solo')).toBeNull();
    expect(summaries('solo').length).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number }).n).toBe(1);
  });
});

describe('batch provenance', () => {
  it('records which summariser and which configuration read a batch', async () => {
    capture(db, config(), IDENTITY, event({ kind: 'prompt', body: 'add refresh token rotation' }));
    const batchId = batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'session_seam' })!.batchId;
    await processPending(db, config(), { maxJobs: 1 });

    const row = db
      .prepare('SELECT summarizer, config_digest FROM memory_batches WHERE id = ?')
      .get(batchId) as { summarizer: string | null; config_digest: string | null };
    expect(row.summarizer).toBe('local-v1');
    expect(row.config_digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it('records the run even when the summariser fails, which is when it is asked for', async () => {
    capture(db, config(), IDENTITY, event({ kind: 'prompt', body: 'add refresh token rotation' }));
    const batchId = batchSession(db, { project: PROJECT, sessionId: 's1', reason: 'session_seam' })!.batchId;
    vi.spyOn(LocalSummarizer.prototype, 'summarize').mockRejectedValue(new Error('summariser exploded'));

    await processPending(db, config(), { maxJobs: 1 });
    const row = db.prepare('SELECT summarizer FROM memory_batches WHERE id = ?').get(batchId) as {
      summarizer: string | null;
    };
    expect(row.summarizer).toBe('local-v1');
  });

  it('changes the digest when a setting that shapes a summary changes', async () => {
    const other = config();
    other.privacy.redact_patterns = ['ACME-\\d{4}'];

    const digests = new Set<string>();
    for (const [i, cfg] of [config(), other].entries()) {
      capture(db, config(), { ...IDENTITY, sessionId: `s${i}` }, event({ kind: 'prompt', body: `work ${i}` }));
      const batchId = batchSession(db, { project: PROJECT, sessionId: `s${i}`, reason: 'manual' })!.batchId;
      await processPending(db, cfg, { maxJobs: 1 });
      digests.add(
        (db.prepare('SELECT config_digest AS d FROM memory_batches WHERE id = ?').get(batchId) as { d: string }).d,
      );
    }
    expect(digests.size).toBe(2);
  });
});

describe('retention', () => {
  it('ages out old summarised evidence, cited or not, and keeps what is young or not yet summarised', () => {
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 86_400_000).toISOString();

    const add = (uid: string, occurredAt: string) =>
      appendEvent(db, { eventUid: uid, project: PROJECT, sessionId: 's1', kind: 'tool_use', body: uid, occurredAt }).id;

    const stale = add('stale', old);
    const unsummarized = add('unsummarized', old);
    const cited = add('cited', old);
    const young = add('young', recent);
    db.prepare("UPDATE evidence_events SET status = 'summarized' WHERE id IN (?, ?, ?)").run(stale, cited, young);
    insertEntry(db, { project: PROJECT, title: 'Cites the old event', eventIds: [cited] });

    const cfg = config();
    cfg.memory.retention_days = 7;
    // Sparing cited events used to mean sparing all of them: every summariser
    // links every event it read. `memory-retention.test.ts` has the rest.
    expect(pruneEvidence(db, cfg)).toBe(2);

    const left = (db.prepare('SELECT event_uid FROM evidence_events ORDER BY event_uid').all() as {
      event_uid: string;
    }[]).map((r) => r.event_uid);
    expect(left).toEqual(['unsummarized', 'young']);
    expect(unsummarized).toBeGreaterThan(0);

    // `null` means keep until deleted by hand, and must not fall through to a
    // cutoff of "now".
    const forever = config();
    forever.memory.retention_days = null;
    expect(pruneEvidence(db, forever)).toBe(0);
  });
});
