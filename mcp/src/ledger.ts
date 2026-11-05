import fs from 'node:fs';
import os from 'node:os';
import type { DB } from './db.js';
import type { EklavyaConfig } from './config.js';
import { priceByModel, weightsFor, effectiveTokens } from './economy/pricing.js';
import { findTranscript, isEklavyaTool, projectsDir, readTranscript, totalTokens, type TranscriptSummary, type Usage } from './economy/transcript.js';
import { setUsageSink, type ProviderUsage } from './memory/provider.js';
import { openSession } from './ledger-pending.js';

/**
 * The cost ledger (issue #261): what each session cost, and what Eklavya
 * itself spent.
 *
 * A session row is opened at session start with its transcript's path and
 * folded later, in a detached process: at `SessionEnd`, or by the next
 * session start once the transcript has been quiet for `QUIET_MS`, because
 * `SessionEnd` is not always delivered. The fold reads usage numbers and tool
 * names from the transcript (`economy/transcript.ts`) and keeps nothing else.
 */

export { QUIET_MS, memoryUsePending, openSession, quietPending } from './ledger-pending.js';

const nowIso = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v);

/** Each Eklavya MCP tool the session called, by its short name (`memory_search`), with its count; null for none. */
export function eklavyaTools(tools: Record<string, number>): string | null {
  const out: Record<string, number> = {};
  for (const [name, n] of Object.entries(tools)) {
    if (isEklavyaTool(name)) {
      const short = name.slice(name.lastIndexOf('__') + 2);
      out[short] = (out[short] ?? 0) + n;
    }
  }
  return Object.keys(out).length ? json(out) : null;
}

/** What the settings were when a session was folded, for the memory on/off comparison. */
export const settingsSnapshot = (config: EklavyaConfig) =>
  json({ economy: config.economy, memory: { enabled: config.memory.enabled, pinned_facts: config.memory.pinned_facts }, retrieval: config.retrieval });

export interface FoldResult {
  sessionId: string;
  found: boolean;
  effective: number;
  unpriced: string[];
  project: string | null;
  /** What the transcript held, for the evidence the other cost controls keep; null without one. */
  summary: TranscriptSummary | null;
  /** The transcript read, or null. */
  file: string | null;
}

/**
 * Folds one session: prices its transcript and writes its row, and one
 * overhead row per Eklavya subagent type it ran (labelled, never added to the
 * session twice). Repeatable: a second fold replaces the first.
 */
export function foldSession(
  db: DB,
  config: EklavyaConfig,
  sessionId: string,
  opts: { transcript?: string | null; project?: string | null; env?: NodeJS.ProcessEnv; home?: string } = {},
): FoldResult {
  const known = db.prepare('SELECT project, transcript_path FROM econ_sessions WHERE session_id = ?').get(sessionId) as
    | { project: string | null; transcript_path: string | null }
    | undefined;
  const projects = projectsDir(opts.env ?? process.env, opts.home ?? os.homedir());
  const file =
    [opts.transcript, known?.transcript_path].find((f): f is string => Boolean(f) && fs.existsSync(f!)) ??
    findTranscript(projects, sessionId);
  const t = file ? readTranscript(file) : null;
  const priced = priceByModel(t?.byModel ?? {});
  const quiz = priceByModel(t?.eklavya.byModel ?? {});
  const subs = Object.entries(t?.subagents ?? {}).filter(([type]) => type.startsWith('eklavya:'));
  const subEffective = subs.reduce((sum, [, s]) => sum + priceByModel(s.byModel).effective, 0);
  const u: Usage = t?.usage ?? { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };
  const project = opts.project ?? known?.project ?? null;

  db.transaction(() => {
    openSession(db, { sessionId, project, transcriptPath: file ?? null });
    db.prepare(
      `UPDATE econ_sessions SET
         project = COALESCE(?, project), transcript_path = COALESCE(?, transcript_path),
         model = ?, claude_version = ?, started_at = ?, ended_at = ?, prompts = ?, requests = ?,
         tool_calls = ?, tool_errors = ?, input = ?, cache_read = ?, cache_write_5m = ?, cache_write_1h = ?,
         output = ?, effective = ?, quiz_effective = ?, eklavya_effective = ?, eklavya_tools = ?, unpriced = ?, settings = ?, folded_at = ?
       WHERE session_id = ?`,
    ).run(
      project,
      file ?? null,
      t?.model ?? null,
      t?.version ?? null,
      t?.startedAt ?? null,
      t?.endedAt ?? null,
      t?.prompts ?? 0,
      t?.requests ?? 0,
      Object.values(t?.tools ?? {}).reduce((a, b) => a + b, 0),
      t?.toolErrors ?? 0,
      u.input,
      u.cacheRead,
      u.cacheWrite5m,
      u.cacheWrite1h,
      u.output,
      priced.effective,
      quiz.effective,
      quiz.effective + subEffective,
      eklavyaTools(t?.tools ?? {}),
      priced.unpriced.length ? json(priced.unpriced) : null,
      settingsSnapshot(config),
      nowIso(),
      sessionId,
    );
    db.prepare(`DELETE FROM econ_overhead WHERE session_id = ? AND source LIKE 'subagent:%'`).run(sessionId);
    for (const [type, s] of subs) {
      for (const [model, mu] of Object.entries(s.byModel)) {
        recordOverhead(db, {
          source: `subagent:${type}`,
          model,
          usage: mu,
          costUsd: null,
          sessionId,
          project,
          occurredAt: t!.endedAt ?? nowIso(),
          inSession: true,
        });
      }
    }
  })();
  return { sessionId, found: Boolean(t && totalTokens(u) > 0), effective: priced.effective, unpriced: priced.unpriced, project, summary: t, file: file ?? null };
}

export interface OverheadRow {
  source: string;
  model: string;
  usage: Usage;
  costUsd: number | null;
  sessionId?: string | null;
  project?: string | null;
  occurredAt?: string;
  inSession?: boolean;
}

/** One row of Eklavya's own spend. A model with no price row is kept, marked unpriced. */
export function recordOverhead(db: DB, row: OverheadRow): void {
  const w = weightsFor(row.model);
  db.prepare(
    `INSERT INTO econ_overhead (occurred_at, project, session_id, source, model, input, cache_read, cache_write_5m,
       cache_write_1h, output, effective, unpriced, cost_usd, in_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.occurredAt ?? nowIso(),
    row.project ?? null,
    row.sessionId ?? null,
    row.source,
    row.model,
    row.usage.input,
    row.usage.cacheRead,
    row.usage.cacheWrite5m,
    row.usage.cacheWrite1h,
    row.usage.output,
    w ? Math.round(effectiveTokens(row.usage, w)) : 0,
    w ? 0 : 1,
    row.costUsd,
    row.inSession ? 1 : 0,
  );
}

/**
 * Records every `claude -p` call this process makes from here on. Called by
 * the processes that make them (the memory worker, feedback review, the
 * judge) when `economy.ledger` is on; `runClaude` reports, this writes.
 */
export function meterProviderCalls(db: DB, config: EklavyaConfig, context: { project?: string | null; sessionId?: string | null } = {}): void {
  if (!config.economy.ledger) return setUsageSink(null);
  setUsageSink((u: ProviderUsage) =>
    recordOverhead(db, { ...u, ...context }),
  );
}

export interface SessionCost {
  session_id: string;
  project: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  prompts: number;
  tool_calls: number;
  input: number;
  cache_read: number;
  cache_write_5m: number;
  cache_write_1h: number;
  output: number;
  effective: number;
  quiz_effective: number;
  eklavya_effective: number;
  unpriced: string | null;
  /** `claude -p` overhead charged to this session (observer and judge calls made for it). */
  overhead_effective: number;
}

/** The last `limit` folded sessions, newest first; `project` null for every project. */
export function sessionCosts(db: DB, project: string | null, limit = 10): SessionCost[] {
  return db
    .prepare(
      `SELECT s.session_id, s.project, s.model, s.started_at, s.ended_at, s.prompts, s.tool_calls, s.input, s.cache_read,
              s.cache_write_5m, s.cache_write_1h, s.output, s.effective, s.quiz_effective, s.eklavya_effective, s.unpriced,
              COALESCE((SELECT SUM(o.effective) FROM econ_overhead o WHERE o.session_id = s.session_id AND o.in_session = 0), 0)
                AS overhead_effective
       FROM econ_sessions s
       WHERE s.folded_at IS NOT NULL AND (? IS NULL OR s.project = ?)
       ORDER BY COALESCE(s.started_at, s.created_at) DESC LIMIT ?`,
    )
    .all(project, project, limit) as SessionCost[];
}

export interface WeekCost {
  week: string;
  sessions: number;
  effective: number;
  eklavya_effective: number;
  overhead_effective: number;
}

/** ISO week (`2026-W45`) of a timestamp. */
export function isoWeek(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const year = d.getUTCFullYear();
  const first = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Folded sessions and Eklavya's own calls, summed per ISO week, newest first. */
export function weeklyCosts(db: DB, project: string | null): WeekCost[] {
  const weeks = new Map<string, WeekCost>();
  const at = (w: string) => weeks.get(w) ?? weeks.set(w, { week: w, sessions: 0, effective: 0, eklavya_effective: 0, overhead_effective: 0 }).get(w)!;
  for (const s of sessionCosts(db, project, 100_000)) {
    if (!s.started_at) continue;
    const w = at(isoWeek(s.started_at));
    w.sessions++;
    w.effective += s.effective;
    w.eklavya_effective += s.eklavya_effective;
  }
  const overhead = db
    .prepare(`SELECT occurred_at, effective FROM econ_overhead WHERE in_session = 0 AND (? IS NULL OR project = ?)`)
    .all(project, project) as { occurred_at: string; effective: number }[];
  for (const o of overhead) at(isoWeek(o.occurred_at)).overhead_effective += o.effective;
  return [...weeks.values()].sort((a, b) => b.week.localeCompare(a.week));
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Every folded session as CSV, one row each, for a team lead to collect without a central service. */
export function costCsv(db: DB, project: string | null): string {
  const cols: (keyof SessionCost)[] = [
    'session_id', 'project', 'model', 'started_at', 'ended_at', 'prompts', 'tool_calls', 'input', 'cache_read',
    'cache_write_5m', 'cache_write_1h', 'output', 'effective', 'quiz_effective', 'eklavya_effective', 'overhead_effective', 'unpriced',
  ];
  const rows = sessionCosts(db, project, 100_000);
  return [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
}

/** Eklavya's own spend outside sessions, per source, for `eklavya cost`. */
export function overheadBySource(db: DB, project: string | null, sinceIso: string): { source: string; calls: number; effective: number; unpriced: number; cost_usd: number | null }[] {
  return db
    .prepare(
      `SELECT source, COUNT(*) AS calls, SUM(effective) AS effective, SUM(unpriced) AS unpriced, SUM(cost_usd) AS cost_usd
       FROM econ_overhead WHERE occurred_at >= ? AND (? IS NULL OR project = ? OR project IS NULL)
       GROUP BY source ORDER BY effective DESC`,
    )
    .all(sinceIso, project, project) as { source: string; calls: number; effective: number; unpriced: number; cost_usd: number | null }[];
}
