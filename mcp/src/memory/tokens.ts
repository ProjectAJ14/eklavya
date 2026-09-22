/**
 * Token accounting for the savings ledger (PRD MET-01).
 *
 * The contract is not "be exact" — it is "be the same method on both sides of
 * the subtraction, and say which method it was". A receipt stores `method`, and
 * a percentage is only computed from two counts that share it. That is what
 * stops the classic dishonest number: a generous estimate of what was avoided
 * against a tight count of what was sent.
 */

/** Identity of the estimator, stored on every receipt. */
export const ESTIMATOR = 'chars4-v1';

/**
 * Four characters per token, the usual English-code approximation. It is an
 * estimate and every surface that shows a number derived from it says so.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function estimateTokensOf(parts: (string | null | undefined)[]): number {
  return estimateTokens(parts.filter(Boolean).join('\n'));
}

export interface SavingsInput {
  baseTokens: number;
  deliveredTokens: number;
  delivery: 'confirmed' | 'unknown' | 'prepared';
}

export type Savings =
  | { kind: 'none' }
  | { kind: 'unavailable' }
  | { kind: 'saving'; percent: number; base: number; delivered: number }
  | { kind: 'overhead'; tokens: number; base: number; delivered: number };

/**
 * The one place the percentage is computed. Every caller — banner, dashboard,
 * CLI — goes through it, so they cannot drift into three different arithmetics.
 *
 * Negative saving is reported as overhead rather than clamped to zero: reuse
 * that costs more than it saves is a real outcome and hiding it is how a
 * measurement becomes marketing.
 */
export function savingsFrom(input: SavingsInput): Savings {
  const { baseTokens: base, deliveredTokens: delivered, delivery } = input;
  if (base <= 0 && delivered <= 0) return { kind: 'none' };
  if (delivery !== 'confirmed' || base <= 0) return { kind: 'unavailable' };
  if (delivered > base) return { kind: 'overhead', tokens: delivered - base, base, delivered };
  return { kind: 'saving', percent: Math.round((100 * (base - delivered)) / base), base, delivered };
}

/** The banner line for a savings result (UX-01 wording). */
export function savingsLine(s: Savings): string {
  switch (s.kind) {
    case 'none':
      return 'Your savings: — no context reused yet';
    case 'unavailable':
      return 'Your savings: — unavailable';
    case 'overhead':
      return `Reuse overhead: ${s.tokens} tokens (estimated)`;
    case 'saving':
      return `Your savings: ${s.percent}% less context from reuse (estimated)`;
  }
}
