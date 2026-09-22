/**
 * The hooks' half of memory capture.
 *
 * Every function here swallows its own failures. A hook must never break a
 * session (`hooks/CLAUDE.md`), and memory is the half of this plugin a
 * developer is *least* willing to lose a session to: it runs on every tool
 * call, so a throw here is a throw on every tool call.
 */
import type { ResolvedConfig } from '../config.js';
import { projectKey } from '../store.js';
import { identityFor, type EvidenceIdentity } from '../memory/identity.js';
import { capture, drainSpool, type HostEvent } from '../memory/capture.js';
import { batchSession, pendingEventCount } from '../memory/store.js';
import { processPending, writeSessionSummary } from '../memory/worker.js';
import { recall, recallForPrompt } from '../memory/recall.js';
import { notify, queuePausedAlert, sessionWrapUp } from '../memory/notify.js';
import { countEntries } from '../memory/store.js';
import { queueDepth } from '../memory/worker.js';
import type { DB, HookInput } from './lib.js';

export function identityOf(input: HookInput, cwd: string, sid: string | null): EvidenceIdentity {
  const identity = identityFor({
    cwd,
    sessionId: sid ?? 'default',
    agentId: input.agent_id ?? null,
    host: 'claude-code',
  });
  // `identityFor` resolves the project from the cwd; `projectKey` is the
  // learning half's spelling of the same thing, and the two must not diverge or
  // a memory and a mastery row disagree about which codebase they belong to.
  return { ...identity, project: projectKey(identity.checkout) };
}

/** Records one event. Returns false on any failure, and never throws. */
export function record(
  db: DB,
  resolved: ResolvedConfig,
  identity: EvidenceIdentity,
  event: HostEvent,
): boolean {
  try {
    return capture(db, resolved.config, identity, event) === 'stored';
  } catch {
    return false;
  }
}

/**
 * Closes a batch once enough evidence has accumulated. Batching is cheap SQL;
 * summarising is not, so this never summarises — the seam does.
 */
export function batchIfFull(db: DB, resolved: ResolvedConfig, identity: EvidenceIdentity): void {
  try {
    const max = resolved.config.memory.batch_max_events;
    if (pendingEventCount(db, identity.project) < max) return;
    batchSession(db, {
      project: identity.project,
      sessionId: identity.sessionId,
      reason: 'size',
      maxEvents: max,
    });
  } catch {
    /* A batch that did not close is one that closes at the seam instead. */
  }
}

/**
 * The session seam: close what is open and summarise it.
 *
 * With a provider configured this only *queues* the work. Waiting on inference
 * inside a Stop hook would make the developer wait for an API call to finish a
 * turn, which PRD LRN-04 forbids; the next session start, or `eklavya memory
 * process`, drains it.
 */
export async function flushAtSeam(db: DB, resolved: ResolvedConfig, identity: EvidenceIdentity): Promise<void> {
  try {
    batchSession(db, {
      project: identity.project,
      sessionId: identity.sessionId,
      reason: 'session_seam',
      maxEvents: resolved.config.memory.batch_max_events,
    });
    if (resolved.config.providers.observer) return;
    await processPending(db, resolved.config, { maxJobs: 2 });
  } catch {
    /* Nothing summarised is evidence still on disk, not evidence lost. */
  }
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
 * Recall for one prompt, mid-session, or null.
 *
 * Silent far more often than not: too short a prompt, nothing relevant, or
 * nothing this session has not already been handed. That is the design — a
 * recall on every turn is a tax on every turn.
 */
export function promptRecall(
  db: DB,
  resolved: ResolvedConfig,
  identity: EvidenceIdentity,
  prompt: string,
): string | null {
  try {
    if (!resolved.config.memory.enabled) return null;
    const result = recallForPrompt(db, resolved.config, {
      project: identity.project,
      sessionId: identity.sessionId,
      prompt,
    });
    return result?.block ?? null;
  } catch {
    return null;
  }
}

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
    await notify(
      db,
      resolved.config,
      sessionWrapUp({
        project: identity.project,
        sessionId: identity.sessionId,
        entries: countEntries(db, identity.project),
        questions: attempts.n,
        passed: attempts.passed,
      }),
    );

    // A paused queue is capture that has stopped and will not restart by
    // itself. Everything else about memory degrades quietly on purpose; this
    // one is worth saying out loud, once per reason.
    const queue = queueDepth(db);
    if (queue.paused > 0) {
      const reason = db
        .prepare("SELECT error_class FROM memory_jobs WHERE status = 'paused' ORDER BY updated_at DESC LIMIT 1")
        .get() as { error_class: string | null } | undefined;
      await notify(
        db,
        resolved.config,
        queuePausedAlert({
          project: identity.project,
          errorClass: reason?.error_class ?? 'unknown',
          failed: queue.paused + queue.failed,
        }),
      );
    }
  } catch {
    /* A wrap-up nobody received is a wrap-up. A thrown one is a broken session. */
  }
}
