/**
 * The one clock policy (PRD LRN-03): every subsystem parses and formats
 * timestamps the same way, so a cooldown, a review date, a banner count and a
 * memory timeline never disagree about what "now" is.
 */

/** Minutes since a timestamp, or a number large enough to never gate. */
export const NEVER = 999_999;

/**
 * The idle gap that ends a stretch of work. A question is about the work on
 * screen now: a session left open overnight, or resumed the next morning, was
 * asked about the previous day's code while its developer was checking a
 * server mount. So logged work goes stale once the session comes back after
 * this long with no prompt and no tool call (`workSince` in session.ts). A wall-clock window
 * would be wrong the other way: concepts are usually logged once, at the start
 * of a task, and a two-hour task would fall silent after its first hour. Both
 * quiz hooks and the planner read the same boundary -- a concept one of them
 * can ask and another cannot is asked twice or never. Enforced gates ignore
 * it: their bar was frozen from everything logged.
 */
export const IDLE_BREAK_MINUTES = 60;

/**
 * Minutes since a timestamp written by SQLite.
 *
 * This schema stores two shapes, and the difference is a trap. `strftime(...Z)`
 * is explicitly UTC, but `datetime('now')` — the default on `session_concepts.ts`
 * and `attempts.ts` — produces "2026-09-05 18:04:09": UTC, with nothing saying
 * so. `Date.parse` reads that as LOCAL time, so every cooldown came out wrong by
 * the machine's UTC offset, and west of UTC the elapsed time was negative and no
 * cooldown ever passed. The shell version never had this bug because `julianday`
 * assumes UTC for exactly this format.
 *
 * So: normalise to UTC before parsing, and never return a negative — a clock
 * that has moved backwards should read as "just now", not as "never".
 */
export function minutesSince(ts: string | null | undefined): number {
  const then = parseStamp(ts);
  if (then === null) return NEVER;
  return Math.max(0, Math.floor((Date.now() - then) / 60_000));
}

/** Epoch milliseconds for either stored shape, or null if unparseable. */
export function parseStamp(ts: string | null | undefined): number | null {
  if (!ts) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(ts);
  const normalised = hasZone ? ts : `${ts.replace(' ', 'T')}Z`;
  const ms = Date.parse(normalised);
  return Number.isNaN(ms) ? null : ms;
}

/** The timestamp format every table in this schema stores. */
export function nowIso(): string {
  return new Date().toISOString().replace(/(\.\d{3})Z$/, '$1Z');
}
