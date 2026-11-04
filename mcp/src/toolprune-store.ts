import type { DB } from './db.js';
import type { EklavyaConfig } from './config.js';
import { applyDeny, isProtected, measure, propose, restoreDeny, type ToolEvidence, type WriteRecord } from './economy/toolprune.js';
import type { TranscriptSummary } from './economy/transcript.js';

/**
 * Tool pruning's database side (issue #263): the evidence the fold keeps, the
 * proposal, and the record of what `apply` wrote so `restore` can undo it.
 * Writes to a checkout's settings come from the CLI or the fold, never from a
 * hook.
 */

const nowIso = () => new Date().toISOString();

/**
 * Counts one finished session toward its project's evidence: every tool it
 * loaded (listed as deferred, or used) either resets (used) or ages by the
 * session's prompts. Once per session.
 */
export function recordToolUse(db: DB, project: string, sessionId: string, t: Pick<TranscriptSummary, 'tools' | 'deferredTools' | 'prompts'>): void {
  const done = db.prepare('SELECT evidence FROM econ_sessions WHERE session_id = ?').get(sessionId) as { evidence: number } | undefined;
  if (done?.evidence) return;
  const at = nowIso();
  const loaded = new Set([...t.deferredTools, ...Object.keys(t.tools)]);
  const upsert = db.prepare(
    `INSERT INTO econ_tool_use (project, tool, deferred, first_seen_at, last_used_at, prompts_since, sessions_since)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project, tool) DO UPDATE SET
       deferred = excluded.deferred,
       last_used_at = COALESCE(excluded.last_used_at, econ_tool_use.last_used_at),
       prompts_since = CASE WHEN excluded.last_used_at IS NOT NULL THEN 0 ELSE econ_tool_use.prompts_since + excluded.prompts_since END,
       sessions_since = CASE WHEN excluded.last_used_at IS NOT NULL THEN 0 ELSE econ_tool_use.sessions_since + 1 END`,
  );
  db.transaction(() => {
    for (const tool of loaded) {
      const used = (t.tools[tool] ?? 0) > 0;
      upsert.run(project, tool, t.deferredTools.includes(tool) ? 1 : 0, at, used ? at : null, used ? 0 : t.prompts, used ? 0 : 1);
    }
    db.prepare('UPDATE econ_sessions SET evidence = 1 WHERE session_id = ?').run(sessionId);
  })();
}

export function evidence(db: DB, project: string): (ToolEvidence & { deferred: number })[] {
  return db
    .prepare('SELECT tool, prompts_since, sessions_since, deferred FROM econ_tool_use WHERE project = ? ORDER BY tool')
    .all(project) as (ToolEvidence & { deferred: number })[];
}

export function kept(db: DB, project: string): string[] {
  return (db.prepare('SELECT tool FROM econ_toolprune_kept WHERE project = ?').all(project) as { tool: string }[]).map((r) => r.tool);
}

export function writeRecord(db: DB, project: string): WriteRecord | null {
  const row = db.prepare('SELECT record FROM econ_settings_writes WHERE project = ?').get(project) as { record: string } | undefined;
  return row ? (JSON.parse(row.record) as WriteRecord) : null;
}

/** Tools to propose for this project: the rule, less tools kept by hand and ones already written. */
export function proposal(db: DB, config: EklavyaConfig, project: string): ToolEvidence[] {
  const e = config.economy;
  const skip = new Set([...kept(db, project), ...(writeRecord(db, project)?.added ?? [])]);
  return propose(evidence(db, project), {
    evidence: e.toolprune_evidence,
    min_sessions: e.toolprune_min_sessions,
    sessions: e.toolprune_sessions,
    protect: e.toolprune_protect,
  }).filter((r) => !skip.has(r.tool));
}

export type PruneResult = { ok: true; tools: string[] } | { ok: false; reason: string };

/** Writes the proposal (or `only`) to the checkout's deny list and records it. */
export function applyProposal(db: DB, config: EklavyaConfig, project: string, repoRoot: string, only?: string[]): PruneResult {
  if (config.economy.toolprune === 'off') return { ok: false, reason: 'economy.toolprune is off' };
  const tools = proposal(db, config, project)
    .map((r) => r.tool)
    .filter((t) => !only || only.includes(t));
  if (!tools.length) return { ok: true, tools: [] };
  const result = applyDeny(repoRoot, tools, writeRecord(db, project));
  if (!result.ok) return result;
  db.prepare(
    `INSERT INTO econ_settings_writes (project, record, applied_at) VALUES (?, ?, ?)
     ON CONFLICT(project) DO UPDATE SET record = excluded.record, applied_at = excluded.applied_at`,
  ).run(project, JSON.stringify(result.record), nowIso());
  return { ok: true, tools };
}

/**
 * Removes Eklavya's entries (all, or `only`) and keeps those tools from being
 * proposed again. Without a record there is nothing of Eklavya's to remove.
 */
export function restoreTools(db: DB, project: string, repoRoot: string, only?: string[], keep = true): PruneResult {
  const record = writeRecord(db, project);
  if (!record) return { ok: true, tools: [] };
  const result = restoreDeny(repoRoot, record, only);
  if (!result.ok) return result;
  const remaining = only ? record.added.filter((t) => !only.includes(t)) : [];
  db.transaction(() => {
    if (remaining.length) {
      db.prepare('UPDATE econ_settings_writes SET record = ? WHERE project = ?').run(JSON.stringify({ ...record, added: remaining }), project);
    } else {
      db.prepare('DELETE FROM econ_settings_writes WHERE project = ?').run(project);
    }
    if (keep) {
      const add = db.prepare('INSERT OR IGNORE INTO econ_toolprune_kept (project, tool, kept_at) VALUES (?, ?, ?)');
      for (const t of result.removed) add.run(project, t, nowIso());
    }
  })();
  return { ok: true, tools: result.removed };
}

/** A tool Eklavya denied that has since become protected comes back, without being marked kept. */
export function restoreNewlyProtected(db: DB, config: EklavyaConfig, project: string, repoRoot: string): string[] {
  const record = writeRecord(db, project);
  const now = record?.added.filter((t) => isProtected(t, config.economy.toolprune_protect)) ?? [];
  if (!now.length) return [];
  const r = restoreTools(db, project, repoRoot, now, false);
  return r.ok ? r.tools : [];
}

/** Listing lines a deny list would save. Deferred tools only: definition sizes of the others are not known here. */
export function measureProposal(db: DB, config: EklavyaConfig, project: string): { tools: number; deferred: number; listingTokens: number } {
  const rows = evidence(db, project);
  const proposed = proposal(db, config, project).map((r) => r.tool);
  const deferred = rows.filter((r) => r.deferred).map((r) => r.tool);
  const m = measure({}, deferred, proposed);
  return { tools: proposed.length, deferred: proposed.filter((t) => deferred.includes(t)).length, listingTokens: m.saved };
}
