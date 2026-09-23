import crypto from 'node:crypto';
import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';
import { nowIso } from '../time.js';
import { ProviderError, ProviderSummarizer } from './provider.js';
import { LocalSummarizer, summarizeSession, type Summarizer } from './summarize.js';
import {
  addCandidate,
  batchById,
  batchEvents,
  batchSession,
  claimJob,
  failJob,
  finishJob,
  ownsJob,
  releaseJob,
  pausesQueue,
  insertEntry,
  replaceEntry,
  timeline,
} from './store.js';

/**
 * The job worker (ADR-05).
 *
 * There is no daemon. Hooks and the CLI call `processPending` at the seams
 * where work naturally arrives, under a lease that makes concurrent callers
 * safe. The failure this avoids is the reference's worst class: an orphaned
 * background process holding a port, restarted by self-healing after the
 * developer uninstalled it.
 *
 * `processPending` is bounded by `maxJobs` and never throws: a memory failure
 * must not take a coding session with it.
 */

export function summarizerFor(config: EklavyaConfig): Summarizer {
  return config.providers.observer ? new ProviderSummarizer(config.providers.observer) : new LocalSummarizer();
}

/**
 * What governed one summarisation run (PRD MEM-01: "a versioned input batch and
 * prompt/config identity").
 *
 * `generator` on an entry names the summariser, but only after the fact and
 * only for a batch that produced something — a batch that came out wrong, or
 * empty, leaves no row to ask. Recorded on the batch, it is what makes "re-run
 * this batch against the prompt that produced it" an answerable question.
 *
 * The digest covers the three settings that change what a summary comes out as:
 * what capture accepted, what redaction removed from it, and which model read
 * it. `ProviderConfig` is a kind and a model — the model runs on the
 * subscription, so there is no key to hash (SEC-01).
 *
 * ponytail: the provider's system prompt is versioned by `provider.ts` alone —
 * `summarizer.id` carries the model, not the prompt. Fold a prompt version into
 * `ProviderSummarizer.id` once that prompt starts changing between releases.
 */
function configDigest(config: EklavyaConfig): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([config.memory, config.privacy, config.providers.observer]))
    .digest('hex')
    .slice(0, 12);
}

/**
 * The roll-up's own generator id, versioned like any other summariser, so an
 * entry always says which code wrote it.
 */
const SESSION_SUMMARY_GENERATOR = 'session-rollup-v1';

/**
 * Writes — or refreshes — this session's summary. Returns its entry id, or null
 * when the session has nothing worth summarising.
 *
 * Called at the session seam, which fires at the end of every turn rather than
 * once at the end of a session, so the row is rewritten in place as the session
 * grows instead of one summary being written per turn.
 *
 * ponytail: with `providers.observer` set, the seam hands the batch to a
 * background worker, so the last turn's observations land after this ran and
 * the summary trails them by one turn until the next seam. Move the call after
 * `processPending` if the provider path ever stops being asynchronous.
 */
export function writeSessionSummary(db: DB, project: string, sessionId: string): number | null {
  // Bounded: the oldest observations of a day-long session are not where it
  // left off, and an unbounded roll-up is an unbounded row in every recall.
  const observations = timeline(db, { project, sessionId, kind: 'observation', limit: 24 });
  const draft = summarizeSession(observations);
  if (!draft) return null;

  const fields = {
    project,
    sessionId,
    kind: 'session_summary' as const,
    type: draft.type,
    title: draft.title,
    narrative: draft.narrative,
    facts: draft.facts,
    files: draft.files,
    tags: draft.tags,
    generator: SESSION_SUMMARY_GENERATOR,
    confidence: draft.confidence,
    // The newest observation's time, so the summary sorts above the work it
    // covers instead of below the session's first batch.
    occurredAt: observations[0]!.occurred_at,
    eventIds: draft.eventIds,
  };

  const existing = timeline(db, { project, sessionId, kind: 'session_summary', limit: 1 })[0];
  if (existing) {
    replaceEntry(db, existing.id, fields);
    return existing.id;
  }
  return insertEntry(db, fields);
}

export interface WorkerResult {
  processed: number;
  entries: number;
  failed: number;
  skipped: number;
}

export async function processPending(
  db: DB,
  config: EklavyaConfig,
  opts: {
    maxJobs?: number;
    owner?: string;
    /** Aborted when memory is turned off: the running call ends, the job goes back. */
    signal?: AbortSignal;
    /** Asked before each claim; false stops the run (lost reservation, config off). */
    beforeJob?: () => boolean;
    onSpawn?: (pid: number | null) => void;
  } = {},
): Promise<WorkerResult> {
  const owner = opts.owner ?? `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const maxJobs = opts.maxJobs ?? 3;
  const summarizer = summarizerFor(config);
  const result: WorkerResult = { processed: 0, entries: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < maxJobs; i++) {
    if (opts.signal?.aborted || (opts.beforeJob && !opts.beforeJob())) break;
    const job = claimJob(db, owner);
    if (!job) break;

    const batch = batchById(db, job.batch_id);
    const events = batchEvents(db, job.batch_id);
    if (!batch || events.length === 0) {
      // A batch with no events cannot produce anything and will never succeed.
      finishJob(db, job.id, owner);
      result.skipped++;
      continue;
    }

    // Before the call, not after it: a batch that fails is the one whose
    // provenance someone comes looking for.
    db.prepare('UPDATE memory_batches SET summarizer = ?, config_digest = ? WHERE id = ?').run(
      summarizer.id,
      configDigest(config),
      batch.id,
    );

    try {
      const drafts = await summarizer.summarize({
        project: batch.project,
        sessionId: batch.session_id,
        events,
      }, { signal: opts.signal, onSpawn: opts.onSpawn });

      // One transaction for the entries, the candidates and the event status:
      // a crash between them would leave events marked done with nothing to
      // show for them, which is the one loss the batch cannot recover from.
      const stored = db.transaction(() => {
        // Ownership is checked inside the write, not before it: a worker whose
        // lease lapsed during a slow call must not commit over the one that
        // took the job, however late its answer arrives.
        if (!ownsJob(db, job.id, owner)) return false;
        for (const draft of drafts) {
          const entryId = insertEntry(db, {
            project: batch.project,
            sessionId: batch.session_id,
            batchId: batch.id,
            type: draft.type,
            title: draft.title,
            narrative: draft.narrative,
            facts: draft.facts,
            files: draft.files,
            tags: draft.tags,
            generator: summarizer.id,
            confidence: draft.confidence,
            occurredAt: events[0]!.occurred_at,
            eventIds: draft.eventIds,
          });
          for (const concept of draft.concepts ?? []) {
            addCandidate(db, {
              entryId,
              slug: concept.slug,
              name: concept.name,
              domain: concept.domain,
              confidence: draft.confidence,
              project: batch.project,
            });
          }
        }
        db.prepare("UPDATE evidence_events SET status = 'summarized' WHERE batch_id = ?").run(batch.id);
        finishJob(db, job.id, owner);
        return true;
      })();

      if (!stored) {
        result.skipped++;
        continue;
      }
      result.entries += drafts.length;
      result.processed++;
    } catch (error) {
      const errorClass = error instanceof ProviderError ? error.errorClass : 'transient';
      if (errorClass === 'cancelled') {
        // Turned off, not broken: the evidence stays queued and the attempt unspent.
        releaseJob(db, job.id, owner);
        break;
      }
      failJob(db, job.id, owner, errorClass, error instanceof Error ? error.message : String(error));
      result.failed++;
      // A paused provider will fail the next job the same way; stop rather than
      // burn the remaining budget re-learning that the key is rejected.
      if (pausesQueue(errorClass)) break;
    }
  }

  return result;
}

/**
 * The session seam: close the open batch and drain the queue.
 *
 * Called by the Stop hook and by `eklavya memory flush`. Batching at the seam
 * rather than per tool call is what keeps one provider request from riding on
 * every edit (PRD MEM-01).
 */
export async function flushSession(
  db: DB,
  config: EklavyaConfig,
  project: string,
  sessionId: string,
  reason = 'session_seam',
): Promise<WorkerResult> {
  batchSession(db, { project, sessionId, reason, maxEvents: config.memory.batch_max_events });
  return processPending(db, config, { maxJobs: 4 });
}

/** Age of the oldest unprocessed job, for the health surfaces. */
export function queueDepth(db: DB): { pending: number; paused: number; failed: number; oldest: string | null } {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('pending','claimed') THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END), 0) AS paused,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
         MIN(CASE WHEN status IN ('pending','claimed') THEN created_at END) AS oldest
       FROM memory_jobs`,
    )
    .get() as { pending: number; paused: number; failed: number; oldest: string | null };
  return row;
}

/** Retention sweep (PRD SEC-02). Raw evidence ages out; entries are kept. */
export function pruneEvidence(db: DB, config: EklavyaConfig): number {
  const days = config.memory.retention_days;
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const info = db
    .prepare(
      `DELETE FROM evidence_events
       WHERE occurred_at < ? AND status = 'summarized'
         AND id NOT IN (SELECT event_id FROM memory_entry_events)`,
    )
    .run(cutoff);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('memory_pruned_at', ?)").run(nowIso());
  return info.changes;
}
