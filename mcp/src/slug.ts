/**
 * Concept slugs are the join key across the whole system, and the LLM is allowed
 * to mint new ones (PRD §8 tool 6). Normalizing hard here is what keeps slug
 * sprawl from turning the graph into mush (PRD §15).
 */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80);
}

export function isValidSlug(slug: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 80;
}

/**
 * Token-set similarity between two slugs.
 */
export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(a.split('-').filter(Boolean));
  const tb = new Set(b.split('-').filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;

  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection += 1;
  const union = ta.size + tb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Words that add no meaning to a concept name. Stripping these is what lets
 * `jwt-structure-basics` find `jwt-structure` without also merging
 * `refresh-token-rotation` into `refresh-token` — both pairs look identical to a
 * similarity score, but only one of them is the same idea twice.
 */
const QUALIFIER_TOKENS = new Set([
  'basic', 'basics', 'fundamental', 'fundamentals', 'intro', 'introduction',
  'overview', 'explained', 'explainer', 'concept', 'concepts', 'general',
  'generic', 'guide', 'tutorial', 'usage', 'primer', '101',
  'strategy', 'strategies', 'approach', 'approaches',
]);

export function stripQualifiers(slug: string): string {
  const tokens = slug.split('-').filter(Boolean);
  while (tokens.length > 1 && QUALIFIER_TOKENS.has(tokens[tokens.length - 1]!)) tokens.pop();
  while (tokens.length > 1 && QUALIFIER_TOKENS.has(tokens[0]!)) tokens.shift();
  return tokens.join('-');
}

/**
 * Deliberately strict: 1.0 only catches a pure token reordering
 * (`structure-jwt` ~ `jwt-structure`). Everything else has to survive the
 * qualifier strip above. A test asserts no two shipped seed concepts match.
 */
export const FUZZY_MATCH_THRESHOLD = 0.8;

export function findFuzzyMatch<T extends { slug: string }>(
  slug: string,
  candidates: T[],
  threshold = FUZZY_MATCH_THRESHOLD,
): T | undefined {
  const stripped = stripQualifiers(slug);

  const sameOnceQualifiersGo = candidates.find((c) => stripQualifiers(c.slug) === stripped);
  if (sameOnceQualifiersGo) return sameOnceQualifiersGo;

  let best: T | undefined;
  let bestScore = 0;
  for (const candidate of candidates) {
    const score = tokenJaccard(stripped, stripQualifiers(candidate.slug));
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore >= threshold ? best : undefined;
}
