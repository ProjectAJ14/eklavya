import type { DB } from './db.js';
import { openDb } from './db.js';
import { initializeGlobalConfig, loadConfig } from './config.js';
import { identityFor } from './memory/identity.js';
import { costCsv, foldSession, overheadBySource, quietPending, sessionCosts, weeklyCosts, type SessionCost } from './ledger.js';
import { bold, dim, failText, heading, paint } from './theme.js';

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
      process.stdout.write(
        `${r.sessionId}: ${r.found ? `${compact(r.effective)} effective tokens` : 'no usage found'}${r.unpriced.length ? ` (unpriced: ${r.unpriced.join(', ')})` : ''}\n`,
      );
    }
  });
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
