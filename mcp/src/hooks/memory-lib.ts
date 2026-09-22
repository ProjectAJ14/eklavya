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
import { processPending } from '../memory/worker.js';
import { recall } from '../memory/recall.js';
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
