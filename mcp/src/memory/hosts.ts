/**
 * Host capability descriptors (PRD CAP-01, EXT-01; ADR-06).
 *
 * The rule this file enforces is "record capabilities rather than fabricate
 * missing events". A host that cannot tell us a tool failed must not have a
 * memory that quietly implies every tool succeeded, and a host nobody has run
 * a fixture through must not be advertised as supported.
 *
 * `status` is the honest axis. `proven` means there is a transcript fixture and
 * a passing test in this repository. `unverified` means the adapter is written
 * from documentation and nobody has run it. Nothing is listed here that has no
 * adapter at all — the parity ledger tracks those.
 */

export type HostStatus = 'proven' | 'unverified';

export interface HostCapabilities {
  id: string;
  label: string;
  status: HostStatus;
  /** Hooks fire for these events. */
  hooks: boolean;
  /** A transcript on disk can be replayed for the events hooks did not catch. */
  transcripts: boolean;
  /** The host reports whether a tool call failed. Without it, `tool_error` is never produced. */
  toolOutcomes: boolean;
  /** Delegated work carries an agent identity, so a subagent's work is attributable. */
  agentIdentity: boolean;
  /** The host has a documented channel for putting text in front of the developer. */
  humanDisplay: boolean;
  /** The host has a documented channel for adding context the model reads. */
  modelContext: boolean;
  notes?: string;
}

export const HOSTS: Record<string, HostCapabilities> = {
  'claude-code': {
    id: 'claude-code',
    label: 'Claude Code',
    status: 'proven',
    hooks: true,
    transcripts: true,
    toolOutcomes: true,
    agentIdentity: true,
    humanDisplay: true,
    modelContext: true,
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    status: 'unverified',
    hooks: false,
    transcripts: false,
    toolOutcomes: false,
    agentIdentity: false,
    humanDisplay: false,
    // The MCP server works, so explicit tool calls are captured. Nothing else
    // is: with no hooks there is no seam to capture a prompt or an edit at.
    modelContext: false,
    notes: 'MCP tools only. No hooks, so nothing is captured that the model does not explicitly log.',
  },
  cowork: {
    id: 'cowork',
    label: 'Claude Cowork',
    status: 'unverified',
    hooks: true,
    transcripts: false,
    toolOutcomes: true,
    agentIdentity: true,
    humanDisplay: true,
    modelContext: true,
    notes: 'No git commits, so the commit gate never fires there; `surface.ts` already says so at session start.',
  },
};

export function capabilitiesOf(host: string | null | undefined): HostCapabilities {
  return (
    HOSTS[host ?? 'claude-code'] ?? {
      id: host ?? 'unknown',
      label: host ?? 'unknown host',
      status: 'unverified',
      hooks: false,
      transcripts: false,
      toolOutcomes: false,
      agentIdentity: false,
      humanDisplay: false,
      modelContext: false,
      notes: 'Unrecognised host: assume nothing is delivered that was not explicitly logged.',
    }
  );
}

/** The hosts an install may honestly claim to support today. */
export function provenHosts(): HostCapabilities[] {
  return Object.values(HOSTS).filter((h) => h.status === 'proven');
}
