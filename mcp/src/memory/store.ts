import crypto from 'node:crypto';
import type { DB } from '../db.js';
import { nowIso } from '../time.js';
import { embedLocal, LOCAL_DIM, LOCAL_EMBEDDER, toBlob } from './embed.js';
import { entryUid, receiptUid } from './identity.js';

/**
 * The memory repository: every write to the `evidence_*`, `memory_*`,
 * `context_receipt*` and `learning_sources` tables goes through here.
 *
 * Deliberately functions over a `DB`, like `store.ts` next door, rather than a
 * class: there is no lifetime to own, and the hooks open and close a database
 * per invocation.
 */

export interface EvidenceInput {
  eventUid: string;
  project: string;
  checkout?: string | null;
  sessionId: string;
  agentId?: string | null;
  host?: string;
  source?: 'hook' | 'replay' | 'manual' | 'import';
  kind: string;
  tool?: string | null;
  title?: string | null;
  body: string;
  files?: string[];
  occurredAt?: string;
  redacted?: boolean;
}

export interface EvidenceRow {
  id: number;
  event_uid: string;
  project: string;
  checkout: string | null;
  session_id: string;
  agent_id: string | null;
  host: string;
  source: string;
  kind: string;
  tool: string | null;
  title: string | null;
  body: string;
  files: string | null;
  occurred_at: string;
  received_at: string;
  redacted: number;
  batch_id: number | null;
  status: string;
}

/**
 * Appends one accepted event. Returns the row id and whether it was new.
 *
 * `INSERT OR IGNORE` on `event_uid` is the convergence point for hook capture
 * and transcript replay (PRD CAP-02): whichever arrives second is a no-op, and
 * neither needs to know the other exists.
 */
export function appendEvent(db: DB, input: EvidenceInput): { id: number; inserted: boolean } {
  const occurredAt = input.occurredAt ?? nowIso();
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO evidence_events
         (event_uid, project, checkout, session_id, agent_id, host, source, kind, tool,
          title, body, files, occurred_at, received_at, redacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventUid,
      input.project,
      input.checkout ?? null,
      input.sessionId,
      input.agentId ?? null,
      input.host ?? 'claude-code',
      input.source ?? 'hook',
      input.kind,
      input.tool ?? null,
      input.title ?? null,
      input.body,
      input.files && input.files.length ? JSON.stringify(input.files) : null,
      occurredAt,
      nowIso(),
      input.redacted ? 1 : 0,
    );

  if (info.changes > 0) return { id: Number(info.lastInsertRowid), inserted: true };
  const existing = db
    .prepare('SELECT id FROM evidence_events WHERE event_uid = ?')
    .get(input.eventUid) as { id: number } | undefined;
  return { id: existing?.id ?? 0, inserted: false };
}

export function eventsForSession(db: DB, sessionId: string, limit = 200): EvidenceRow[] {
  return db
    .prepare('SELECT * FROM evidence_events WHERE session_id = ? ORDER BY occurred_at DESC LIMIT ?')
    .all(sessionId, limit) as EvidenceRow[];
}

export function pendingEventCount(db: DB, project?: string): number {
  const row = project
    ? (db
        .prepare("SELECT COUNT(*) AS n FROM evidence_events WHERE status = 'accepted' AND project = ?")
        .get(project) as { n: number })
    : (db.prepare("SELECT COUNT(*) AS n FROM evidence_events WHERE status = 'accepted'").get() as {
        n: number;
      });
  return row.n;
}

/**
 * Claims the accepted events of one session into an immutable batch and queues
 * a job for it. The claim and the queue are one transaction: a batch with no
 * job is work that silently never happens, and a job with no batch is a request
 * that cannot be reconstructed (PRD DATA-03).
 */
export function batchSession(
  db: DB,
  opts: { project: string; sessionId: string; reason: string; maxEvents?: number },
): { batchId: number; jobId: number; eventCount: number } | null {
  const max = opts.maxEvents ?? 60;
  return db.transaction(() => {
    const events = db
      .prepare(
        `SELECT id, length(body) AS bytes FROM evidence_events
         WHERE status = 'accepted' AND session_id = ? AND project = ?
         ORDER BY occurred_at LIMIT ?`,
      )
      .all(opts.sessionId, opts.project, max) as { id: number; bytes: number }[];
    if (events.length === 0) return null;

    const bytes = events.reduce((sum, e) => sum + e.bytes, 0);
    const batchId = Number(
      db
        .prepare(
          `INSERT INTO memory_batches (project, session_id, reason, event_count, byte_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(opts.project, opts.sessionId, opts.reason, events.length, bytes, nowIso()).lastInsertRowid,
    );

    const claim = db.prepare("UPDATE evidence_events SET status = 'batched', batch_id = ? WHERE id = ?");
    for (const e of events) claim.run(batchId, e.id);

    const jobId = Number(
      db
        .prepare(
          `INSERT INTO memory_jobs (batch_id, kind, status, created_at, updated_at)
           VALUES (?, 'summarize', 'pending', ?, ?)`,
        )
        .run(batchId, nowIso(), nowIso()).lastInsertRowid,
    );

    return { batchId, jobId, eventCount: events.length };
  })();
}

export interface JobRow {
  id: number;
  batch_id: number;
  kind: string;
  status: string;
  attempts: number;
  lease_owner: string | null;
  lease_until: string | null;
  last_error: string | null;
  error_class: string | null;
  next_attempt: string | null;
}

/**
 * Takes the next runnable job under a lease.
 *
 * The lease, not a process list, is what makes "one worker per job" true. A
 * crashed worker's lease expires and the job becomes claimable again; a worker
 * that merely hangs cannot corrupt anything, because completion is a conditional
 * update on the lease it still holds.
 *
 * `next_attempt` is the second gate: a job that just failed transiently is
 * still `pending`, and without it the next hook — seconds later — would claim
 * it again and spend another attempt on a provider that has not recovered.
 */
export function claimJob(db: DB, owner: string, leaseSeconds = 120): JobRow | null {
  const now = nowIso();
  const until = new Date(Date.now() + leaseSeconds * 1000).toISOString();
  return db.transaction(() => {
    const job = db
      .prepare(
        `SELECT * FROM memory_jobs
         WHERE (next_attempt IS NULL OR next_attempt <= ?)
           AND (status = 'pending' OR (status = 'claimed' AND (lease_until IS NULL OR lease_until < ?)))
         ORDER BY id LIMIT 1`,
      )
      .get(now, now) as JobRow | undefined;
    if (!job) return null;
    db.prepare(
      `UPDATE memory_jobs
       SET status = 'claimed', attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
       WHERE id = ?`,
    ).run(owner, until, now, job.id);
    return { ...job, status: 'claimed', attempts: job.attempts + 1, lease_owner: owner, lease_until: until };
  })();
}

export function finishJob(db: DB, jobId: number, owner: string): void {
  db.prepare(
    `UPDATE memory_jobs SET status = 'done', lease_owner = NULL, lease_until = NULL, updated_at = ?
     WHERE id = ? AND lease_owner = ?`,
  ).run(nowIso(), jobId, owner);
}

/** First retry floor, doubled per attempt up to `RETRY_CEILING_MS`. */
const RETRY_BASE_MS = 30_000;
/** Five minutes. Past that the queue is waiting on a human, not on a blip. */
const RETRY_CEILING_MS = 300_000;

/**
 * Records a failure and decides whether — and when — the job may run again.
 *
 * The classification is the point. A timeout should be retried; a rejected API
 * key should not be retried a thousand times at the developer's expense, and a
 * batch whose provider output will never parse should stop rather than spin.
 *
 * A retryable failure carries a floor as well as a verdict. `processPending`
 * runs at every session seam, so "pending" alone means "claimable by whatever
 * happens next", and a provider having a bad minute would take all five
 * attempts inside it. Half the window is fixed and half is jitter, because
 * several checkouts sharing one database and one dead provider otherwise wake
 * up in the same second and retry as a group.
 */
export function failJob(
  db: DB,
  jobId: number,
  owner: string,
  errorClass: 'transient' | 'auth' | 'quota' | 'overflow' | 'malformed' | 'permanent',
  message: string,
  maxAttempts = 5,
  random: () => number = Math.random,
): void {
  const row = db.prepare('SELECT attempts FROM memory_jobs WHERE id = ?').get(jobId) as
    | { attempts: number }
    | undefined;
  const attempts = row?.attempts ?? 0;
  const terminal = errorClass === 'permanent' || errorClass === 'malformed' || attempts >= maxAttempts;
  const paused = errorClass === 'auth' || errorClass === 'quota';
  const window = Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
  db.prepare(
    `UPDATE memory_jobs
     SET status = ?, last_error = ?, error_class = ?, next_attempt = ?,
         lease_owner = NULL, lease_until = NULL, updated_at = ?
     WHERE id = ? AND lease_owner = ?`,
  ).run(
    terminal ? 'failed' : paused ? 'paused' : 'pending',
    message.slice(0, 500),
    errorClass,
    terminal || paused
      ? null
      : new Date(Date.now() + window / 2 + random() * (window / 2)).toISOString(),
    nowIso(),
    jobId,
    owner,
  );
}

/**
 * Puts every paused job back in the queue, and returns how many moved.
 *
 * `failJob` parks an auth or quota failure at 'paused' and nothing else ever
 * moves it, so this is the only way out — deliberately, and deliberately not
 * automatic. Running `eklavya memory process` is the developer saying they have
 * repaired the credential; a hook doing it on their behalf would re-spend a
 * rejected key at every session seam and never say why it stopped again.
 *
 * The attempt count resets with it: a queue paused on its fifth attempt is one
 * that would otherwise be marked permanently failed by the first call after the
 * repair, which is the same dead end with a different label.
 */
export function resumePaused(db: DB): number {
  return db
    .prepare(
      `UPDATE memory_jobs
       SET status = 'pending', attempts = 0, next_attempt = NULL,
           lease_owner = NULL, lease_until = NULL, updated_at = ?
       WHERE status = 'paused'`,
    )
    .run(nowIso()).changes;
}

export function batchEvents(db: DB, batchId: number): EvidenceRow[] {
  return db
    .prepare('SELECT * FROM evidence_events WHERE batch_id = ? ORDER BY occurred_at')
    .all(batchId) as EvidenceRow[];
}

export function batchById(db: DB, batchId: number): { id: number; project: string; session_id: string } | undefined {
  return db.prepare('SELECT id, project, session_id FROM memory_batches WHERE id = ?').get(batchId) as
    | { id: number; project: string; session_id: string }
    | undefined;
}

export interface EntryInput {
  project: string;
  sessionId?: string | null;
  batchId?: number | null;
  kind?: 'observation' | 'session_summary' | 'note';
  type?: string | null;
  title: string;
  narrative?: string;
  facts?: string[];
  files?: string[];
  tags?: string[];
  generator?: string;
  confidence?: number | null;
  occurredAt?: string;
  eventIds?: number[];
  importSource?: string | null;
  entryUid?: string;
}

export interface EntryRow {
  id: number;
  entry_uid: string;
  project: string;
  session_id: string | null;
  batch_id: number | null;
  kind: string;
  type: string | null;
  title: string;
  narrative: string;
  facts: string | null;
  files: string | null;
  generator: string;
  confidence: number | null;
  occurred_at: string;
  created_at: string;
  superseded_by: number | null;
  deleted_at: string | null;
  import_source: string | null;
}

/** Writes an entry, its links, its tags and its vector in one transaction. */
export function insertEntry(db: DB, input: EntryInput): number {
  const occurredAt = input.occurredAt ?? nowIso();
  const uid =
    input.entryUid ??
    entryUid({
      project: input.project,
      title: input.title,
      occurredAt,
      salt: String(input.batchId ?? crypto.randomUUID()),
    });

  return db.transaction(() => {
    const existing = db.prepare('SELECT id FROM memory_entries WHERE entry_uid = ?').get(uid) as
      | { id: number }
      | undefined;
    if (existing) return existing.id;

    const id = Number(
      db
        .prepare(
          `INSERT INTO memory_entries
             (entry_uid, project, session_id, batch_id, kind, type, title, narrative, facts, files,
              generator, confidence, occurred_at, created_at, import_source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          uid,
          input.project,
          input.sessionId ?? null,
          input.batchId ?? null,
          input.kind ?? 'observation',
          input.type ?? null,
          input.title,
          input.narrative ?? '',
          input.facts?.length ? JSON.stringify(input.facts) : null,
          input.files?.length ? JSON.stringify(input.files) : null,
          input.generator ?? 'local-v1',
          input.confidence ?? null,
          occurredAt,
          nowIso(),
          input.importSource ?? null,
        ).lastInsertRowid,
    );

    const tag = db.prepare('INSERT OR IGNORE INTO memory_entry_tags (entry_id, tag) VALUES (?, ?)');
    for (const t of input.tags ?? []) tag.run(id, t.toLowerCase());

    const link = db.prepare('INSERT OR IGNORE INTO memory_entry_events (entry_id, event_id) VALUES (?, ?)');
    for (const eventId of input.eventIds ?? []) link.run(id, eventId);

    indexVector(db, id, vectorText(input));
    return id;
  })();
}

function vectorText(input: EntryInput): string {
  return [input.title, input.narrative ?? '', (input.facts ?? []).join(' '), (input.files ?? []).join(' ')].join('\n');
}

/**
 * Rewrites an entry's content in place and re-indexes it.
 *
 * The one entry that legitimately changes is the session summary: it rolls up a
 * session that is still running, so every seam has more to say than the last.
 * A correction still supersedes rather than edits (MEM-03) — this is not a
 * correction, and neither of the other two options survives being done once a
 * turn. Superseding leaves a dead row per turn in the timeline; hard deleting
 * cascades away the `context_receipt_items` that record what a past recall
 * already cost, rewriting a ledger after the fact.
 *
 * FTS keeps itself in step through the `memory_entries_au` trigger; the vector
 * has no trigger, so it is refreshed here.
 */
export function replaceEntry(db: DB, id: number, input: EntryInput): void {
  db.transaction(() => {
    db.prepare(
      `UPDATE memory_entries
       SET type = ?, title = ?, narrative = ?, facts = ?, files = ?, confidence = ?, occurred_at = ?
       WHERE id = ?`,
    ).run(
      input.type ?? null,
      input.title,
      input.narrative ?? '',
      input.facts?.length ? JSON.stringify(input.facts) : null,
      input.files?.length ? JSON.stringify(input.files) : null,
      input.confidence ?? null,
      input.occurredAt ?? nowIso(),
      id,
    );
    db.prepare('DELETE FROM memory_entry_tags WHERE entry_id = ?').run(id);
    const tag = db.prepare('INSERT OR IGNORE INTO memory_entry_tags (entry_id, tag) VALUES (?, ?)');
    for (const t of input.tags ?? []) tag.run(id, t.toLowerCase());
    indexVector(db, id, vectorText(input));
  })();
}

export function indexVector(db: DB, entryId: number, text: string): void {
  const vec = embedLocal(text);
  db.prepare(
    `INSERT INTO memory_vectors (entry_id, embedder_id, dim, vec) VALUES (?, ?, ?, ?)
     ON CONFLICT(entry_id, embedder_id) DO UPDATE SET vec = excluded.vec, dim = excluded.dim`,
  ).run(entryId, LOCAL_EMBEDDER, LOCAL_DIM, toBlob(vec));
}

export function entryById(db: DB, id: number): EntryRow | undefined {
  return db.prepare('SELECT * FROM memory_entries WHERE id = ?').get(id) as EntryRow | undefined;
}

export function entriesByIds(db: DB, ids: number[]): EntryRow[] {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT * FROM memory_entries WHERE id IN (${placeholders})`)
    .all(...ids) as EntryRow[];
}

export function entryEvents(db: DB, entryId: number): EvidenceRow[] {
  return db
    .prepare(
      `SELECT e.* FROM evidence_events e
       JOIN memory_entry_events m ON m.event_id = e.id
       WHERE m.entry_id = ? ORDER BY e.occurred_at`,
    )
    .all(entryId) as EvidenceRow[];
}

export function entryTags(db: DB, entryId: number): string[] {
  return (db.prepare('SELECT tag FROM memory_entry_tags WHERE entry_id = ?').all(entryId) as {
    tag: string;
  }[]).map((r) => r.tag);
}

/**
 * A correction supersedes rather than edits (PRD MEM-03): the stale claim keeps
 * its evidence links and its place in the audit trail, and retrieval prefers the
 * row that replaced it.
 */
export function supersedeEntry(db: DB, staleId: number, replacementId: number): void {
  db.prepare('UPDATE memory_entries SET superseded_by = ? WHERE id = ?').run(replacementId, staleId);
}

/**
 * Soft delete by default so a deletion is auditable, with a hard mode that also
 * removes the derived index rows — a deletion that leaves the vector behind is
 * a deletion the search can still surface (PRD SEC-02).
 */
export function deleteEntry(db: DB, id: number, hard = false): void {
  if (hard) {
    db.prepare('DELETE FROM memory_entries WHERE id = ?').run(id);
    return;
  }
  db.transaction(() => {
    db.prepare('UPDATE memory_entries SET deleted_at = ? WHERE id = ?').run(nowIso(), id);
    db.prepare('DELETE FROM memory_vectors WHERE entry_id = ?').run(id);
    db.prepare(
      `INSERT INTO memory_fts(memory_fts, rowid, title, narrative, facts, files)
       SELECT 'delete', id, title, narrative, facts, files FROM memory_entries WHERE id = ?`,
    ).run(id);
  })();
}

export interface TimelineFilter {
  project?: string | null;
  sessionId?: string | null;
  /** `observation` | `session_summary` | `note`. Unset means every kind. */
  kind?: string | null;
  type?: string | null;
  since?: string | null;
  until?: string | null;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

/** Stable ordering and a cursor-able offset (PRD RET-02). */
export function timeline(db: DB, filter: TimelineFilter = {}): EntryRow[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.project) {
    where.push('project = ?');
    args.push(filter.project);
  }
  if (filter.sessionId) {
    where.push('session_id = ?');
    args.push(filter.sessionId);
  }
  if (filter.kind) {
    where.push('kind = ?');
    args.push(filter.kind);
  }
  if (filter.type) {
    where.push('type = ?');
    args.push(filter.type);
  }
  if (filter.since) {
    where.push('occurred_at >= ?');
    args.push(filter.since);
  }
  if (filter.until) {
    where.push('occurred_at <= ?');
    args.push(filter.until);
  }
  if (!filter.includeDeleted) where.push('deleted_at IS NULL');

  const sql = `SELECT * FROM memory_entries
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY occurred_at DESC, id DESC
     LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...args, filter.limit ?? 50, filter.offset ?? 0) as EntryRow[];
}

export function countEntries(db: DB, project?: string | null): number {
  const row = project
    ? (db
        .prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE project = ? AND deleted_at IS NULL')
        .get(project) as { n: number })
    : (db.prepare('SELECT COUNT(*) AS n FROM memory_entries WHERE deleted_at IS NULL').get() as {
        n: number;
      });
  return row.n;
}

export interface ReceiptItem {
  entryId: number;
  sourceTokens: number;
  sentTokens: number;
  stage?: 'index' | 'detail';
}

/**
 * Writes one reuse receipt (PRD MET-01). `delivery` is the honesty valve: an
 * adapter that cannot confirm the host consumed the context records `prepared`,
 * and nothing derived from that row is ever shown as a confirmed saving.
 */
export function recordReceipt(
  db: DB,
  opts: {
    project: string;
    sessionId?: string | null;
    scope: string;
    method: string;
    delivery: 'confirmed' | 'unknown' | 'prepared';
    items: ReceiptItem[];
    wrapperTokens?: number;
  },
): number {
  const base = opts.items.reduce((s, i) => s + i.sourceTokens, 0);
  const delivered = opts.items.reduce((s, i) => s + i.sentTokens, 0) + (opts.wrapperTokens ?? 0);
  return db.transaction(() => {
    const id = Number(
      db
        .prepare(
          `INSERT INTO context_receipts
             (receipt_uid, project, session_id, scope, method, base_tokens, delivered_tokens,
              item_count, delivery, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          receiptUid(),
          opts.project,
          opts.sessionId ?? null,
          opts.scope,
          opts.method,
          base,
          delivered,
          opts.items.length,
          opts.delivery,
          nowIso(),
        ).lastInsertRowid,
    );
    const item = db.prepare(
      `INSERT OR REPLACE INTO context_receipt_items (receipt_id, entry_id, source_tokens, sent_tokens, stage)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const i of opts.items) item.run(id, i.entryId, i.sourceTokens, i.sentTokens, i.stage ?? 'index');
    return id;
  })();
}

/**
 * Charges a later detail fetch to the receipt that proposed the entry, so the
 * episode's percentage falls to what the reuse actually cost instead of keeping
 * the optimistic index-only figure (PRD MET-01).
 */
export function chargeDetail(db: DB, receiptId: number, entryId: number, sentTokens: number): void {
  db.transaction(() => {
    db.prepare(
      `INSERT OR REPLACE INTO context_receipt_items (receipt_id, entry_id, source_tokens, sent_tokens, stage)
       VALUES (?, ?, 0, ?, 'detail')`,
    ).run(receiptId, entryId, sentTokens);
    db.prepare(
      `UPDATE context_receipts SET delivered_tokens =
         (SELECT COALESCE(SUM(sent_tokens), 0) FROM context_receipt_items WHERE receipt_id = ?)
       WHERE id = ?`,
    ).run(receiptId, receiptId);
  })();
}

export interface ReceiptTotals {
  base: number;
  delivered: number;
  receipts: number;
  confirmed: number;
}

export function receiptTotals(db: DB, project?: string | null, sinceDays?: number): ReceiptTotals {
  const where: string[] = [];
  const args: unknown[] = [];
  if (project) {
    where.push('project = ?');
    args.push(project);
  }
  if (sinceDays) {
    where.push("created_at >= datetime('now', ?)");
    args.push(`-${sinceDays} days`);
  }
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN delivery = 'confirmed' THEN base_tokens ELSE 0 END), 0) AS base,
              COALESCE(SUM(CASE WHEN delivery = 'confirmed' THEN delivered_tokens ELSE 0 END), 0) AS delivered,
              COUNT(*) AS receipts,
              COALESCE(SUM(CASE WHEN delivery = 'confirmed' THEN 1 ELSE 0 END), 0) AS confirmed
       FROM context_receipts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    )
    .get(...args) as ReceiptTotals;
  return row;
}

export interface CandidateInput {
  entryId?: number | null;
  eventId?: number | null;
  slug: string;
  name: string;
  domain: string;
  confidence: number;
  project?: string | null;
}

/**
 * A concept candidate derived from evidence (PRD LRN-02).
 *
 * `status = 'candidate'` is load-bearing: this row is a proposal, not a
 * concept. Nothing here touches `mastery`, `attempts` or a gate — exposure is
 * not assessment, and the only path to a passing attempt is still answering a
 * question.
 */
export function addCandidate(db: DB, input: CandidateInput): number {
  return Number(
    db
      .prepare(
        `INSERT INTO learning_sources (entry_id, event_id, slug, name, domain, confidence, status, project, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`,
      )
      .run(
        input.entryId ?? null,
        input.eventId ?? null,
        input.slug,
        input.name,
        input.domain,
        input.confidence,
        input.project ?? null,
        nowIso(),
      ).lastInsertRowid,
  );
}

export interface CandidateRow {
  id: number;
  entry_id: number | null;
  event_id: number | null;
  concept_id: number | null;
  slug: string;
  name: string;
  domain: string;
  confidence: number;
  status: string;
  project: string | null;
  created_at: string;
}

export function pendingCandidates(db: DB, project?: string | null, limit = 20): CandidateRow[] {
  const sql = project
    ? `SELECT * FROM learning_sources WHERE status = 'candidate' AND project = ?
       ORDER BY confidence DESC, id LIMIT ?`
    : `SELECT * FROM learning_sources WHERE status = 'candidate' ORDER BY confidence DESC, id LIMIT ?`;
  return (project ? db.prepare(sql).all(project, limit) : db.prepare(sql).all(limit)) as CandidateRow[];
}

export function resolveCandidate(
  db: DB,
  id: number,
  status: 'accepted' | 'rejected' | 'duplicate',
  conceptId?: number | null,
): void {
  db.prepare('UPDATE learning_sources SET status = ?, concept_id = ? WHERE id = ?').run(
    status,
    conceptId ?? null,
    id,
  );
}
