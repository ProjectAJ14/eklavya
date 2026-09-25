import crypto from 'node:crypto';
import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';
import { nowIso, parseStamp } from '../time.js';
import { probeLogin, ProviderError, ProviderSummarizer } from './provider.js';
import { LocalSummarizer, summarizeSession, type Summarizer } from './summarize.js';
import { handOffWorker, launchWorker, releaseWorker, renewWorker } from './reservation.js';
import {
  addCandidate,
  batchById,
  batchEvents,
  batchSession,
  claimJob,
  deleteEntry,
  failJob,
  finishJob,
  hasClaimableJob,
  ownsJob,
  releaseJob,
  pausesQueue,
  insertEntry,
  replaceEntry,
  resumePaused,
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
  /**
   * Why the run ended. Only `limit` and `empty` may hand the slot to a
   * successor: the others are a pause, a cancel, or a lost reservation, and a
   * successor would meet the same thing.
   */
  stopped: 'limit' | 'empty' | 'paused' | 'cancelled' | 'refused';
}

/**
 * Retries a write the database refused, without blocking: a busy database is
 * one other processes are using, and a synchronous spin would stop this one
 * from reaping, heartbeating or answering a signal while it waits.
 */
async function persist(write: () => unknown, ms = 10_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      write();
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
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
    /** The job just claimed, then null once it is settled — for `memory status`. */
    onJob?: (jobId: number | null) => void;
  } = {},
): Promise<WorkerResult> {
  const owner = opts.owner ?? `${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
  const maxJobs = opts.maxJobs ?? 3;
  const summarizer = summarizerFor(config);
  const result: WorkerResult = { processed: 0, entries: 0, failed: 0, skipped: 0, stopped: 'limit' };

  for (let i = 0; i < maxJobs; i++) {
    if (opts.signal?.aborted) {
      result.stopped = 'cancelled';
      break;
    }
    if (opts.beforeJob && !opts.beforeJob()) {
      result.stopped = 'refused';
      break;
    }
    const job = claimJob(db, owner);
    if (!job) {
      result.stopped = 'empty';
      break;
    }
    opts.onJob?.(job.id);

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
      opts.onJob?.(null);

      // One transaction for the entries, the candidates and the event status:
      // a crash between them would leave events marked done with nothing to
      // show for them, which is the one loss the batch cannot recover from.
      const stored = db.transaction(() => {
        // Ownership is checked inside the write, not before it: a worker whose
        // lease lapsed during a slow call must not commit over the one that
        // took the job, however late its answer arrives.
        if (!ownsJob(db, job.id, owner)) return false;
        // The provider's summary is the one this batch was waiting for; the
        // local stand-in written while it was paused (`standInWhilePaused`) goes.
        if (summarizer.id !== STAND_IN.id) retireStandIns(db, batch.id);
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
      opts.onJob?.(null);
      const errorClass = error instanceof ProviderError ? error.errorClass : 'transient';
      if (errorClass === 'cancelled') {
        // Turned off, not broken: the evidence stays queued and the attempt
        // unspent. A cancel is often *because* the database is contended, so
        // this waits for it; failing that, the lease lapses and the job is
        // claimed again with one attempt spent.
        await persist(() => releaseJob(db, job.id, owner));
        result.stopped = 'cancelled';
        break;
      }
      failJob(db, job.id, owner, errorClass, error instanceof Error ? error.message : String(error));
      result.failed++;
      // A paused provider will fail the next job the same way; stop rather than
      // burn the remaining budget re-learning that the key is rejected.
      if (pausesQueue(errorClass)) {
        result.stopped = 'paused';
        break;
      }
    }
  }

  return result;
}

/** The observer a run started with, as something comparable. */
const observerOf = (config: EklavyaConfig): string => JSON.stringify(config.providers.observer ?? null);

export interface SupervisedResult extends WorkerResult {
  /** A successor was launched under the same token. */
  handedOff: boolean;
  /** The slot was given back. False while a provider tree is still alive, or after a hand-off. */
  released: boolean;
}

/**
 * One reserved worker run, from adoption to release: what `eklavya memory
 * process` does once it holds `token`.
 *
 * Every database write on the way — the heartbeat, recording the provider's
 * pid, recording the job — is caught. The shape that took a Mac down was a
 * callback throwing on a busy database: the worker died, the provider tree it
 * had started kept running, and the slot stayed held by nobody. Now a failed
 * write cancels the call, the provider tree is reaped (`runClaude` settles only
 * after that), and only then is the slot released.
 *
 * The settings are re-read every heartbeat and before every job. The run stops
 * — and the job in flight goes back unspent — when memory is turned off *or*
 * when `providers.observer` is no longer the one it started with, whether this
 * run was launched by a hook or by hand. Clearing the observer means no more
 * provider calls, and it has to mean that for every worker.
 *
 * On the way out, a run that ended for want of budget or of work hands the
 * slot straight to a successor if claimable jobs remain (`handOffWorker`):
 * seams that lost the slot while it ran queued their batches expecting a
 * worker, and this is the worker. Bounded by `MAX_GENERATIONS`, and never past
 * a pause or a retry floor, because those jobs are not claimable.
 */
export async function superviseWorker(
  db: DB,
  token: string,
  config: EklavyaConfig,
  opts: {
    maxJobs: number;
    /** Re-read on every heartbeat; a throw keeps the last answer. */
    loadConfig: () => EklavyaConfig;
    /** Aborted to stop the run from outside — SIGTERM, SIGINT. */
    signal?: AbortSignal;
    heartbeatMs?: number;
    /** How a successor is started; tests pass a stand-in. */
    launch?: (db: DB, token: string) => boolean;
  },
): Promise<SupervisedResult> {
  const started = observerOf(config);
  const stillOn = (): boolean => {
    try {
      const now = opts.loadConfig();
      return now.memory.enabled && observerOf(now) === started;
    } catch {
      return true;
    }
  };
  const renew = (patch: { child?: number | null; job?: number | null }): boolean => {
    try {
      return renewWorker(db, token, patch);
    } catch {
      return false;
    }
  };

  const cancel = new AbortController();
  const stop = () => cancel.abort();
  if (opts.signal?.aborted) stop();
  opts.signal?.addEventListener('abort', stop, { once: true });

  // The provider's group while it is alive — cleared only once `runClaude` has
  // confirmed the group empty — and the job being worked on.
  let child: number | null = null;
  let job: number | null = null;
  const heartbeat = setInterval(() => {
    if (!renew({ child, job }) || !stillOn()) cancel.abort();
  }, opts.heartbeatMs ?? 5_000);
  // Cancelled is final: renewing a lease the run is giving up only adds load
  // to a database that may be the reason it gave up.
  cancel.signal.addEventListener('abort', () => clearInterval(heartbeat), { once: true });

  let result: WorkerResult;
  try {
    result = await processPending(db, config, {
      maxJobs: opts.maxJobs,
      signal: cancel.signal,
      // A tree that would not die blocks the next call: one at a time, always.
      beforeJob: () => child === null && renew({ child: null, job: null }) && stillOn(),
      onSpawn: (pid) => {
        child = pid;
        // Thrown into `runClaude`, which cancels the call it just started.
        if (pid !== null && !renew({ child: pid })) throw new Error('could not record the provider call');
      },
      onJob: (id) => {
        job = id;
        renew({ job: id });
      },
    });
  } catch {
    // A database error outside a call (claiming, committing). Any call has
    // already settled, which means its tree has already been reaped.
    result = { processed: 0, entries: 0, failed: 0, skipped: 0, stopped: 'refused' };
  } finally {
    clearInterval(heartbeat);
    opts.signal?.removeEventListener('abort', stop);
  }

  // Descendants outlived SIGKILL: keep the slot, so no other worker starts
  // beside them. The record names the group; recovery can see and end it.
  if (child !== null) return { ...result, handedOff: false, released: false };

  // A stop that landed after the last job — SIGTERM, Ctrl-C, a closed
  // terminal — still means stop: no successor.
  let handedOff = false;
  // The token that holds the slot now: this run's, or its successor's once handed on.
  let holding = token;
  if (
    (result.stopped === 'limit' || result.stopped === 'empty') &&
    config.providers.observer &&
    stillOn() &&
    !cancel.signal.aborted &&
    !opts.signal?.aborted
  ) {
    let next: string | null = null;
    try {
      next = handOffWorker(db, token, () => hasClaimableJob(db) && queueDepth(db).paused === 0);
    } catch {
      next = null;
    }
    // From here on the slot is `next`'s, and this run's `token` matches
    // nothing. A successor that cannot start is released below under `next`.
    if (next) {
      holding = next;
      handedOff = (opts.launch ?? launchWorker)(db, next);
    }
  }
  const released = handedOff ? false : await persist(() => {
    if (!releaseWorker(db, holding)) throw new Error('busy');
  });
  return { ...result, handedOff, released };
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

/**
 * How often a seam may check whether a paused queue can go again. The check
 * itself is free (`claude auth status`), but it is a process spawn on a hook's
 * behalf, and a login does not come back every turn.
 */
export const PROBE_INTERVAL_MS = 30 * 60_000;

/**
 * How long a usage limit is waited out before one job tries again. There is no
 * free check for a quota: the retry is the check, so it costs at most one call
 * per `PROBE_INTERVAL_MS` while the limit lasts.
 */
export const QUOTA_COOLDOWN_MS = 60 * 60_000;

const PROBE_KEY = 'memory_probe_at';

/** True when no seam has launched a paused-queue check in the last interval. */
export function probeDue(db: DB, now = Date.now()): boolean {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(PROBE_KEY) as { value: string } | undefined;
    const last = parseStamp(row?.value ?? null);
    return last === null || now - last >= PROBE_INTERVAL_MS;
  } catch {
    return false;
  }
}

/** Stamped before the launch, so the seams of several open sessions launch one check between them. */
export function markProbe(db: DB, now = Date.now()): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(PROBE_KEY, new Date(now).toISOString());
}

/**
 * Resumes a paused queue once what paused it is fixed, and returns how many
 * jobs moved. Zero when anything is still wrong.
 *
 * A pause used to end only when the developer ran `eklavya memory process`,
 * and nothing said it had started: one expired login on 23 September stopped
 * every summary on one machine for two and a half days, while the banner said
 * "memory on". Resuming without proof would re-spend a rejected credential each
 * session, which is why it was manual; the proof is what makes it safe:
 *
 * - `auth` and `missing` need `claude auth status` to report a login, which
 *   costs no model call.
 * - `quota` needs `QUOTA_COOLDOWN_MS` since the pause. If the limit still holds,
 *   the first job pauses the queue again and the worker stops.
 */
export async function resumeIfRepaired(
  db: DB,
  probe: () => Promise<'ok' | 'auth' | 'missing' | 'unknown'> = () => probeLogin(),
  now = Date.now(),
): Promise<number> {
  const rows = db
    .prepare(
      "SELECT error_class, MAX(updated_at) AS since FROM memory_jobs WHERE status = 'paused' GROUP BY error_class",
    )
    .all() as { error_class: string | null; since: string }[];
  if (!rows.length) return 0;
  for (const row of rows) {
    if (row.error_class === 'quota') {
      const since = parseStamp(row.since);
      if (since !== null && now - since < QUOTA_COOLDOWN_MS) return 0;
    }
  }
  if (rows.some((r) => r.error_class !== 'quota') && (await probe()) !== 'ok') return 0;
  return resumePaused(db);
}

const STAND_IN = new LocalSummarizer();

/** Soft-deletes a batch's stand-in entries: auditable, and out of every search and recall. */
function retireStandIns(db: DB, batchId: number): void {
  const rows = db
    .prepare('SELECT id FROM memory_entries WHERE batch_id = ? AND generator = ? AND deleted_at IS NULL')
    .all(batchId, STAND_IN.id) as { id: number }[];
  for (const { id } of rows) deleteEntry(db, id);
}

/**
 * Local entries for work waiting behind a paused provider, and how many
 * batches it covered.
 *
 * A paused queue used to mean no new memory at all: recall went on serving
 * entries from before the pause, with nothing from the days since. The local
 * summariser needs no login and runs inside a hook, so while the provider is
 * paused each seam writes its extractive entries for up to `max` waiting
 * batches. They are a stand-in, not the summary: the job stays queued, and when
 * the provider summarises the batch its entries replace these (`retireStandIns`).
 *
 * A batch is stood in once — `memory_batches.summarizer` records it — so a batch
 * the local summariser has nothing to say about is not re-read every seam.
 */
export async function standInWhilePaused(db: DB, max = 4): Promise<number> {
  const rows = db
    .prepare(
      `SELECT b.id, b.project, b.session_id FROM memory_jobs j JOIN memory_batches b ON b.id = j.batch_id
       WHERE j.status IN ('pending', 'paused') AND b.summarizer IS NOT ?
         AND NOT EXISTS (SELECT 1 FROM memory_entries e WHERE e.batch_id = b.id AND e.deleted_at IS NULL)
       ORDER BY j.id LIMIT ?`,
    )
    .all(STAND_IN.id, max) as { id: number; project: string; session_id: string }[];
  for (const batch of rows) {
    const events = batchEvents(db, batch.id);
    const drafts = events.length
      ? await STAND_IN.summarize({ project: batch.project, sessionId: batch.session_id, events })
      : [];
    db.transaction(() => {
      for (const draft of drafts) {
        insertEntry(db, {
          project: batch.project,
          sessionId: batch.session_id,
          batchId: batch.id,
          type: draft.type,
          title: draft.title,
          narrative: draft.narrative,
          facts: draft.facts,
          files: draft.files,
          tags: draft.tags,
          generator: STAND_IN.id,
          confidence: draft.confidence,
          occurredAt: events[0]!.occurred_at,
          eventIds: draft.eventIds,
        });
      }
      db.prepare('UPDATE memory_batches SET summarizer = ? WHERE id = ?').run(STAND_IN.id, batch.id);
    })();
  }
  return rows.length;
}

/** Age of the oldest unprocessed job, for the health surfaces. */
export function queueDepth(db: DB): {
  pending: number;
  paused: number;
  failed: number;
  quarantined: number;
  oldest: string | null;
} {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('pending','claimed') THEN 1 ELSE 0 END), 0) AS pending,
         COALESCE(SUM(CASE WHEN status = 'paused' THEN 1 ELSE 0 END), 0) AS paused,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
         COALESCE(SUM(CASE WHEN status = 'quarantined' THEN 1 ELSE 0 END), 0) AS quarantined,
         MIN(CASE WHEN status IN ('pending','claimed') THEN created_at END) AS oldest
       FROM memory_jobs`,
    )
    .get() as { pending: number; paused: number; failed: number; quarantined: number; oldest: string | null };
  return row;
}

/**
 * Retention sweep (PRD SEC-02). Raw evidence ages out; entries are kept.
 *
 * Every summarised event past the window goes, *including* the ones an entry
 * cites. Sparing cited events was the first shape, and it deleted nothing: every
 * summariser links every event it read, so the only events it could ever remove
 * were ones no summary had used. The entry survives with a shorter drill-down —
 * every reader of `memory_entry_events` joins, so a missing event is a shorter
 * list, never an error. Unsummarised evidence is never touched, however old: it
 * is work not yet distilled, and deleting it would lose it outright.
 *
 * **One project per call.** `retention_days` is resolved per project (a project
 * config can set it or unset it) over one shared database, so the sweep only
 * touches rows it can attribute to `project`: that project's evidence, its
 * batches' finished jobs, its receipts, and the `recalled:`/`notified:` rows of
 * sessions that belong to it and to no other project. A bookkeeping row it
 * cannot place is left alone — a few stale `meta` rows are cheaper than one
 * project's policy deleting another's state, which it once did to every
 * project's evidence.
 *
 * The receipts are the one visible cost — the dashboard's savings then cover the
 * retention window rather than all time — and they hold only ids and counts.
 *
 * `limit` caps the events removed in one call so a seam never pays for a
 * backlog in one go. A capped run does not stamp the project's
 * `memory_pruned_at:<project>`, so the next seam carries on instead of waiting
 * out the interval.
 */
export function pruneEvidence(
  db: DB,
  config: EklavyaConfig,
  opts: { project: string; limit?: number },
): number {
  const days = config.memory.retention_days;
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const project = opts.project;

  return db.transaction(() => {
    // Which bookkeeping rows are this project's is read first: the receipts and
    // events that prove a session belongs here are what this pass deletes.
    const keys = (sql: string, params: Record<string, string>) =>
      (db.prepare(sql).all(params) as { key: string }[]).map((r) => r.key);
    const recalled = keys(
      `SELECT key FROM meta WHERE key LIKE 'recalled:%' AND ${ownedSession('substr(key, 10)')}`,
      { project },
    );
    // Ledger rows stop being retried after a day; past the window they only
    // take space. A row this version cannot read is left for what wrote it.
    // `notified:session:<sid>:<sink>` belongs to its session's project;
    // `notified:queue-paused:<project>:…` names the project outright.
    const sessionOf = "substr(key, 18, instr(substr(key, 18), ':') - 1)";
    const notified = keys(
      `SELECT key FROM meta WHERE key LIKE 'notified:%'
         AND (CASE WHEN json_valid(value) THEN json_extract(value, '$.first') END) < @cutoff
         AND ((key LIKE 'notified:session:%' AND ${ownedSession(sessionOf)})
              OR substr(key, 1, length(@paused)) = @paused)`,
      { project, cutoff, paused: `notified:queue-paused:${project}:` },
    );

    const ids = (
      db
        .prepare(
          `SELECT id FROM evidence_events
           WHERE project = ? AND occurred_at < ? AND status = 'summarized' ORDER BY id
           ${opts.limit ? 'LIMIT ?' : ''}`,
        )
        .all(...(opts.limit ? [project, cutoff, opts.limit] : [project, cutoff])) as { id: number }[]
    ).map((r) => r.id);
    const list = JSON.stringify(ids);
    const inList = 'IN (SELECT value FROM json_each(?))';
    // A candidate is a proposal about the learner, not evidence: it outlives the
    // event it came from, which the FK's cascade would otherwise delete.
    db.prepare(`UPDATE learning_sources SET event_id = NULL WHERE event_id ${inList}`).run(list);
    // The FK cascades this too, but only with `foreign_keys` on; said here so a
    // connection opened without it cannot leave links pointing at nothing.
    db.prepare(`DELETE FROM memory_entry_events WHERE event_id ${inList}`).run(list);
    const removed = db.prepare(`DELETE FROM evidence_events WHERE id ${inList}`).run(list).changes;

    db.prepare(
      `DELETE FROM memory_jobs WHERE status = 'done' AND updated_at < ?
         AND batch_id IN (SELECT id FROM memory_batches WHERE project = ?)`,
    ).run(cutoff, project);
    db.prepare(
      `DELETE FROM context_receipt_items WHERE receipt_id IN
         (SELECT id FROM context_receipts WHERE project = ? AND created_at < ?)`,
    ).run(project, cutoff);
    db.prepare('DELETE FROM context_receipts WHERE project = ? AND created_at < ?').run(project, cutoff);
    // `recalled:<session>` has no date of its own; every recall writes a
    // receipt, so a session of this project with none left is over.
    db.prepare(
      `DELETE FROM meta WHERE key ${inList}
         AND substr(key, 10) NOT IN (SELECT session_id FROM context_receipts WHERE session_id IS NOT NULL)`,
    ).run(JSON.stringify(recalled));
    db.prepare(`DELETE FROM meta WHERE key ${inList}`).run(JSON.stringify(notified));

    if (!opts.limit || ids.length < opts.limit) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(prunedKey(project), nowIso());
    }
    return removed;
  })();
}

/**
 * SQL: the session named by `sid` left a trace in `@project` and in no other
 * project. Entries count because they outlive the evidence, so a session stays
 * attributable after its events have aged out.
 */
function ownedSession(sid: string): string {
  const traces = (cmp: string) =>
    ['evidence_events', 'memory_entries', 'context_receipts']
      .map((t) => `EXISTS (SELECT 1 FROM ${t} WHERE session_id = ${sid} AND project ${cmp} @project)`)
      .join(' OR ');
  return `((${traces('=')}) AND NOT (${traces('<>')}))`;
}

/** Each project's last sweep, so one project's run never postpones another's. */
export const prunedKey = (project: string) => `memory_pruned_at:${project}`;

/** How often a seam may run the retention sweep. Retention is counted in days. */
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;
/** Events one seam may delete: enough to keep up, small enough to stay unnoticed inside a hook. */
const PRUNE_SEAM_LIMIT = 5_000;

/**
 * The sweep, from a session seam: this project only, only with its
 * `retention_days` set, at most once per `PRUNE_EVERY_MS` per project, and
 * bounded. `eklavya memory prune` stays the way to run
 * it now and in full.
 */
export function pruneIfDue(db: DB, config: EklavyaConfig, project: string): number {
  if (!config.memory.retention_days) return 0;
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(prunedKey(project)) as { value: string } | undefined;
  const last = row ? parseStamp(row.value) : null;
  if (last !== null && Date.now() - last < PRUNE_EVERY_MS) return 0;
  return pruneEvidence(db, config, { project, limit: PRUNE_SEAM_LIMIT });
}
