import type { DB } from './db.js';
import type { EklavyaConfig } from './config.js';
import { TurnState, emptyTurn, type TurnData } from './economy/signals.js';
import { isEklavyaTool } from './economy/transcript.js';
import {
  decide,
  envelopeOf,
  ENVELOPE_HISTORY,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  parseVerdict,
  redirectText,
  thresholdsFor,
  type JudgeVerdict,
  type Thresholds,
} from './economy/loopguard.js';

/**
 * The loop guard's database side (issue #262): one turn row per prompt,
 * folded on every tool call by `capture-tool`, closed at `Stop`.
 *
 * Nudge only. A stuck turn gets at most `economy.nudges` redirects as
 * `additionalContext`, then one notice: Claude is asked to tell the developer
 * in a line, and the status line shows it. Nothing here stops an interactive
 * turn; `economy.loopguard = stop` ends only a headless one.
 */

const nowIso = () => new Date().toISOString();

/** Calls the guard never counts: Eklavya's own tools and the question card. */
export const ignoredTool = (tool: string): boolean => isEklavyaTool(tool) || tool === 'AskUserQuestion';

interface TurnRow {
  id: number;
  project: string | null;
  state: string;
  nudges: number;
  noticed: number;
  judge_status: string | null;
  verdict: string | null;
}

function openRow(db: DB, sessionId: string, agentId: string): TurnRow | undefined {
  return db
    .prepare(
      `SELECT id, project, state, nudges, noticed, judge_status, verdict FROM econ_turns
       WHERE session_id = ? AND agent_id = ? AND closed_at IS NULL ORDER BY id DESC LIMIT 1`,
    )
    .get(sessionId, agentId) as TurnRow | undefined;
}

function event(db: DB, row: { sessionId: string; project: string | null; turnId: number | null; kind: string; reason: string }): void {
  db.prepare('INSERT INTO econ_guard_events (at, session_id, project, turn_id, kind, reason) VALUES (?, ?, ?, ?, ?, ?)').run(
    nowIso(),
    row.sessionId,
    row.project,
    row.turnId,
    row.kind,
    row.reason.slice(0, 300),
  );
}

/** Opens a turn at a prompt, closing any the session left open (a turn that never reached Stop is unknown). */
export function openTurn(db: DB, row: { sessionId: string; agentId?: string | null; project: string | null }): number {
  const agent = row.agentId ?? '';
  db.prepare(`UPDATE econ_turns SET closed_at = ?, outcome = 'unknown' WHERE session_id = ? AND agent_id = ? AND closed_at IS NULL`).run(
    nowIso(),
    row.sessionId,
    agent,
  );
  return Number(
    db
      .prepare('INSERT INTO econ_turns (session_id, agent_id, project, opened_at, state) VALUES (?, ?, ?, ?, ?)')
      .run(row.sessionId, agent, row.project, nowIso(), JSON.stringify(emptyTurn())).lastInsertRowid,
  );
}

/** Call counts of this project's turns that ended green, oldest first. */
export function greenCalls(db: DB, project: string | null): number[] {
  if (!project) return [];
  return (
    db
      .prepare('SELECT calls FROM (SELECT id, calls FROM econ_envelope WHERE project = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
      .all(project, ENVELOPE_HISTORY) as { calls: number }[]
  ).map((r) => r.calls);
}

export function thresholdsOf(config: EklavyaConfig): Thresholds {
  const e = config.economy;
  return thresholdsFor(e.loopguard_level, {
    judge_confidence: e.judge_confidence,
    backstop_mult: e.backstop_mult,
    envelope_min_samples: e.envelope_min_samples,
  });
}

export interface GuardOutput {
  /** For `additionalContext`: a redirect, or the notice. */
  context?: string;
  /** Headless with `loopguard = stop`, nudges spent: end the turn with this reason. */
  stop?: string;
  /** A judge should be started for this turn. */
  judgeTurn?: number;
}

/** Calls a judge's verdict stays valid for. */
export const VERDICT_CALLS = 10;

export const NOTICE =
  '[Eklavya loop check] This turn still looks stuck after the redirect. Tell the developer in one short line that ' +
  'Eklavya\'s loop guard thinks the turn is going round in circles, so they can step in; then carry on.';

/**
 * Folds one finished tool call into the session's open turn and decides.
 * Returns what the hook should say, if anything. No open turn (the guard was
 * switched on mid-turn, or this is Eklavya's own activity) is nothing.
 */
export function foldCall(
  db: DB,
  config: EklavyaConfig,
  call: {
    sessionId: string;
    agentId?: string | null;
    tool: string;
    args: Record<string, unknown>;
    result: string;
    failed: boolean | null;
    headless?: boolean;
  },
): GuardOutput {
  if (config.economy.loopguard === 'off' || ignoredTool(call.tool)) return {};
  const agent = call.agentId ?? '';
  const row = openRow(db, call.sessionId, agent);
  if (!row) return {};
  const state = new TurnState(JSON.parse(row.state) as TurnData);
  state.update(call.tool, call.args, call.result, call.failed);
  const t = thresholdsOf(config);
  const envelope = envelopeOf(greenCalls(db, row.project), t);
  // A verdict holds for `VERDICT_CALLS` calls; after that the turn may have
  // changed and a fresh look is due.
  // `judgeTurn` always stores an object with the call count it judged at.
  const stored = row.judge_status === 'done' ? (JSON.parse(row.verdict!) as JudgeVerdict & { at_calls: number }) : null;
  const fresh = stored && state.d.calls - stored.at_calls < VERDICT_CALLS ? parseVerdict(stored) : null;
  const verdict: JudgeVerdict | null | undefined = row.judge_status === 'pending' ? null : fresh ?? undefined;
  const judged = row.judge_status === 'done';
  const decision = decide(state.snapshot(), t, envelope, { configured: Boolean(config.providers.judge), verdict });

  const out: GuardOutput = {};
  let { nudges, noticed } = row;
  let judgeStatus = row.judge_status;
  let verdictJson = row.verdict;
  if (decision.act === 'ask_judge') {
    judgeStatus = 'pending';
    out.judgeTurn = row.id;
    event(db, { sessionId: call.sessionId, project: row.project, turnId: row.id, kind: 'judge', reason: decision.reason });
  } else if (decision.act === 'redirect' && !agent) {
    // Subagent turns are tracked, never nudged, until it is known whether a
    // PostToolUse context reaches a background agent (#257, open question).
    if (nudges < config.economy.nudges) {
      nudges++;
      out.context = verdict?.redirect ? `[Eklavya loop check] ${verdict.redirect}` : redirectText(state);
      event(db, { sessionId: call.sessionId, project: row.project, turnId: row.id, kind: 'redirect', reason: decision.reason });
    } else if (call.headless && config.economy.loopguard === 'stop') {
      out.stop = 'Eklavya loop guard: the turn kept repeating the same failure after the redirect.';
      event(db, { sessionId: call.sessionId, project: row.project, turnId: row.id, kind: 'stop', reason: decision.reason });
    } else if (!noticed) {
      noticed = 1;
      out.context = NOTICE;
      event(db, { sessionId: call.sessionId, project: row.project, turnId: row.id, kind: 'notice', reason: decision.reason });
    }
  }
  // A verdict is spent once acted on or out of date, so the next decision needs a fresh look.
  if (judged && (decision.act !== 'none' || !fresh)) {
    judgeStatus = null;
    verdictJson = null;
  }
  db.prepare('UPDATE econ_turns SET state = ?, nudges = ?, noticed = ?, judge_status = ?, verdict = ? WHERE id = ?').run(
    JSON.stringify(state.d),
    nudges,
    noticed,
    judgeStatus,
    verdictJson,
    row.id,
  );
  return out;
}

/**
 * Closes the session's open turn at Stop with its outcome. A main-thread
 * turn that ended green feeds this project's envelope; a turn's own outcome
 * only ever gates later turns.
 */
export function closeTurn(db: DB, row: { sessionId: string; agentId?: string | null }): 'green' | 'red' | 'unknown' | null {
  const agent = row.agentId ?? '';
  const open = openRow(db, row.sessionId, agent);
  if (!open) return null;
  const state = new TurnState(JSON.parse(open.state) as TurnData);
  const outcome = state.verdict;
  db.prepare('UPDATE econ_turns SET closed_at = ?, outcome = ? WHERE id = ?').run(nowIso(), outcome, open.id);
  if (outcome === 'green' && !agent && open.project && state.d.calls > 0) {
    db.prepare('INSERT INTO econ_envelope (project, calls, snapshot, recorded_at) VALUES (?, ?, ?, ?)').run(
      open.project,
      state.d.calls,
      JSON.stringify(state.snapshot()),
      nowIso(),
    );
  }
  return outcome;
}

export { guardNote } from './guard-note.js';

/**
 * `eklavya judge <turn>`: asks `providers.judge` whether the turn is stuck,
 * with a digest of counts and command shapes, and stores the verdict for the
 * next tool call to read. Any failure stores "unsure", so a turn is never
 * left waiting on a judge that will not answer.
 */
export async function judgeTurn(
  db: DB,
  config: EklavyaConfig,
  turnId: number,
  run: (model: string, prompt: string, spec: { schema: object; system: string; source: string }) => Promise<unknown>,
): Promise<JudgeVerdict | null> {
  const row = db.prepare('SELECT project, state FROM econ_turns WHERE id = ?').get(turnId) as { project: string | null; state: string } | undefined;
  if (!row) return null;
  const state = new TurnState(JSON.parse(row.state) as TurnData);
  let verdict: JudgeVerdict = { stuck: null, confidence: 0, reason: 'no judge configured' };
  if (config.providers.judge) {
    const envelope = envelopeOf(greenCalls(db, row.project), thresholdsOf(config));
    try {
      verdict = parseVerdict(await run(config.providers.judge.model, state.digest(envelope), { schema: JUDGE_SCHEMA, system: JUDGE_SYSTEM, source: 'judge' })) ?? {
        stuck: null,
        confidence: 0,
        reason: 'the judge answered in the wrong shape',
      };
    } catch (err) {
      verdict = { stuck: null, confidence: 0, reason: `the judge failed: ${(err as Error).message}`.slice(0, 200) };
    }
  }
  db.prepare(`UPDATE econ_turns SET judge_status = 'done', verdict = ? WHERE id = ?`).run(
    JSON.stringify({ ...verdict, at_calls: state.d.calls }),
    turnId,
  );
  return verdict;
}

/** Redirects, notices, stops and judge calls since `sinceIso`, per kind. */
export function guardCounts(db: DB, project: string | null, sinceIso: string): Record<string, number> {
  const rows = db
    .prepare(`SELECT kind, COUNT(*) AS n FROM econ_guard_events WHERE at >= ? AND (? IS NULL OR project = ?) GROUP BY kind`)
    .all(sinceIso, project, project) as { kind: string; n: number }[];
  return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
}
