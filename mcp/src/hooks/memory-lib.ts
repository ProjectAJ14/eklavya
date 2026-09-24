/**
 * The hooks' half of memory capture.
 *
 * Every function here swallows its own failures. A hook must never break a
 * session (`hooks/CLAUDE.md`), and memory is the half of this plugin a
 * developer is *least* willing to lose a session to: it runs on every tool
 * call, so a throw here is a throw on every tool call.
 */
import type { ResolvedConfig } from '../config.js';
import type { EvidenceIdentity } from '../memory/identity.js';
import { drainSpool } from '../memory/capture.js';
import { batchSession, hasClaimableJob, openSessions } from '../memory/store.js';
import { processPending, pruneIfDue, writeSessionSummary } from '../memory/worker.js';
import { parseStamp } from '../time.js';
import { recall } from '../memory/recall.js';
import { notify, queuePausedAlert, sessionWrapUp } from '../memory/notify.js';
import { countEntries } from '../memory/store.js';
import { queueDepth } from '../memory/worker.js';
import type { DB } from './lib.js';
import { isInternalObserver, launchWorker, reserveWorker } from '../memory/reservation.js';

// The per-call capture helpers live in `capture-lib.ts`, so the two hooks that
// run on every tool call and every prompt do not load this module's worker,
// provider, recall and notify graph. Re-exported so the seam hooks and tests
// keep one import.
export { batchIfFull, identityOf, record } from './capture-lib.js';

/**
 * A Stop seam closes a session's open evidence into a batch only past one of
 * these. The Stop hook fires at the end of every turn, and with an observer
 * configured every closed batch is a `claude -p` call — so closing on every turn
 * made a two-event "yes, go ahead" turn cost a model call. Eight events is
 * roughly one real task (a prompt, a few reads, an edit or two, a test run);
 * twenty minutes is long enough that a pause for thought does not split a task,
 * and short enough that an abandoned session's tail is summarised the same
 * afternoon. `batchIfFull` still closes at `memory.batch_max_events` per tool
 * call, and a session start (`all`) closes everything whatever its size.
 */
export const SEAM_MIN_EVENTS = 8;
export const SEAM_MAX_AGE_MS = 20 * 60_000;

/**
 * Closes the project's open evidence that is worth a summary now.
 *
 * Every session in the project, not only this one: a session that ended with
 * two events after its last closed batch has no seam of its own left, so its
 * tail is closed here — at once with `all`, otherwise once it is old enough.
 * That is what keeps the thresholds from stranding anything.
 */
function closeOpenBatches(db: DB, resolved: ResolvedConfig, project: string, all: boolean): void {
  const now = Date.now();
  for (const open of openSessions(db, project)) {
    const oldest = parseStamp(open.oldest);
    const due =
      all ||
      open.events >= SEAM_MIN_EVENTS ||
      // An unreadable stamp is closed rather than kept open for ever.
      oldest === null ||
      now - oldest >= SEAM_MAX_AGE_MS;
    if (!due) continue;
    batchSession(db, {
      project,
      sessionId: open.sessionId,
      reason: 'session_seam',
      maxEvents: resolved.config.memory.batch_max_events,
    });
  }
}

/**
 * The session seam: replay the spool, close what is worth closing, summarise
 * it, and run the retention sweep when it is due.
 *
 * `all` is for a session start, where whatever the last session left open is
 * closed however small; a Stop seam leaves a short fresh turn open to join the
 * next (`SEAM_MIN_EVENTS`, `SEAM_MAX_AGE_MS`).
 *
 * With a provider configured the hook never summarises itself: waiting on a
 * model inside a Stop hook would make the developer wait for it to finish a
 * turn, which PRD LRN-04 forbids. It hands the queue to a detached worker
 * instead and returns.
 */
export async function flushAtSeam(
  db: DB,
  resolved: ResolvedConfig,
  identity: EvidenceIdentity,
  opts: { all?: boolean } = {},
): Promise<void> {
  // Before batching, so a spooled event joins the batch it belongs to.
  replaySpool(db);
  try {
    closeOpenBatches(db, resolved, identity.project, opts.all ?? false);
  } catch {
    /* Evidence left open is closed at the next seam. */
  }
  try {
    pruneIfDue(db, resolved.config, identity.project);
  } catch {
    /* Retention runs again at the next seam; nothing is lost by waiting. */
  }
  try {
    if (resolved.config.providers.observer) {
      // A paused queue is waiting on the developer (a login, a usage limit, a
      // missing `claude`). Launching per seam would relearn that once a turn;
      // `eklavya memory process` is the explicit resume.
      if (hasClaimableJob(db) && queueDepth(db).paused === 0) drainInBackground(db);
      return;
    }
    await processPending(db, resolved.config, { maxJobs: 2 });
  } catch {
    /* Nothing summarised is evidence still on disk, not evidence lost. */
  }
}

/**
 * Starts `eklavya memory process --no-resume` detached and returns at once, so
 * a model summarises the queue without the hook waiting on it.
 *
 * Only after winning the one worker reservation (`reservation.ts`): seams that
 * close together used to spawn a worker each, and each worker's `claude -p`
 * ran these hooks and spawned more. The loser leaves its batch queued for the
 * worker already running. The token travels to the child, which adopts the
 * slot rather than competing for it. `--no-resume` leaves paused jobs paused:
 * un-pausing stays an explicit act.
 */
function drainInBackground(db: DB): void {
  if (isInternalObserver()) return;
  const token = reserveWorker(db);
  if (token) launchWorker(db, token);
}

/** Replays anything the spool holds. Idempotent; safe to call every session. */
export function replaySpool(db: DB): void {
  try {
    drainSpool(db);
  } catch {
    /* The spool keeps what it could not replay. */
  }
}

/**
 * The recalled-evidence block for a session seam, or null.
 *
 * Model context, never the human display (PRD UX-02). Writing the receipt is
 * part of producing it: a block delivered without one is a saving that cannot
 * be checked later, so `recall` does both or neither.
 */
export function recallBlock(db: DB, resolved: ResolvedConfig, identity: EvidenceIdentity, scope: string): string | null {
  try {
    if (!resolved.config.memory.enabled) return null;
    const result = recall(db, resolved.config, {
      project: identity.project,
      sessionId: identity.sessionId,
      scope,
      // The host adds this hook's stdout to the model's context and says so, so
      // delivery is confirmed rather than merely prepared.
      delivery: 'confirmed',
    });
    return result.block;
  } catch {
    return null;
  }
}

/**
 * The most the Stop hook spends on notifications, all of them together. Under
 * the 4-second bound each sink already has plus one second of slack, and a
 * third of the hook's 15-second timeout, which leaves the rest for batching,
 * summarising and the quiz decision.
 */
export const NOTIFY_BUDGET_MS = 5_000;

/**
 * Everything that happens once the seam's work has been flushed: the session
 * summary, the wrap-up, and the one alert worth interrupting for.
 *
 * The summary is written first and outside the notifications gate, because it
 * is memory rather than an announcement — gating it on `notifications.enabled`,
 * which is off by default, would mean nobody ever gets one. The wrap-up and the
 * alert below stay no-ops unless a sink is configured, so a session that has
 * not opted in pays one boolean. Failures are swallowed for the usual reason: a
 * dead webhook must not be how a turn ends.
 */
export async function wrapUpAtSeam(
  db: DB,
  resolved: ResolvedConfig,
  identity: EvidenceIdentity,
): Promise<void> {
  try {
    writeSessionSummary(db, identity.project, identity.sessionId);
  } catch {
    /* A session without a summary still has its observations. */
  }

  if (!resolved.config.notifications.enabled) return;
  try {
    const attempts = db
      .prepare('SELECT COUNT(*) AS n, COALESCE(SUM(grade >= 3), 0) AS passed FROM attempts WHERE session_id = ?')
      .get(identity.sessionId) as { n: number; passed: number };
    const sends: Promise<unknown>[] = [
      notify(
        db,
        resolved.config,
        sessionWrapUp({
          project: identity.project,
          sessionId: identity.sessionId,
          entries: countEntries(db, identity.project),
          questions: attempts.n,
          passed: attempts.passed,
        }),
      ),
    ];

    // A paused queue is capture that has stopped and will not restart by
    // itself. Everything else about memory degrades quietly on purpose; this
    // one is worth saying out loud, once per reason.
    const queue = queueDepth(db);
    if (queue.paused > 0) {
      const reason = db
        .prepare("SELECT error_class FROM memory_jobs WHERE status = 'paused' ORDER BY updated_at DESC LIMIT 1")
        .get() as { error_class: string | null } | undefined;
      sends.push(
        notify(
          db,
          resolved.config,
          queuePausedAlert({
            project: identity.project,
            errorClass: reason?.error_class ?? 'unknown',
            failed: queue.paused + queue.failed,
          }),
        ),
      );
    }

    // Together, not one after the other, and never past the budget: each sink
    // is bounded on its own, but two notifications in turn to the same dead
    // sinks was twice that bound inside a hook with 15 seconds for everything.
    // A send still running at the deadline is abandoned; its ledger row says an
    // attempt started, so a later seam retries it.
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, NOTIFY_BUDGET_MS);
      timer.unref?.();
    });
    await Promise.race([Promise.allSettled(sends), deadline]);
    clearTimeout(timer);
  } catch {
    /* A wrap-up nobody received is a wrap-up. A thrown one is a broken session. */
  }
}
