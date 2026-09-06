/**
 * Concept slugs are the join key across the whole system, and the LLM is allowed
 * to mint new ones. Normalizing hard here is what keeps slug
 * sprawl from turning the graph into mush.
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
 * Tokens that end in `s` without being plural, so a naive strip would mangle
 * them into something that could collide with a real concept.
 *
 * `https` is the one that matters: singularising it yields `http`, which would
 * merge `https-basics` into `http-basics` -- two different ideas, and exactly
 * the false merge the qualifier strip is careful to avoid elsewhere.
 */
const NOT_PLURAL = new Set([
  // Acronyms and mass nouns four characters or longer. Anything shorter is
  // already covered by the length guard in `singular()`, so listing `js` or
  // `dns` here would be decoration.
  'https',
  'cors',
  'nats',
  // Not an acronym, but the false merge with the likeliest cost: `windows` is
  // the operating system far more often than it is a plural of `window`, and
  // this repo has hook behaviour that differs by platform.
  'windows',
  'news',
  'bias',
]);

/**
 * A token with its English plural removed, when that is safe.
 *
 * The narrowest possible stemmer, and only used for the equality check below.
 * The guards are what keep it from doing damage: `class` and `process` end in
 * `ss`, `status` in `us`, `axis` in `is`, and anything shorter than four
 * characters is more likely an acronym than a plural.
 */
function singular(token: string): string {
  if (token.length < 4 || NOT_PLURAL.has(token)) return token;
  if (/(?:ss|us|is)$/.test(token)) return token;
  if (token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  // Only the trailing `s`, deliberately. An `-es` rule for `boxes` -> `box`
  // also turns `caches` into `cach`, which never equals `cache` -- and in this
  // domain `cache-invalidation` is a concept that will really be logged both
  // ways, while `box` is not. Since both sides of the comparison get the same
  // treatment, dropping the rule trades a false negative on `boxes` for a
  // working match on the word that matters.
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

/** The same slug with every token singularised, for the equality check below. */
function singularize(slug: string): string {
  return slug.split('-').filter(Boolean).map(singular).join('-');
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

  // Plural-insensitive equality, as a second *exact* test rather than a change
  // to the score below. `claude-code-hook-lifecycle` and
  // `claude-code-hooks-lifecycle` are one concept split by a letter, and they
  // score 0.60 -- so the graph on a real machine carried both, alongside
  // `forward-only-migrations` and `forward-only-sql-migrations`. Lowering the
  // threshold to catch them would also merge `refresh-token` into
  // `refresh-token-rotation`, which the comment above is explicitly about, so
  // this only fires when the two slugs are otherwise identical.
  const singularized = singularize(stripped);
  const samePlural = candidates.find((c) => singularize(stripQualifiers(c.slug)) === singularized);
  if (samePlural) return samePlural;

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
