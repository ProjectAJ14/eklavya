/**
 * Does `log_session_concepts` name the concepts a diff actually exercises?
 *
 * This sits upstream of everything else the eval measures. If extraction picks
 * the wrong concepts, every question after it is well-formed and about the
 * wrong thing -- and `question-checks.ts` would score that run perfectly clean,
 * because a good question about an irrelevant concept is still a good question.
 *
 * Scored with the product's own matcher. `findFuzzyMatch` and
 * `FUZZY_MATCH_THRESHOLD` are what the server uses to decide two slugs mean the
 * same concept, so a model that logs `wal-mode` against a label of
 * `wal-journal-mode` is credited here exactly as the server would credit it.
 * A second opinion invented for the eval would measure the eval.
 *
 * Pure: labels and extractions in, numbers out.
 */
import { findFuzzyMatch, isValidSlug, normalizeSlug } from '../slug.js';

/** What the model produced for one fixture. */
export interface Extracted {
  slug: string;
  context?: string | null;
}

/** The skill asks for 3-8 concepts the work genuinely exercises. */
export const MIN_CONCEPTS = 3;
export const MAX_CONCEPTS = 8;

export interface ExtractionResult {
  fixture: string;
  /** Labelled concepts the model found, by the server's own matching rules. */
  matched: string[];
  /** Labelled concepts it missed. */
  missed: string[];
  /**
   * Concepts it logged that match no label.
   *
   * Deliberately not called "wrong". The labels are one person's reading of the
   * diff, so an unmatched slug is either a false positive or a concept the
   * labeller did not think of -- and only a judge can tell those apart. The
   * harness sends these, and only these, to be judged.
   */
  unlabelled: string[];
  precision: number;
  recall: number;
  f1: number;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

export function scoreExtraction(fixture: string, labels: string[], extracted: Extracted[]): ExtractionResult {
  const candidates = labels.map((slug) => ({ slug }));
  const matched = new Set<string>();
  const unlabelled: string[] = [];

  for (const item of extracted) {
    const slug = normalizeSlug(item.slug);
    // Exact first, then the server's fuzzy rules -- the same order
    // `log_session_concepts` resolves a slug in.
    const hit = labels.includes(slug) ? { slug } : findFuzzyMatch(slug, candidates);
    // A second logged slug matching an already-credited label is not a second
    // hit. Counting it would let a model inflate recall by logging one concept
    // five different ways.
    if (hit && !matched.has(hit.slug)) matched.add(hit.slug);
    else if (!hit) unlabelled.push(slug);
  }

  const precision = ratio(matched.size, extracted.length);
  const recall = ratio(matched.size, labels.length);

  return {
    fixture,
    matched: [...matched],
    missed: labels.filter((l) => !matched.has(l)),
    unlabelled,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

export interface ShapeCheck {
  id: string;
  ok: boolean;
  detail: string;
}

/**
 * What the skill asks for, checked without a model.
 *
 * The count and the context line are instructions with an exact form, so they
 * are countable -- and the context line is the one that decays silently. A
 * concept logged with `"used cookies"` still produces a question, just an
 * ungrounded one, and nothing downstream notices.
 */
export function checkExtractionShape(extracted: Extracted[], diff: string): ShapeCheck[] {
  const checks: ShapeCheck[] = [];
  const n = extracted.length;

  checks.push({
    id: 'count_in_range',
    ok: n >= MIN_CONCEPTS && n <= MAX_CONCEPTS,
    detail: `${n} concept(s) (asked for ${MIN_CONCEPTS}-${MAX_CONCEPTS})`,
  });

  const invalid = extracted.filter((e) => !isValidSlug(normalizeSlug(e.slug)));
  checks.push({
    id: 'slugs_valid',
    ok: invalid.length === 0,
    detail: invalid.length === 0 ? 'all slugs normalize cleanly' : `${invalid.length} unusable slug(s)`,
  });

  const contextless = extracted.filter((e) => !e.context || e.context.trim().length === 0);
  checks.push({
    id: 'every_concept_has_context',
    ok: contextless.length === 0,
    detail: contextless.length === 0 ? 'every concept carries a context line' : `${contextless.length} without context`,
  });

  // "One line naming the actual decision, in the actual file." A context that
  // shares no identifier with the diff is the `"used cookies"` case the skill
  // calls useless -- it reads fine and grounds nothing.
  const identifiers = new Set(
    (diff.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) ?? []).map((w) => w.toLowerCase()),
  );
  const ungrounded = extracted.filter((e) => {
    const words = (e.context ?? '').toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) ?? [];
    return !words.some((w) => identifiers.has(w));
  });
  checks.push({
    id: 'context_names_the_code',
    ok: ungrounded.length === 0,
    detail:
      ungrounded.length === 0
        ? 'every context line names something from the diff'
        : `${ungrounded.length} context line(s) name nothing in the diff`,
  });

  return checks;
}

export interface ExtractionSummary {
  fixtures: number;
  labels: number;
  extracted: number;
  matched: number;
  precision: number;
  recall: number;
  f1: number;
  /** Unmatched slugs, pooled -- the judge decides which are real misses. */
  unlabelled: number;
}

export function summarizeExtraction(results: ExtractionResult[]): ExtractionSummary {
  const matched = results.reduce((n, r) => n + r.matched.length, 0);
  const labels = results.reduce((n, r) => n + r.matched.length + r.missed.length, 0);
  const extracted = results.reduce((n, r) => n + r.matched.length + r.unlabelled.length, 0);
  const precision = ratio(matched, extracted);
  const recall = ratio(matched, labels);

  return {
    fixtures: results.length,
    labels,
    extracted,
    matched,
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    unlabelled: results.reduce((n, r) => n + r.unlabelled.length, 0),
  };
}
