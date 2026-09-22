import crypto from 'node:crypto';
import path from 'node:path';
import { findRepoConfig, mainRepoRoot } from '../config.js';

/**
 * Identity for captured evidence (PRD CAP-01).
 *
 * Three names that look alike and are not. `project` is the learning half's
 * key — worktrees folded into the checkout they branched from — so a memory and
 * a mastery row agree about which codebase they belong to. `checkout` is the
 * unfolded root, kept because "which worktree was this" is a real question when
 * two branches are open. `sessionId` is the host's, never invented here.
 *
 * Two repositories with the same folder name must not collide, which is why
 * every key is an absolute realpath rather than a basename.
 */
export interface EvidenceIdentity {
  project: string;
  checkout: string | null;
  sessionId: string;
  agentId: string | null;
  host: string;
}

export const GLOBAL_PROJECT = '(global)';

export function identityFor(opts: {
  cwd?: string | null;
  sessionId: string;
  agentId?: string | null;
  host?: string | null;
}): EvidenceIdentity {
  const { repoRoot } = findRepoConfig(opts.cwd ?? process.cwd());
  return {
    project: repoRoot ? mainRepoRoot(repoRoot) : GLOBAL_PROJECT,
    checkout: repoRoot,
    sessionId: opts.sessionId,
    agentId: opts.agentId?.trim() || null,
    host: opts.host?.trim() || 'claude-code',
  };
}

/**
 * The idempotency key for one host event.
 *
 * Hook capture and transcript replay see the same turn from two directions and
 * must converge on one row (CAP-02). Hashing the identity plus the event's own
 * content and time does that without either side knowing about the other. It is
 * deliberately not a short title hash over a time window: two legitimate
 * identical edits a minute apart are two events, and collapsing them loses work.
 */
export function eventUid(parts: {
  host: string;
  sessionId: string;
  kind: string;
  tool?: string | null;
  occurredAt: string;
  body: string;
  agentId?: string | null;
}): string {
  const h = crypto.createHash('sha256');
  h.update(
    [
      parts.host,
      parts.sessionId,
      parts.agentId ?? '',
      parts.kind,
      parts.tool ?? '',
      parts.occurredAt,
      parts.body,
    ].join('\u0000'),
  );
  return h.digest('hex').slice(0, 32);
}

/** Stable id for a generated or imported memory entry. */
export function entryUid(parts: { project: string; title: string; occurredAt: string; salt?: string }): string {
  const h = crypto.createHash('sha256');
  h.update([parts.project, parts.title, parts.occurredAt, parts.salt ?? ''].join('\u0000'));
  return h.digest('hex').slice(0, 32);
}

export function receiptUid(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
}

/** Repo-relative when the file is inside the checkout, absolute otherwise. */
export function relativeToProject(file: string, project: string): string {
  if (!path.isAbsolute(file) || project === GLOBAL_PROJECT) return file;
  const rel = path.relative(project, file);
  return rel && !rel.startsWith('..') ? rel : file;
}
