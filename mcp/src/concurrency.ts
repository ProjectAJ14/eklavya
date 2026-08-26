/**
 * Several Claude Code sessions and the git pre-commit hook can hit the same
 * SQLite file at once (PRD §8 "Concurrency"). WAL plus `busy_timeout` handles
 * almost all of it; what remains is the case where two writers upgrade to a
 * write transaction at the same moment and SQLite returns SQLITE_BUSY
 * immediately rather than waiting.
 *
 * A busy transaction has already been rolled back, so retrying it is safe —
 * that is what makes this wrapper correct for writes and not just for reads.
 */

const BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED']);

export const MAX_BUSY_ATTEMPTS = 5;

function isBusy(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: string }).code;
  return typeof code === 'string' && BUSY_CODES.has(code);
}

/** Blocking backoff — better-sqlite3 is synchronous, so there is nothing to await. */
function sleepSync(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // busy-wait; only ever a few milliseconds, and only under real contention
  }
}

export function retryOnBusy<T>(fn: () => T, attempts = MAX_BUSY_ATTEMPTS): T {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return fn();
    } catch (err) {
      if (!isBusy(err)) throw err;
      lastError = err;
      sleepSync(10 * (attempt + 1));
    }
  }

  throw lastError;
}
