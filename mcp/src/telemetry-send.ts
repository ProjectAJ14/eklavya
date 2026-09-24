/**
 * The ping itself: what `eklavya telemetry show` prints and `send` posts.
 * Split from `telemetry.ts` so hooks never load these imports. Every field is
 * listed on `/docs/usage-analytics/`; change the two together.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dbPath, projectsDir } from './paths.js';
import { loadGlobalConfig } from './config.js';
import { runtimeVersion, readState as readUpdateState } from './update.js';
import { listArtifacts } from './artifacts.js';
import { MASTERY_THRESHOLD, MIN_REPS_FOR_KNOWN } from './srs.js';
import { PASSING_GRADE } from './store.js';
import {
  API_SECRET, MEASUREMENT_ID, canSend, disabledReason, installId, readState, today, writeState,
  type TelemetryState,
} from './telemetry.js';
import type { DB } from './db.js';

const ENDPOINT = 'https://www.google-analytics.com/mp/collect';
/** The observer's own `claude -p` sessions, recognised as `HELPER_SESSION` does. Not the developer's work. */
const HELPERS = `(SELECT session_id FROM evidence_events WHERE kind = 'prompt' AND body LIKE '<evidence project=%')`;
const NOT_HELPER = `(session_id IS NULL OR session_id NOT IN ${HELPERS})`;
const DAY_MS = 86_400_000;

type Value = number | boolean | string;
export interface TelemetryEvent {
  name: string;
  params: Record<string, Value>;
}

const num = (db: DB, sql: string, ...args: unknown[]): number => {
  try {
    const row = db.prepare(sql).get(...args) as Record<string, unknown> | undefined;
    const v = row ? Object.values(row)[0] : 0;
    return typeof v === 'number' ? v : Number(v) || 0;
  } catch {
    return 0;
  }
};

/**
 * SQLite's own timestamp format. Columns are compared through `datetime(col)`
 * because some are written by `datetime('now')` and some by `nowIso()`: raw,
 * `2026-09-24T03:00Z` sorts after `2026-09-24 05:00` and a row counted in the
 * last ping would be counted again.
 */
const sqlTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

function projectSettings(): Record<string, number> {
  let total = 0, quizOff = 0, memoryOff = 0, overrides = 0;
  try {
    for (const d of fs.readdirSync(projectsDir(), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      let raw: Record<string, any>;
      try {
        raw = JSON.parse(fs.readFileSync(path.join(projectsDir(), d.name, 'config.json'), 'utf8'));
      } catch {
        continue;
      }
      total++;
      if (Object.keys(raw).length > 0) overrides++;
      if (raw.quiz?.enabled === false || raw.mode === 'off') quizOff++;
      if (raw.memory?.enabled === false) memoryOff++;
    }
  } catch {
    /* no projects folder yet */
  }
  return { project_configs: total, projects_quiz_off: quizOff, projects_memory_off: memoryOff, projects_with_settings: overrides };
}

function artifactCounts(since: number): Record<string, number> {
  const out = { artifacts_total: 0, artifacts_new: 0, explainers_total: 0, explainers_new: 0 };
  try {
    for (const a of listArtifacts()) {
      const fresh = Date.parse(a.created) >= since;
      if (a.kind === 'explainer') { out.explainers_total++; if (fresh) out.explainers_new++; }
      else { out.artifacts_total++; if (fresh) out.artifacts_new++; }
    }
  } catch {
    /* no artifacts yet */
  }
  return out;
}

/**
 * Every event of one ping. `since` is the last accepted ping (or a day ago),
 * so the `_new` counts add up across days without double counting; `_total`
 * and snapshot values are the state now.
 */
export function buildEvents(db: DB, now = Date.now(), state: TelemetryState = readState()): TelemetryEvent[] {
  const sent = state.sent_at ? Date.parse(state.sent_at) : NaN;
  const since = Number.isFinite(sent) ? sent : now - DAY_MS;
  const t = sqlTime(since);
  const known = `score >= ${MASTERY_THRESHOLD} AND reps >= ${MIN_REPS_FOR_KNOWN}`;
  const c = loadGlobalConfig();
  const days = new Set(state.active_days ?? []);
  const lastWeek = Array.from({ length: 7 }, (_, i) => today(now - i * DAY_MS)).filter((d) => days.has(d)).length;
  const u = readUpdateState();
  const created = state.created_at ? Date.parse(state.created_at) : now;

  const active: TelemetryEvent = {
    name: 'daily_active',
    params: {
      version: runtimeVersion() ?? 'unknown',
      os: process.platform,
      node_major: Number(process.versions.node.split('.')[0]),
      install_age_days: Math.max(0, Math.floor((now - created) / DAY_MS)),
      active_days_7d: lastWeek,
      sessions_new: num(
        db,
        `SELECT COUNT(*) FROM (SELECT session_id FROM evidence_events WHERE datetime(received_at) >= ?
          UNION SELECT session_id FROM gates WHERE datetime(updated_at) >= ?) WHERE session_id NOT IN ${HELPERS}`,
        t, t,
      ),
      // Should be 0. Non-zero means the observer's own sessions are being
      // recorded as work again (the 1.24.0 incident; see HELPER_SESSION).
      helper_sessions_new: num(db, `SELECT COUNT(DISTINCT session_id) FROM evidence_events WHERE datetime(received_at) >= ? AND session_id IN ${HELPERS}`, t),
      update_error: u.error_class ?? (u.error ? 'other' : 'none'),
    },
  };

  const settings: TelemetryEvent = {
    name: 'settings',
    params: {
      quiz_enabled: c.quiz.enabled,
      quiz_enforced: c.quiz.enforced,
      focus: c.focus,
      cadence: c.cadence,
      difficulty: c.difficulty,
      explain_on_wrong: c.explain_on_wrong,
      quiet: c.quiet,
      auto_update: c.auto_update,
      memory_enabled: c.memory.enabled,
      memory_capture: c.memory.capture,
      retention_set: c.memory.retention_days !== null,
      retrieval_mode: c.retrieval.mode,
      cross_project: c.retrieval.cross_project,
      observer: c.providers.observer?.kind ?? 'none',
      embeddings: c.providers.embeddings?.kind ?? 'none',
      notifications: c.notifications.enabled,
      sync: c.sync.enabled,
      privacy_rules: c.privacy.exclude_paths.length + c.privacy.exclude_tools.length + c.privacy.redact_patterns.length,
      ...projectSettings(),
      projects_known: num(
        db,
        `SELECT COUNT(*) FROM (SELECT repo AS p FROM gates WHERE repo IS NOT NULL AND repo <> '*'
          UNION SELECT project FROM evidence_events WHERE project <> '*')`,
      ),
    },
  };

  const learning: TelemetryEvent = {
    name: 'learning',
    params: {
      questions_new: num(db, 'SELECT COUNT(*) FROM attempts WHERE datetime(ts) >= ?', t),
      answered_new: num(db, "SELECT COUNT(*) FROM attempts WHERE datetime(ts) >= ? AND COALESCE(outcome, 'answered') = 'answered'", t),
      passed_new: num(db, "SELECT COUNT(*) FROM attempts WHERE datetime(ts) >= ? AND COALESCE(outcome, 'answered') = 'answered' AND grade >= ?", t, PASSING_GRADE),
      dont_know_new: num(db, "SELECT COUNT(*) FROM attempts WHERE datetime(ts) >= ? AND outcome = 'dont_know'", t),
      declined_new: num(db, "SELECT COUNT(*) FROM attempts WHERE datetime(ts) >= ? AND outcome = 'declined'", t),
      mcq_new: num(db, "SELECT COUNT(*) FROM attempts WHERE datetime(ts) >= ? AND format = 'mcq'", t),
      questions_total: num(db, 'SELECT COUNT(*) FROM attempts'),
      concepts_logged_new: num(db, 'SELECT COUNT(DISTINCT concept_id) FROM session_concepts WHERE datetime(ts) >= ?', t),
      concepts_mastered: num(db, `SELECT COUNT(*) FROM mastery WHERE ${known}`),
      concepts_learning: num(db, `SELECT COUNT(*) FROM mastery WHERE reps > 0 AND NOT (${known})`),
      concepts_backlog: num(
        db,
        `SELECT COUNT(DISTINCT concept_id) FROM session_concepts
          WHERE COALESCE(origin, 'work') = 'work' AND concept_id NOT IN (SELECT concept_id FROM attempts)`,
      ),
      reviews_due: num(db, 'SELECT COUNT(*) FROM mastery WHERE reps > 0 AND next_review IS NOT NULL AND next_review <= ?', new Date(now).toISOString()),
      level_easy: num(db, "SELECT COUNT(*) FROM project_levels WHERE level = 'easy'"),
      level_medium: num(db, "SELECT COUNT(*) FROM project_levels WHERE level = 'medium'"),
      level_hard: num(db, "SELECT COUNT(*) FROM project_levels WHERE level = 'hard'"),
      promotions_new: num(db, 'SELECT COUNT(*) FROM project_levels WHERE datetime(promoted_at) >= ?', t),
      gates_enforced_new: num(db, "SELECT COUNT(*) FROM gates WHERE mode = 'enforced' AND datetime(updated_at) >= ?", t),
      gates_passed_new: num(db, "SELECT COUNT(*) FROM gates WHERE mode = 'enforced' AND passed = 1 AND datetime(updated_at) >= ?", t),
    },
  };

  const memory: TelemetryEvent = {
    name: 'memory',
    params: {
      events_new: num(db, `SELECT COUNT(*) FROM evidence_events WHERE datetime(received_at) >= ? AND session_id NOT IN ${HELPERS}`, t),
      entries_new: num(db, 'SELECT COUNT(*) FROM memory_entries WHERE deleted_at IS NULL AND datetime(created_at) >= ?', t),
      corrected_new: num(db, 'SELECT COUNT(*) FROM memory_entries WHERE superseded_by IS NOT NULL AND datetime(created_at) >= ?', t),
      deleted_new: num(db, 'SELECT COUNT(*) FROM memory_entries WHERE datetime(deleted_at) >= ?', t),
      entries_total: num(db, 'SELECT COUNT(*) FROM memory_entries WHERE deleted_at IS NULL AND superseded_by IS NULL'),
      recalls_new: num(db, `SELECT COUNT(*) FROM context_receipts WHERE datetime(created_at) >= ? AND ${NOT_HELPER}`, t),
      recalls_session_start_new: num(db, `SELECT COUNT(*) FROM context_receipts WHERE scope = 'session_start' AND datetime(created_at) >= ? AND ${NOT_HELPER}`, t),
      recalls_search_new: num(db, `SELECT COUNT(*) FROM context_receipts WHERE scope = 'search' AND datetime(created_at) >= ? AND ${NOT_HELPER}`, t),
      recall_items_new: num(db, `SELECT COALESCE(SUM(item_count), 0) FROM context_receipts WHERE datetime(created_at) >= ? AND ${NOT_HELPER}`, t),
      recall_tokens_new: num(db, `SELECT COALESCE(SUM(delivered_tokens), 0) FROM context_receipts WHERE datetime(created_at) >= ? AND ${NOT_HELPER}`, t),
      recall_tokens_saved_new: num(
        db,
        `SELECT COALESCE(SUM(MAX(base_tokens - delivered_tokens, 0)), 0) FROM context_receipts WHERE datetime(created_at) >= ? AND ${NOT_HELPER}`,
        t,
      ),
      jobs_pending: num(db, "SELECT COUNT(*) FROM memory_jobs WHERE status IN ('pending','claimed','paused')"),
      jobs_failed: num(db, "SELECT COUNT(*) FROM memory_jobs WHERE status = 'failed'"),
      collections: num(db, 'SELECT COUNT(*) FROM memory_collections'),
      db_mb: (() => {
        try {
          return Math.round(fs.statSync(dbPath()).size / 1_048_576);
        } catch {
          return 0;
        }
      })(),
    },
  };

  const artifacts: TelemetryEvent = { name: 'artifacts', params: artifactCounts(since) };

  // Finished days only: today's counts are still growing and go out tomorrow.
  const uses: TelemetryEvent[] = [];
  try {
    const rows = db
      .prepare('SELECT name, SUM(n) AS n FROM usage_counts WHERE day < ? GROUP BY name ORDER BY name')
      .all(today(now)) as { name: string; n: number }[];
    for (const r of rows) {
      const [kind, ...rest] = r.name.split(':');
      uses.push({ name: 'feature_use', params: { kind: kind!, feature: rest.join(':') || kind!, count: r.n } });
    }
  } catch {
    /* an older schema */
  }

  return [active, settings, learning, memory, artifacts, ...uses];
}

/**
 * The guarantee the docs make, enforced: a string is only ever an enum-like
 * token, never free text. Throws, so a regression fails a test or skips a ping
 * instead of sending something it should not.
 */
export function assertSafe(events: TelemetryEvent[]): void {
  for (const e of events) {
    if (!/^[a-z_]{1,40}$/.test(e.name)) throw new Error(`telemetry: bad event name ${e.name}`);
    const keys = Object.keys(e.params);
    // GA4 allows 25, and `post` adds `engagement_time_msec` to every event.
    if (keys.length > 24) throw new Error(`telemetry: ${e.name} has ${keys.length} params`);
    for (const [k, v] of Object.entries(e.params)) {
      if (!/^[a-z0-9_]{1,40}$/.test(k)) throw new Error(`telemetry: bad param ${k}`);
      if (typeof v === 'number' && Number.isFinite(v)) continue;
      if (typeof v === 'boolean') continue;
      if (typeof v === 'string' && /^[a-z0-9_.:-]{1,40}$/i.test(v)) continue;
      throw new Error(`telemetry: ${e.name}.${k} is not a count, flag or token`);
    }
  }
}

/** POSTs events in GA4's batches of 25. True when every batch was accepted. */
export async function post(events: TelemetryEvent[], id = installId()): Promise<boolean> {
  if (!MEASUREMENT_ID || !API_SECRET) return false;
  assertSafe(events);
  const url = `${ENDPOINT}?measurement_id=${MEASUREMENT_ID}&api_secret=${API_SECRET}`;
  for (let i = 0; i < events.length; i += 25) {
    const body = {
      client_id: id,
      // Without engagement time GA4 does not count the install as an active user.
      events: events.slice(i, i + 25).map((e) => ({ name: e.name, params: { ...e.params, engagement_time_msec: 1 } })),
    };
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
  }
  return true;
}

/** `eklavya telemetry send`: build, post, and on success move the window and clear sent counters. */
export async function sendNow(db: DB, now = Date.now()): Promise<boolean> {
  if (disabledReason() || !canSend()) return false;
  const events = buildEvents(db, now);
  const ok = await post(events).catch(() => false);
  if (ok) {
    writeState({ sent_at: new Date(now).toISOString() });
    try {
      db.prepare('DELETE FROM usage_counts WHERE day < ?').run(today(now));
    } catch {
      /* sent twice next time is the worst case */
    }
  }
  return ok;
}

/** A single event, sent in the open — `uninstall` uses it before the runtime goes. */
export async function sendOne(name: string, params: Record<string, Value> = {}): Promise<void> {
  if (disabledReason() || !canSend()) return;
  await post([{ name, params: { version: runtimeVersion() ?? 'unknown', os: process.platform, ...params } }]).catch(() => false);
}
