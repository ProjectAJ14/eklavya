/**
 * The memory health verdict: `ok`, `warn` or `stalled`, read from facts the
 * database already holds. One function feeds `eklavya memory status`,
 * `memory_status`, `eklavya doctor`, the dashboard's Memory workflow and the
 * one session-start line, so they cannot disagree.
 *
 * What it answers is "is memory still turning work into entries", the question a
 * quiet stall (a paused queue, a provider that stopped authenticating, a
 * database that refuses writes) leaves unanswered for weeks. It reads only; it
 * never waits on inference and every probe degrades to "nothing known" rather
 * than throwing, because it also runs on a half-migrated database and inside a
 * hook.
 *
 * Memory evidence cannot change mastery; neither can this.
 */
import type { DB } from '../db.js';
import { parseStamp } from '../time.js';
import { DELIVERED, NOT_HELPER_RECEIPT } from './store.js';
import { lastDropped, droppedCount, spoolBacklog } from './spool.js';
import { queueDepth } from './worker.js';

export type Verdict = 'ok' | 'warn' | 'stalled';

export interface HealthReason {
  level: 'warn' | 'stalled';
  code: string;
  /** One sentence, already worded for a person; never provider text. */
  text: string;
}

export interface HealthFacts {
  newest_entry: string | null;
  newest_evidence: string | null;
  /** Evidence received in the last day: sessions are active. */
  active: boolean;
  /** Oldest unsummarised evidence that arrived after the newest generated entry. */
  behind_since: string | null;
  queue: { pending: number; paused: number; failed: number; quarantined: number; oldest: string | null };
  /** Why the newest paused or failed job stopped, as a fixed label. */
  cause: string | null;
  spool: { bytes: number; files: number; dropped: number };
  sessions_checked: number;
  recall_delivered: number;
  memory_reads: number;
  file_context_fires: number;
  file_reads: number;
}

export interface MemoryHealth {
  verdict: Verdict;
  reasons: HealthReason[];
  facts: HealthFacts;
  /** The session-start line: the worst reason, or null when the verdict is ok. */
  line: string | null;
}

/** A queue or backlog older than this is a stalled worker, not a busy one: a seam drains every turn. */
export const BEHIND_AFTER_MS = 6 * 60 * 60_000;
/** Behind this long while work keeps arriving, memory is stalled. */
export const STALLED_AFTER_MS = 24 * 60 * 60_000;
/** A spooled file that outlives a session start is a database refusing writes. */
const SPOOL_STUCK_MS = 60 * 60_000;
/** A permanently failed job older than this is history, not news. */
const FAILED_RECENT_MS = 7 * 24 * 60 * 60_000;
/** Recent sessions over which recall delivered is compared with reads. */
export const RECENT_SESSIONS = 10;
/** Fewer recalls than this is too little to say anything about reads. */
const MIN_RECALLS = 3;
/** Fewer answerable Reads than this is too little to say file context should have fired. */
const MIN_FILE_READS = 10;

const PAUSE_CAUSE: Record<string, string> = {
  auth: 'claude not logged in',
  quota: 'usage limit reached',
  missing: 'claude not found on PATH',
};

/** Never throws: a half-built database still has to report. */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Why a job stopped, as a fixed phrase. The class is the provider's own
 * vocabulary; `last_error` is only matched, never returned, because it is
 * provider prose that has carried a URL with a token in it.
 */
function causeOf(errorClass: string | null, lastError: string | null): string {
  if (errorClass === 'auth' || /not logged in|please run \/login|\/login/i.test(lastError ?? '')) return PAUSE_CAUSE.auth!;
  return PAUSE_CAUSE[errorClass ?? ''] ?? 'provider failing';
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso.slice(0, 10) : `${d.getDate()} ${d.toLocaleString('en', { month: 'short' })}`;
}

function hours(ms: number): number {
  return Math.floor(ms / 3_600_000);
}

export function memoryHealth(db: DB, opts: { project?: string | null; now?: number } = {}): MemoryHealth {
  const now = opts.now ?? Date.now();
  const project = opts.project ?? null;
  const scope = project ? ' AND project = ?' : '';
  const args = project ? [project] : [];
  const one = <T>(sql: string, ...extra: unknown[]): T | undefined =>
    safely(() => db.prepare(sql).get(...extra) as T | undefined, undefined);

  const queue = safely(() => queueDepth(db), { pending: 0, paused: 0, failed: 0, quarantined: 0, oldest: null as string | null });
  const newestEntry =
    one<{ at: string | null }>(
      `SELECT MAX(created_at) AS at FROM memory_entries WHERE deleted_at IS NULL AND import_source IS NULL${scope}`,
      ...args,
    )?.at ?? null;
  const newestEvidence =
    one<{ at: string | null }>(`SELECT MAX(received_at) AS at FROM evidence_events WHERE 1=1${scope}`, ...args)?.at ?? null;
  // Evidence the pipeline has not turned into an entry since the last entry was
  // written. `julianday` reads both stored timestamp shapes as UTC. A batch whose
  // job was quarantined is set aside on purpose, so it is not "behind".
  const behindSince =
    one<{ at: string | null }>(
      `SELECT MIN(received_at) AS at FROM evidence_events
       WHERE status != 'summarized' AND source != 'import'${scope}
         AND NOT EXISTS (SELECT 1 FROM memory_jobs j WHERE j.batch_id = evidence_events.batch_id AND j.status = 'quarantined')
         AND (? IS NULL OR julianday(received_at) > julianday(?))`,
      ...args,
      newestEntry,
      newestEntry,
    )?.at ?? null;

  const evidenceMs = parseStamp(newestEvidence);
  const active = evidenceMs !== null && now - evidenceMs < STALLED_AFTER_MS;
  const behindMs = parseStamp(behindSince);
  const behindFor = behindMs === null ? 0 : now - behindMs;

  const stuck = one<{ error_class: string | null; last_error: string | null; since: string }>(
    `SELECT error_class, last_error, updated_at AS since FROM memory_jobs
     WHERE status IN ('paused', 'failed') ORDER BY (status = 'paused') DESC, updated_at DESC LIMIT 1`,
  );
  const cause = stuck ? causeOf(stuck.error_class, stuck.last_error) : null;
  const pausedSince = one<{ since: string | null }>(
    "SELECT MIN(updated_at) AS since FROM memory_jobs WHERE status = 'paused'",
  )?.since ?? null;
  const failedRecent =
    one<{ n: number }>(
      "SELECT COUNT(*) AS n FROM memory_jobs WHERE status = 'failed' AND julianday(updated_at) > julianday(?)",
      new Date(now - FAILED_RECENT_MS).toISOString(),
    )?.n ?? 0;

  const spool = spoolBacklog();
  const dropped = safely(() => droppedCount(), 0);
  const droppedAt = parseStamp(safely(() => lastDropped(), null));

  // The last RECENT_SESSIONS sessions that were handed a recall, then what the
  // model did with it in those same sessions.
  const sessions = safely(
    () =>
      (
        db
          .prepare(
            `SELECT session_id FROM context_receipts
             WHERE session_id IS NOT NULL AND ${NOT_HELPER_RECEIPT} AND ${DELIVERED}${scope}
             GROUP BY session_id ORDER BY MAX(id) DESC LIMIT ${RECENT_SESSIONS}`,
          )
          .all(...args) as { session_id: string }[]
      ).map((r) => r.session_id),
    [] as string[],
  );
  const ids = JSON.stringify(sessions);
  const inSessions = 'session_id IN (SELECT value FROM json_each(?))';
  const count = (sql: string, ...extra: unknown[]) => one<{ n: number }>(sql, ...extra)?.n ?? 0;
  const recallDelivered = count(
    `SELECT COUNT(*) AS n FROM context_receipts WHERE ${inSessions} AND ${DELIVERED} AND scope IN ('session_start', 'prompt')${scope}`,
    ids,
    ...args,
  );
  const fileFires = count(
    `SELECT COUNT(*) AS n FROM context_receipts WHERE ${inSessions} AND ${DELIVERED} AND scope = 'file_context'${scope}`,
    ids,
    ...args,
  );
  const memoryReads = count(`SELECT COUNT(*) AS n FROM memory_reads WHERE ${inSessions}${scope}`, ids, ...args);
  // Reads that file context could have answered: a file the parent read (once
  // per file per session, as the hook injects) that an entry already named
  // before the read. A read of a file with no history is not a miss.
  const fileReads = count(
    `SELECT COUNT(*) AS n FROM (
       SELECT DISTINCT e.session_id, f.value FROM evidence_events e, json_each(e.files) f
       WHERE e.session_id IN (SELECT value FROM json_each(?)) AND e.tool = 'Read' AND e.agent_id IS NULL${scope.replace('project', 'e.project')}
         AND EXISTS (
           SELECT 1 FROM memory_entries m, json_each(m.files) mf
           WHERE m.project = e.project AND m.deleted_at IS NULL AND m.superseded_by IS NULL
             AND m.kind != 'session_summary' AND m.files IS NOT NULL AND mf.value = f.value
             AND julianday(m.created_at) < julianday(e.received_at))
     )`,
    ids,
    ...args,
  );

  const recent = `${sessions.length} session${sessions.length === 1 ? '' : 's'}`;
  const reasons: HealthReason[] = [];
  const add = (level: HealthReason['level'], code: string, text: string) => reasons.push({ level, code, text });

  if (queue.paused > 0) {
    const since = pausedSince ? ` since ${shortDate(pausedSince)}` : '';
    const long = (parseStamp(pausedSince) ?? now) <= now - STALLED_AFTER_MS;
    add(
      long ? 'stalled' : 'warn',
      'paused',
      `Memory ${long ? 'stalled' : 'paused'} · ${cause}${since} · local summaries meanwhile · fix it, then: eklavya memory process`,
    );
  }
  const oldestJob = parseStamp(queue.oldest);
  if (oldestJob !== null && now - oldestJob >= BEHIND_AFTER_MS) {
    const stalled = now - oldestJob >= STALLED_AFTER_MS;
    add(
      stalled ? 'stalled' : 'warn',
      'queue_old',
      `Memory ${stalled ? 'stalled' : 'behind'} · ${queue.pending} job${queue.pending === 1 ? '' : 's'} waiting, oldest ${hours(now - oldestJob)}h · run: eklavya doctor`,
    );
  }
  if (behindMs !== null && behindFor >= BEHIND_AFTER_MS && !reasons.some((r) => r.code === 'paused')) {
    const stalled = behindFor >= STALLED_AFTER_MS;
    add(
      stalled ? 'stalled' : 'warn',
      'no_entries',
      `Memory ${stalled ? 'stalled' : 'behind'} · nothing new remembered for ${hours(behindFor)}h while work was captured${
        cause ? ` (${cause})` : ''
      } · run: eklavya memory status`,
    );
  }
  if (failedRecent > 0) {
    add('warn', 'failed', `Memory · ${failedRecent} job${failedRecent === 1 ? '' : 's'} failed this week (${cause}) · run: eklavya memory status`);
  }
  if (spool.oldestMs !== null && now - spool.oldestMs >= SPOOL_STUCK_MS) {
    add('warn', 'spool', `Memory · ${spool.files} spooled file${spool.files === 1 ? '' : 's'} not written to the database for ${hours(now - spool.oldestMs)}h · run: eklavya doctor`);
  }
  if (dropped > 0 && droppedAt !== null && now - droppedAt < FAILED_RECENT_MS) {
    add('warn', 'dropped', `Memory · ${dropped} event${dropped === 1 ? '' : 's'} dropped before reaching the database · run: eklavya memory replay`);
  }
  if (recallDelivered >= MIN_RECALLS && memoryReads === 0) {
    add(
      'warn',
      'no_reads',
      `Memory · recall reached Claude ${recallDelivered} times in the last ${recent} and memory_search was never called`,
    );
  }
  if (fileReads >= MIN_FILE_READS && fileFires === 0) {
    add('warn', 'no_file_context', `Memory · file context never fired across ${fileReads} reads of files with history in the last ${recent}`);
  }

  reasons.sort((a, b) => Number(b.level === 'stalled') - Number(a.level === 'stalled'));
  return {
    verdict: reasons.some((r) => r.level === 'stalled') ? 'stalled' : reasons.length ? 'warn' : 'ok',
    reasons,
    facts: {
      newest_entry: newestEntry,
      newest_evidence: newestEvidence,
      active,
      behind_since: behindSince,
      queue,
      cause,
      spool: { bytes: spool.bytes, files: spool.files, dropped },
      sessions_checked: sessions.length,
      recall_delivered: recallDelivered,
      memory_reads: memoryReads,
      file_context_fires: fileFires,
      file_reads: fileReads,
    },
    line: reasons[0]?.text ?? null,
  };
}
