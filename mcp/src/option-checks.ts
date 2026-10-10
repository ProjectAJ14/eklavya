/**
 * The record behind the live option-length check (migration 028): how often a
 * question was sent back, and whether the rewrite still tripped the check.
 * Light enough for a hook to import; fails open, because counting must never
 * stand between a learner and a question.
 */
import type Database from 'better-sqlite3';

export type OptionCheckOutcome = 'sent_back' | 'rewritten' | 'unchanged';

export function recordOptionCheck(
  db: Database.Database,
  row: { sessionId: string; slug?: string | null; surface: 'panel' | 'card'; outcome: OptionCheckOutcome },
): void {
  try {
    db.prepare('INSERT INTO option_checks (session_id, slug, surface, outcome) VALUES (?, ?, ?, ?)').run(
      row.sessionId,
      row.slug ?? null,
      row.surface,
      row.outcome,
    );
  } catch {
    // An older schema or a busy database: the measurement is lost, nothing else.
  }
}
