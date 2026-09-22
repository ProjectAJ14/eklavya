import crypto from 'node:crypto';
import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';
import { nowIso } from '../time.js';
import { ProviderError, ProviderSummarizer } from './provider.js';
import { LocalSummarizer, type Summarizer } from './summarize.js';
import {
  addCandidate,
  batchById,
  batchEvents,
  batchSession,
  claimJob,
  failJob,
  finishJob,
  insertEntry,
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

export interface WorkerResult {
  processed: number;
  entries: number;
  failed: number;
  skipped: number;
}

export async function processPending(
  db: DB,
  config: EklavyaConfig,
  opts: { maxJobs?: number; owner?: string } = {},
): Promise<WorkerResult> {
  const owner = opts.owner ?? `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const maxJobs = opts.maxJobs ?? 3;
  const summarizer = summarizerFor(config);
  const result: WorkerResult = { processed: 0, entries: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < maxJobs; i++) {
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

    try {
      const drafts = await summarizer.summarize({
        project: batch.project,
        sessionId: batch.session_id,
        events,
      });

      // One transaction for the entries, the candidates and the event status:
      // a crash between them would leave events marked done with nothing to
      // show for them, which is the one loss the batch cannot recover from.
      db.transaction(() => {
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
          result.entries++;

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
      })();

      finishJob(db, job.id, owner);
      result.processed++;
    } catch (error) {
      const errorClass = error instanceof ProviderError ? error.errorClass : 'transient';
      failJob(db, job.id, owner, errorClass, error instanceof Error ? error.message : String(error));
      result.failed++;
      // A paused provider will fail the next job the same way; stop rather than
      // burn the remaining budget re-learning that the key is rejected.
      if (errorClass === 'auth' || errorClass === 'quota') break;
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
