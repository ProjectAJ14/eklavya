import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';
import { nowIso } from '../time.js';
import { eventUid, relativeToProject, type EvidenceIdentity } from './identity.js';
import { DEFAULT_PRIVACY, isOwnTraffic, pathExcluded, redact, toolExcluded, type PrivacyPolicy } from './privacy.js';
import { appendEvent, type EvidenceInput } from './store.js';
import { spoolEvent, takeSpooled } from './spool.js';

/**
 * The one capture pipeline (PRD CAP-02).
 *
 * Live hook events and transcript replay both arrive here, so exclusion,
 * sanitisation, truncation and identity are decided once. Two entry points into
 * the same rules would eventually disagree, and the one that disagreed would be
 * the one that wrote a secret to disk.
 */

export type EventKind =
  | 'prompt'
  | 'tool_use'
  | 'tool_error'
  | 'file_edit'
  | 'file_read'
  | 'assistant'
  | 'lifecycle'
  | 'note';

export interface HostEvent {
  kind: EventKind;
  tool?: string | null;
  title?: string | null;
  body: string;
  files?: string[];
  occurredAt?: string;
  source?: 'hook' | 'replay' | 'manual' | 'import';
}

export type CaptureOutcome = 'stored' | 'duplicate' | 'excluded' | 'spooled' | 'dropped';

/** Per-event body cap. Evidence is a pointer to work, not a copy of the repo. */
const MAX_BODY = 4000;
/**
 * How much of a body redaction reads before the cap is applied. Four times the
 * cap: redaction only ever shortens text, so everything that survives the cap
 * was read whole unless a secret sits across this boundary *and* the markers
 * before it saved more than 12,000 characters — which only a private key does,
 * and an unclosed one already runs to the end of the window.
 */
const REDACT_WINDOW = MAX_BODY * 4;

/**
 * `minimal` keeps the shape of a session — what was asked, what was decided,
 * where it started and stopped — and drops the per-file traffic that makes up
 * most of the volume.
 */
const MINIMAL_KINDS: EventKind[] = ['prompt', 'assistant', 'lifecycle', 'note'];

export function policyFrom(config: EklavyaConfig): PrivacyPolicy {
  return {
    excludePaths: [...DEFAULT_PRIVACY.excludePaths, ...config.privacy.exclude_paths],
    excludeTools: [...DEFAULT_PRIVACY.excludeTools, ...config.privacy.exclude_tools],
    redactPatterns: config.privacy.redact_patterns,
  };
}

/** Everything but the write: pure, so the exclusion rules are testable alone. */
export function prepare(
  config: EklavyaConfig,
  identity: EvidenceIdentity,
  event: HostEvent,
): EvidenceInput | null {
  if (!config.memory.enabled || config.memory.capture === 'off') return null;
  if (config.memory.capture === 'minimal' && !MINIMAL_KINDS.includes(event.kind)) return null;

  const policy = policyFrom(config);
  if (toolExcluded(event.tool, policy)) return null;
  if (isOwnTraffic(event.tool, event.body)) return null;

  const files = (event.files ?? []).filter((f) => !pathExcluded(f, policy));
  // A file event whose only file was excluded is the excluded file. Keeping the
  // event for its body would re-admit through the back door what the path rule
  // just shut out.
  if ((event.kind === 'file_edit' || event.kind === 'file_read') && (event.files?.length ?? 0) > 0 && files.length === 0) {
    return null;
  }

  // Redact, then cut — never the other way round. Cut first, the cap can land
  // inside a secret and leave a head too short for any pattern to recognise
  // (`password=hunt`) or a private key without its END line. The window is
  // wider than the cap so a secret straddling it is seen whole, and bounded so
  // a 200KB tool dump is not scanned end to end on every tool call.
  const redacted = redact(event.body.slice(0, REDACT_WINDOW), policy);
  const cleaned = { ...redacted, text: redacted.text.slice(0, MAX_BODY) };
  const occurredAt = event.occurredAt ?? nowIso();

  return {
    eventUid: eventUid({
      host: identity.host,
      sessionId: identity.sessionId,
      agentId: identity.agentId,
      kind: event.kind,
      tool: event.tool,
      occurredAt,
      body: cleaned.text,
    }),
    project: identity.project,
    checkout: identity.checkout,
    sessionId: identity.sessionId,
    agentId: identity.agentId,
    host: identity.host,
    source: event.source ?? 'hook',
    kind: event.kind,
    tool: event.tool ?? null,
    title: event.title ? redact(event.title, policy).text : null,
    body: cleaned.text,
    files: files.map((f) => relativeToProject(f, identity.project)),
    occurredAt,
    redacted: cleaned.redacted,
  };
}

export function capture(
  db: DB,
  config: EklavyaConfig,
  identity: EvidenceIdentity,
  event: HostEvent,
): CaptureOutcome {
  const input = prepare(config, identity, event);
  if (!input) return 'excluded';
  const { inserted } = appendEvent(db, input);
  return inserted ? 'stored' : 'duplicate';
}

/**
 * Capture when the database may not be reachable. The sanitised record — never
 * the raw one — is what reaches the spool, so a degraded path cannot write a
 * secret that the healthy path would have removed.
 */
export function captureOrSpool(
  db: DB | null,
  config: EklavyaConfig,
  identity: EvidenceIdentity,
  event: HostEvent,
): CaptureOutcome {
  const input = prepare(config, identity, event);
  if (!input) return 'excluded';
  if (db) {
    try {
      const { inserted } = appendEvent(db, input);
      return inserted ? 'stored' : 'duplicate';
    } catch {
      // Fall through to the spool: a locked or unwritable database is exactly
      // what it exists for.
    }
  }
  return spoolEvent(input);
}

/** Replays whatever the spool holds. Idempotent through `event_uid`. */
export function drainSpool(db: DB): { replayed: number; skipped: number } {
  const { records, commit } = takeSpooled();
  let replayed = 0;
  let skipped = 0;
  for (const record of records) {
    const input = record as EvidenceInput;
    // A spool line is data this process wrote earlier, but a truncated write or
    // a hand-edited file is still possible; anything without an identity cannot
    // be replayed idempotently and is discarded rather than guessed at.
    if (!input || typeof input !== 'object' || !input.eventUid || !input.project) {
      skipped++;
      continue;
    }
    try {
      const { inserted } = appendEvent(db, input);
      if (inserted) replayed++;
      else skipped++;
    } catch {
      // Stop here and leave the claimed file where it is: the next drain replays
      // all of it, and what already landed is a no-op through `event_uid`.
      // Pressing on would pay the busy timeout once per remaining record — a
      // database that refused one write is refusing them all, and a hook that
      // waits that long is killed with the rest of its work undone.
      return { replayed, skipped: skipped + (records.length - replayed - skipped) };
    }
  }
  // Only now: every record is in the database, so the claimed file holds
  // nothing that exists nowhere else.
  commit();
  return { replayed, skipped };
}
