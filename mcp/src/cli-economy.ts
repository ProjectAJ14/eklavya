import fs from 'node:fs';
import path from 'node:path';
import type { DB } from './db.js';
import type { EklavyaConfig } from './config.js';
import { readCalls } from './economy/transcript.js';
import { applyProposal, measureProposal, proposal, recordToolUse, restoreNewlyProtected, restoreTools, writeRecord } from './toolprune-store.js';
import { applySetting } from './config-path.js';
import { foldSessionFacts, injectable, listFacts, retireFact, sessionEvidence } from './memory/pinned.js';
import { openDb } from './db.js';
import { initializeGlobalConfig, loadConfig } from './config.js';
import { identityFor } from './memory/identity.js';
import { costCsv, foldSession, overheadBySource, quietPending, sessionCosts, weeklyCosts, type FoldResult, type SessionCost } from './ledger.js';
import { bold, dim, failText, heading, paint } from './theme.js';
import { guardCounts, judgeTurn } from './loop-guard.js';
import { meterProviderCalls } from './ledger.js';
import { readResult, runClaude } from './memory/provider.js';

/**
 * The cost commands (issue #257): `eklavya fold`, `eklavya cost`. Loaded only
 * when one of them runs, so the status line and hooks never pay for it.
 */

function fail(message: string): never {
  process.stderr.write(`${failText(message)}\n`);
  process.exit(1);
}

const flagValue = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

/** `1234567` → `1.2M`, `12345` → `12.3k`. */
export const compact = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n));

function withDb<T>(fn: (db: DB) => T): T {
  initializeGlobalConfig();
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/**
 * `eklavya fold <session> [--transcript <file>]` prices one session;
 * `eklavya fold --pending` prices every session whose transcript has been
 * quiet for ten minutes. Started detached by the hooks; safe to run by hand.
 */
export function foldCommand(args: string[]): void {
  const config = loadConfig().config;
  withDb((db) => {
    const ids = args.includes('--pending') ? quietPending(db, Date.now()) : args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--transcript');
    if (!ids.length && !args.includes('--pending')) fail('Usage: eklavya fold <session-id> [--transcript <file>] | --pending');
    for (const id of ids) {
      const r = foldSession(db, config, id, { transcript: flagValue(args, '--transcript') ?? null });
      afterFold(db, config, r);
      process.stdout.write(
        `${r.sessionId}: ${r.found ? `${compact(r.effective)} effective tokens` : 'no usage found'}${r.unpriced.length ? ` (unpriced: ${r.unpriced.join(', ')})` : ''}\n`,
      );
    }
  });
}

/**
 * What else a folded session teaches, each part failing on its own: the
 * tool-use evidence pruning proposes from, a pruned tool that has since become
 * protected coming back, the automatic deny list in `on` mode, and the
 * environment facts.
 */
export function afterFold(db: DB, config: EklavyaConfig, r: FoldResult): void {
  if (!r.project || !r.summary) return;
  const repo = fs.existsSync(path.join(r.project, '.git')) ? r.project : null;
  const steps: (() => void)[] = [
    () => recordToolUse(db, r.project!, r.sessionId, r.summary!),
    () => void (repo && restoreNewlyProtected(db, config, r.project!, repo)),
    () => {
      if (!repo || config.economy.toolprune !== 'on') return;
      const last = db.prepare('SELECT MAX(ended_at) AS at FROM econ_sessions WHERE project = ?').get(r.project) as { at: string | null };
      if (last.at && Date.now() - Date.parse(last.at) >= config.economy.toolprune_quiet_minutes * 60_000) applyProposal(db, config, r.project!, repo);
    },
    () => stepExperiment(db, r.project!),
    () => {
      if (config.economy.envfacts === 'off' || !r.file) return;
      foldSessionFacts(db, r.project!, r.sessionId, sessionEvidence(db, r.project!, readCalls(r.file)));
    },
  ];
  for (const step of steps) {
    try {
      step();
    } catch {
      /* Each part is a measurement or a proposal; one failing leaves the others. */
    }
  }
}

function sessionLine(s: SessionCost): string {
  const day = (s.started_at ?? '').slice(0, 16).replace('T', ' ') || 'unknown time';
  const split = `fresh ${compact(s.input)} · cached ${compact(s.cache_read)} · written ${compact(s.cache_write_5m + s.cache_write_1h)} · out ${compact(s.output)}`;
  const share = s.effective ? Math.round((100 * s.eklavya_effective) / s.effective) : 0;
  const unpriced = s.unpriced ? ` ${paint.warn(`unpriced: ${(JSON.parse(s.unpriced) as string[]).join(', ')}`)}` : '';
  return [
    `${bold(day)}  ${compact(s.effective)} effective${s.model ? ` on ${s.model}` : ''}${unpriced}`,
    `  ${dim(split)}`,
    `  ${dim(`Eklavya ${compact(s.eklavya_effective)} (${share}%: quiz ${compact(s.quiz_effective)}) · background calls ${compact(s.overhead_effective)} · ${s.prompts} prompt(s), ${s.tool_calls} tool call(s)`)}`,
  ].join('\n');
}

/**
 * `eklavya cost` — the last sessions in this repository, from the ledger.
 * `--all` every repository, `--limit <n>`, `--by-week`, `--export csv`.
 */
export function costCommand(args: string[]): void {
  const project = args.includes('--all') ? null : identityFor({ sessionId: '' }).project;
  const limit = Number(flagValue(args, '--limit') ?? 10);
  if (!Number.isInteger(limit) || limit < 1) fail('eklavya cost: --limit is a whole number of sessions, 1 or more');
  const exportAs = flagValue(args, '--export');
  if (exportAs !== undefined && exportAs !== 'csv') fail('eklavya cost: --export takes csv');
  withDb((db) => {
    if (exportAs === 'csv') {
      process.stdout.write(costCsv(db, project));
      return;
    }
    if (args.includes('--by-week')) {
      const weeks = weeklyCosts(db, project);
      process.stdout.write(`${heading('Cost by week')} ${dim('(effective tokens: fresh-input equivalents of the model that served them)')}\n`);
      if (!weeks.length) process.stdout.write(`${dim('No folded sessions yet.')}\n`);
      for (const w of weeks) {
        process.stdout.write(`${bold(w.week)}  ${w.sessions} session(s) · ${compact(w.effective)} effective · Eklavya in sessions ${compact(w.eklavya_effective)} · background calls ${compact(w.overhead_effective)}\n`);
      }
      return;
    }
    const rows = sessionCosts(db, project, limit);
    process.stdout.write(
      `${heading(project ? 'Cost of recent sessions here' : 'Cost of recent sessions')} ${dim('(effective tokens: fresh-input equivalents of the model that served them; measured from transcripts)')}\n`,
    );
    if (!rows.length) process.stdout.write(`${dim('No folded sessions yet. A session is priced when it ends, or ten minutes after it goes quiet.')}\n`);
    for (const s of rows) process.stdout.write(`${sessionLine(s)}\n`);
    const guard = guardLine(db, project);
    if (guard) process.stdout.write(`\n${guard}\n`);
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const own = overheadBySource(db, project, since);
    if (own.length) {
      process.stdout.write(`\n${heading('Eklavya\'s own calls, last 7 days')}\n`);
      for (const o of own) {
        const usd = o.cost_usd !== null ? ` · $${o.cost_usd.toFixed(2)} as reported` : '';
        process.stdout.write(`${o.source}: ${o.calls} call(s) · ${compact(o.effective)} effective${o.unpriced ? ` · ${o.unpriced} unpriced` : ''}${usd}\n`);
      }
    }
  });
}

/**
 * `eklavya judge <turn>` — asks `providers.judge` whether a loop-guard turn is
 * stuck. Started detached by `capture-tool`; the hook never waits for it.
 * Its usage goes to the ledger like every other `claude -p` call.
 */
export async function judgeCommand(args: string[]): Promise<void> {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id < 1) fail('Usage: eklavya judge <turn-id>');
  const config = loadConfig().config;
  initializeGlobalConfig();
  const db = openDb();
  try {
    const turn = db.prepare('SELECT session_id, project FROM econ_turns WHERE id = ?').get(id) as { session_id: string; project: string | null } | undefined;
    meterProviderCalls(db, config, { sessionId: turn?.session_id ?? null, project: turn?.project ?? null });
    const verdict = await judgeTurn(db, config, id, async (model, prompt, spec) => readResult(await runClaude(model, prompt, { spec })));
    process.stdout.write(`${verdict ? JSON.stringify(verdict) : `No turn ${id}.`}\n`);
  } finally {
    db.close();
  }
}

/** The guard's line in `eklavya cost`: redirects, notices and judge calls in the last week. */
export function guardLine(db: DB, project: string | null): string | null {
  const c = guardCounts(db, project, new Date(Date.now() - 7 * 86_400_000).toISOString());
  if (!Object.keys(c).length) return null;
  return `Loop guard, last 7 days: ${c.redirect ?? 0} redirect(s), ${c.notice ?? 0} notice(s), ${c.judge ?? 0} judge call(s)${c.stop ? `, ${c.stop} headless stop(s)` : ''}`;
}

/** This checkout's project key and its main checkout's root, or a failure: pruning writes to a checkout. */
function checkout(): { project: string; repo: string } {
  const project = identityFor({ sessionId: '' }).project;
  if (!fs.existsSync(path.join(project, '.git'))) fail('eklavya toolprune works inside a git checkout.');
  return { project, repo: project };
}

/**
 * `eklavya toolprune [list|apply|restore|measure|refresh-catalog]` — tools this
 * repository's sessions load and never use (issue #263). `list` writes
 * nothing; `apply` writes the deny list; `restore` removes exactly what
 * Eklavya wrote and keeps those tools from being proposed again.
 */
export function toolpruneCommand(args: string[]): void {
  const [sub = 'list', ...rest] = args;
  const config = loadConfig().config;
  const { project, repo } = checkout();
  withDb((db) => {
    const only = rest.filter((a) => !a.startsWith('--'));
    switch (sub) {
      case 'list': {
        const rows = proposal(db, config, project);
        const written = writeRecord(db, project)?.added ?? [];
        process.stdout.write(`${heading('Tool pruning')} ${dim(`(economy.toolprune: ${config.economy.toolprune})`)}\n`);
        if (!rows.length) process.stdout.write(`${dim('Nothing to propose yet: a tool needs to go unused across several sessions.')}\n`);
        for (const r of rows) process.stdout.write(`${r.tool}  ${dim(`unused for ${r.prompts_since} prompt(s) across ${r.sessions_since} session(s)`)}\n`);
        if (written.length) process.stdout.write(`\n${dim(`Denied by Eklavya in .claude/settings.local.json: ${written.join(', ')}`)}\n`);
        if (rows.length) process.stdout.write(`\n${dim('Write them with: eklavya toolprune apply   (undo with: eklavya toolprune restore)')}\n`);
        return;
      }
      case 'apply': {
        const r = applyProposal(db, config, project, repo, only.length ? only : undefined);
        if (!r.ok) fail(`eklavya toolprune apply: not written: ${r.reason}`);
        process.stdout.write(r.tools.length ? `${paint.ok('Denied')} ${r.tools.join(', ')} in .claude/settings.local.json. They are gone from the next session.\n` : 'Nothing to deny.\n');
        return;
      }
      case 'restore': {
        const r = restoreTools(db, project, repo, only.length ? only : undefined);
        if (!r.ok) fail(`eklavya toolprune restore: ${r.reason}`);
        process.stdout.write(r.tools.length ? `${paint.ok('Restored')} ${r.tools.join(', ')}. They will not be proposed again.\n` : 'Nothing of Eklavya\'s to restore.\n');
        return;
      }
      case 'measure': {
        const m = measureProposal(db, config, project);
        process.stdout.write(
          `${m.tools} tool(s) proposed, ${m.deferred} of them deferred: about ${m.listingTokens} tokens of tool listing a request.\n` +
            `${dim('A deferred tool costs one listing line until it is loaded. Full definition sizes of the others are not measured here.')}\n`,
        );
        return;
      }
      case 'refresh-catalog': {
        const ids = quietPending(db, Date.now());
        for (const id of ids) afterFold(db, config, foldSession(db, config, id));
        const n = (db.prepare('SELECT COUNT(*) AS n FROM econ_tool_use WHERE project = ?').get(project) as { n: number }).n;
        process.stdout.write(`Folded ${ids.length} waiting session(s). ${n} tool(s) seen loaded in this repository.\n`);
        return;
      }
      default:
        fail('Usage: eklavya toolprune [list|apply|restore|measure|refresh-catalog] [tool...]');
    }
  });
}

/** `eklavya memory facts [retire <id>] [--all]` — pinned facts, with their evidence (issue #264). */
export function factsCommand(args: string[]): void {
  const project = identityFor({ sessionId: '' }).project;
  withDb((db) => {
    if (args[0] === 'retire') {
      const id = Number(args[1]);
      if (!Number.isInteger(id)) fail('Usage: eklavya memory facts retire <id>');
      if (!retireFact(db, project, id)) fail(`No live fact #${id} in this project.`);
      process.stdout.write(`${paint.ok(`Retired #${id}.`)} It will not be shown again.\n`);
      return;
    }
    const rows = listFacts(db, project, args.includes('--all'));
    process.stdout.write(`${heading('Pinned facts')} ${dim('(active ones are shown first at session start)')}\n`);
    if (!rows.length) process.stdout.write(`${dim('None yet. A fact forms once three sessions confirm it.')}\n`);
    for (const f of rows) {
      const shown = injectable(f) ? paint.ok('shown') : dim(f.state === 'active' ? 'held back' : f.state);
      process.stdout.write(
        `#${f.id} [${shown}] ${f.text}\n   ${dim(`${f.kind} · ${f.source} · confirmed in ${f.confirmations} session(s), applied ${f.applied}/${f.exercised}, contradicted ${f.contradictions}, score ${f.score.toFixed(2)}${f.retired_reason ? ` · ${f.retired_reason}` : ''}`)}\n`,
      );
    }
  });
}

const EXPERIMENT_KEY = (project: string) => `experiment:memory:${project}`;

/**
 * `eklavya experiment memory --sessions 20 | --report | --stop` — alternates
 * `memory.enabled` for this project at each folded session and compares the
 * median cost per arm. Twenty sessions is a signal, not proof.
 */
export function experimentCommand(args: string[]): void {
  if (args[0] !== 'memory') fail('Usage: eklavya experiment memory --sessions <n> | --report | --stop');
  const project = identityFor({ sessionId: '' }).project;
  const config = loadConfig(project).config;
  withDb((db) => {
    const key = EXPERIMENT_KEY(project);
    const state = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    if (args.includes('--stop')) {
      if (state) endExperiment(db, project, JSON.parse(state.value) as Experiment);
      process.stdout.write(state ? 'Stopped; memory.enabled is back to what it was.\n' : 'No experiment running here.\n');
      return;
    }
    if (args.includes('--report')) return void process.stdout.write(experimentReport(db, project));
    const n = Number(flagValue(args, '--sessions') ?? 20);
    if (!Number.isInteger(n) || n < 2 || n > 200) fail('eklavya experiment memory: --sessions is a whole number from 2 to 200');
    if (state) fail('An experiment is already running here: --report to see it, --stop to end it.');
    const exp: Experiment = { left: n, original: config.memory.enabled, started: new Date().toISOString() };
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, JSON.stringify(exp));
    process.stdout.write(`Started: memory will alternate off and on for the next ${n} session(s) here. eklavya experiment memory --report shows the result.\n`);
  });
}

interface Experiment {
  left: number;
  original: boolean;
  started: string;
}

function endExperiment(db: DB, project: string, exp: Experiment): void {
  applySetting('memory.enabled', exp.original, project);
  db.prepare('DELETE FROM meta WHERE key = ?').run(EXPERIMENT_KEY(project));
}

/** Called after each fold: flips `memory.enabled` for the next session, until the run is spent. */
export function stepExperiment(db: DB, project: string): void {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(EXPERIMENT_KEY(project)) as { value: string } | undefined;
  if (!row) return;
  const exp = JSON.parse(row.value) as Experiment;
  exp.left--;
  if (exp.left <= 0) return endExperiment(db, project, exp);
  // Odd sessions left run with memory off, so the arms alternate.
  applySetting('memory.enabled', exp.left % 2 === 0, project);
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(JSON.stringify(exp), EXPERIMENT_KEY(project));
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** Median effective tokens and prompts per arm, from each folded session's settings snapshot. */
export function experimentReport(db: DB, project: string): string {
  const rows = db
    .prepare(`SELECT effective, prompts, settings FROM econ_sessions WHERE project = ? AND folded_at IS NOT NULL AND settings IS NOT NULL`)
    .all(project) as { effective: number; prompts: number; settings: string }[];
  const arms: Record<'on' | 'off', { effective: number[]; prompts: number[] }> = { on: { effective: [], prompts: [] }, off: { effective: [], prompts: [] } };
  for (const r of rows) {
    const arm = (JSON.parse(r.settings) as { memory?: { enabled?: boolean } }).memory?.enabled === false ? 'off' : 'on';
    arms[arm].effective.push(r.effective);
    arms[arm].prompts.push(r.prompts);
  }
  const line = (name: 'on' | 'off') =>
    `memory ${name}: ${arms[name].effective.length} session(s), median ${compact(median(arms[name].effective) ?? 0)} effective tokens, median ${median(arms[name].prompts) ?? 0} prompt(s)`;
  return `${line('on')}\n${line('off')}\n${dim('Measured from transcripts. A few dozen sessions is a signal, not proof: tasks differ more than arms do.')}\n`;
}
