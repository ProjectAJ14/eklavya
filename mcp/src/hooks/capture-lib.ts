/**
 * The capture path's half of `memory-lib.ts`: identity, one insert, and the
 * size-triggered batch close — nothing that summarises, recalls or notifies.
 *
 * Its own module because `capture-tool` runs after every tool call and
 * `prompt-submit-nudge` on every prompt, and an ES import is paid whether or
 * not the function behind it is called. Importing these from `memory-lib.ts`
 * loaded the worker, both summarizers, the provider (and zod), recall and
 * notify on every tool call — roughly three times the hook's own start-up, for
 * code the capture path never runs. `test/hook-isolation.test.ts` pins the
 * boundary; `memory-lib.ts` re-exports these, so the seam hooks are unchanged.
 *
 * The same rule as `memory-lib.ts`: every function swallows its own failures.
 */
import type { ResolvedConfig } from '../config.js';
import { projectKey } from '../store.js';
import { identityFor, type EvidenceIdentity } from '../memory/identity.js';
import { captureOrSpool, type HostEvent } from '../memory/capture.js';
import { batchSession, pendingEventCount } from '../memory/store.js';
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

/**
 * Records one event. True once it is stored or safely spooled; false on any
 * other outcome, and never throws.
 *
 * Through `captureOrSpool`, not `capture`: a database held past the busy timeout
 * by another session, a migration or a checkpoint used to cost the event
 * outright, because the spool that exists for exactly that had no caller. The
 * spool is replayed at the next seam.
 */
export function record(
  db: DB,
  resolved: ResolvedConfig,
  identity: EvidenceIdentity,
  event: HostEvent,
): boolean {
  try {
    const outcome = captureOrSpool(db, resolved.config, identity, event);
    return outcome === 'stored' || outcome === 'spooled';
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
    if (pendingEventCount(db, identity.project, identity.sessionId) < max) return;
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
