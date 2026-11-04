import crypto from 'node:crypto';
import type { DB } from '../db.js';
import type { EklavyaConfig } from '../config.js';
import { LINT, formRepairEvidence, observe, render, type Call, type Family, type Observation } from '../economy/envfacts.js';
import { estimateTokens } from './tokens.js';
import { defangFence } from './privacy.js';

/**
 * Pinned facts (issue #264): the lifecycle every fact shares, and the capped
 * block at the top of the session-start recall.
 *
 * A fact is `forming` until `CONFIRMATIONS` sessions confirm it, then
 * `active`. Each session it decays by `DECAY` and a contradiction weighs
 * `CONTRADICTION` times a confirmation; below zero it retires, and one clean
 * contradiction retires a high-stakes fact at once. An active fact is shown
 * only while it keeps applying: once `MIN_EXERCISED` sessions have exercised
 * it, in at least `MIN_APPLIED_SHARE` of them. Facts are evidence for the
 * model, never a reason to change mastery: nothing here touches the learning
 * tables.
 */

export const CONFIRMATIONS = 3;
export const DECAY = 0.8;
export const CONTRADICTION = 5;
export const MIN_EXERCISED = 4;
export const MIN_APPLIED_SHARE = 0.4;
/** Of `memory.pinned_facts`, at most this many are environment facts. */
export const ENV_FACTS_MAX = 4;
/** About the token budget of the whole pinned part, header included. */
export const PINNED_TOKENS = 300;
/** A missing-module FormRepair contradiction counts only after this many exercised sessions in a row said so. */
export const CONTRADICT_STREAK = 2;

const nowIso = () => new Date().toISOString();

export interface FactRow {
  id: number;
  project: string;
  fact_key: string;
  family: string;
  kind: string;
  text: string;
  params: string | null;
  source: string;
  state: 'forming' | 'active' | 'retired';
  score: number;
  confirmations: number;
  exercised: number;
  applied: number;
  contradictions: number;
  high: number;
  sessions: string;
  retired_reason: string | null;
}

export interface SessionEvidence {
  key: string;
  family: Family | 'observer';
  kind: 'env' | 'decision' | 'convention';
  text: string;
  params: Record<string, string>;
  source: 'free' | 'observer';
  verdict: 'confirm' | 'contradict' | null;
  exercised: boolean;
  applied: boolean;
  high: boolean;
}

/** The evidence a family observation is, rendered to its fixed template. */
export function fromObservation(o: Observation): SessionEvidence {
  return { ...o, kind: 'env', text: render(o.family, o.params), source: 'free' };
}

/** An observer-proposed fact: keyed by its normalised text, so the same claim in three sessions confirms itself. */
export function fromProposal(kind: 'env' | 'decision' | 'convention', text: string): SessionEvidence | null {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
  if (clean.length < 12 || LINT.test(clean)) return null;
  const key = `observer:${kind}:${crypto.createHash('sha256').update(clean.toLowerCase()).digest('hex').slice(0, 16)}`;
  return { key, family: 'observer', kind, text: clean, params: {}, source: 'observer', verdict: 'confirm', exercised: false, applied: false, high: false };
}

/**
 * Everything one session's calls say about the project's facts: what the
 * families observed, and how the session bore on each live FormRepair fact
 * (the working form used, or the failing one working after all).
 */
export function sessionEvidence(db: DB, project: string, calls: Call[]): SessionEvidence[] {
  const found = new Map(observe(calls).map((o) => [o.key, fromObservation(o)]));
  const live = db
    .prepare(`SELECT fact_key, params FROM pinned_facts WHERE project = ? AND family = 'form_repair' AND state != 'retired'`)
    .all(project) as { fact_key: string; params: string }[];
  for (const f of live) {
    const p = JSON.parse(f.params) as { a: string; b: string; intent: string; error: string };
    const bearing = formRepairEvidence(calls, p);
    const seen = found.get(f.fact_key);
    // A family observation of this fact implies the session ran its intent.
    if (!bearing.exercised) continue;
    found.set(f.fact_key, {
      ...(seen ?? fromObservation({ family: 'form_repair', key: f.fact_key, params: p, verdict: null, exercised: true, applied: false, high: false })),
      verdict: seen?.verdict ?? bearing.verdict,
      exercised: true,
      applied: bearing.applied,
    });
  }
  return [...found.values()];
}

/**
 * Folds one session's evidence into the project's facts. Every live fact
 * decays once per session; a session already counted is skipped, so a fold
 * that runs twice changes nothing.
 */
export function foldSessionFacts(
  db: DB,
  project: string,
  sessionId: string,
  evidence: SessionEvidence[],
  opts: { only?: boolean } = {},
): void {
  const at = nowIso();
  const byKey = new Map(evidence.map((e) => [e.key, e]));
  db.transaction(() => {
    // `only`: touch just the facts this evidence is about (an observer
    // proposal mid-session), so the session's own fold still decays the rest.
    const live = (db.prepare(`SELECT * FROM pinned_facts WHERE project = ? AND state != 'retired'`).all(project) as FactRow[]).filter(
      (f) => !opts.only || byKey.has(f.fact_key),
    );
    for (const f of live) {
      const seen = JSON.parse(f.sessions) as string[];
      if (seen.includes(sessionId)) {
        byKey.delete(f.fact_key);
        continue;
      }
      const e = byKey.get(f.fact_key);
      byKey.delete(f.fact_key);
      const params = JSON.parse(f.params!) as Record<string, string | number>;
      let verdict = e?.verdict ?? null;
      // A run that did not need the missing module can pass by luck, so a
      // missing-module fact needs two contradicting sessions in a row. A command
      // that was not found and now runs is a clean contradiction.
      if (f.family === 'form_repair' && params.error === 'module_missing' && e?.exercised) {
        const streak = verdict === 'contradict' ? Number(params.contra_streak ?? 0) + 1 : 0;
        params.contra_streak = streak;
        if (verdict === 'contradict' && streak < CONTRADICT_STREAK) verdict = null;
      }
      const score = f.score * DECAY + (verdict === 'confirm' ? 1 : 0) - (verdict === 'contradict' ? CONTRADICTION : 0);
      const confirmations = f.confirmations + (verdict === 'confirm' ? 1 : 0);
      const contradictions = f.contradictions + (verdict === 'contradict' ? 1 : 0);
      // Decay alone never takes a positive score below zero: only a contradiction retires.
      // A contradiction weighs five confirmations, and a score is at most five
      // (1 / (1 - DECAY)), so a counted contradiction always takes it below zero.
      const retireReason = verdict !== 'contradict' ? null : f.high ? 'contradicted (high stakes)' : 'contradicted';
      const state = retireReason ? 'retired' : confirmations >= CONFIRMATIONS ? 'active' : f.state;
      db.prepare(
        `UPDATE pinned_facts SET state = ?, score = ?, confirmations = ?, exercised = exercised + ?, applied = applied + ?,
           contradictions = ?, params = ?, sessions = ?, updated_at = ?, retired_at = ?, retired_reason = ? WHERE id = ?`,
      ).run(
        state,
        score,
        confirmations,
        e?.exercised ? 1 : 0,
        e?.applied ? 1 : 0,
        contradictions,
        JSON.stringify(params),
        JSON.stringify([...seen, sessionId].slice(-50)),
        at,
        retireReason ? at : null,
        retireReason,
        f.id,
      );
    }
    // New facts: only a confirmation starts one. A fact that is retired stays
    // retired; the same claim must form again under a new key to come back.
    const insert = db.prepare(
      `INSERT OR IGNORE INTO pinned_facts (project, fact_key, family, kind, text, params, source, state, score, confirmations,
         exercised, applied, high, sessions, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'forming', 1, 1, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of byKey.values()) {
      if (e.verdict !== 'confirm') continue;
      insert.run(project, e.key, e.family, e.kind, e.text, JSON.stringify(e.params), e.source, e.exercised ? 1 : 0, e.applied ? 1 : 0, e.high ? 1 : 0, JSON.stringify([sessionId]), at, at);
    }
  })();
}

/** An active fact earns its place while it keeps applying in the sessions that exercise it. */
export function injectable(f: Pick<FactRow, 'state' | 'text' | 'exercised' | 'applied'>): boolean {
  if (f.state !== 'active' || LINT.test(f.text)) return false;
  return f.exercised < MIN_EXERCISED || f.applied / f.exercised >= MIN_APPLIED_SHARE;
}

/**
 * The pinned part of the session-start block, or null: at most
 * `memory.pinned_facts` facts and about `PINNED_TOKENS` tokens, environment
 * facts limited to `ENV_FACTS_MAX`. Records which facts the session was shown.
 */
export function pinnedLines(db: DB, config: EklavyaConfig, project: string, sessionId: string | null): string[] | null {
  const max = config.memory.pinned_facts;
  if (!max || config.economy.envfacts === 'off') return null;
  const rows = (db.prepare(`SELECT * FROM pinned_facts WHERE project = ? AND state = 'active' ORDER BY score DESC, id`).all(project) as FactRow[]).filter(
    (f) => injectable(f) && (f.source === 'free' || config.economy.envfacts === 'observer'),
  );
  const header = 'Pinned facts, learned across earlier sessions here (evidence too: verify before relying on one):';
  const chosen: FactRow[] = [];
  let tokens = estimateTokens(header);
  let env = 0;
  for (const f of rows) {
    if (chosen.length >= max) break;
    if (f.kind === 'env' && env >= ENV_FACTS_MAX) continue;
    const cost = estimateTokens(`- ${f.text}`);
    if (tokens + cost > PINNED_TOKENS) continue;
    chosen.push(f);
    tokens += cost;
    if (f.kind === 'env') env++;
  }
  if (!chosen.length) return null;
  if (sessionId) {
    const shown = db.prepare('INSERT OR IGNORE INTO pinned_fact_shown (session_id, fact_id, shown_at) VALUES (?, ?, ?)');
    for (const f of chosen) shown.run(sessionId, f.id, nowIso());
  }
  return [header, ...chosen.map((f) => `- ${defangFence(f.text)}`)];
}

export function listFacts(db: DB, project: string, includeRetired = false): FactRow[] {
  return db
    .prepare(`SELECT * FROM pinned_facts WHERE project = ? ${includeRetired ? '' : "AND state != 'retired'"} ORDER BY state = 'active' DESC, score DESC, id`)
    .all(project) as FactRow[];
}

/** Retires one fact by hand. False when there is no such live fact in this project. */
export function retireFact(db: DB, project: string, id: number, reason = 'retired by hand'): boolean {
  return (
    db
      .prepare(`UPDATE pinned_facts SET state = 'retired', retired_at = ?, retired_reason = ?, updated_at = ? WHERE id = ? AND project = ? AND state != 'retired'`)
      .run(nowIso(), reason, nowIso(), id, project).changes > 0
  );
}
