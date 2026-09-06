import { describe, it, expect } from 'vitest';
import { normalizeSlug, isValidSlug, findFuzzyMatch, stripQualifiers } from '../src/slug.js';
import { loadSeedGraphs } from '../src/seed.js';

describe('normalizeSlug', () => {
  it('kebab-cases arbitrary input', () => {
    expect(normalizeSlug('HttpOnly Cookies')).toBe('httponly-cookies');
    expect(normalizeSlug('JWT  structure!!')).toBe('jwt-structure');
    expect(normalizeSlug('  --refresh_token--  ')).toBe('refresh-token');
  });

  it('collapses separators rather than leaving empty segments', () => {
    expect(normalizeSlug('a///b')).toBe('a-b');
    expect(normalizeSlug('a - - b')).toBe('a-b');
  });

  it('caps length so an LLM cannot mint an essay as a slug', () => {
    expect(normalizeSlug('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });
});

describe('isValidSlug', () => {
  it('accepts normalized slugs', () => {
    expect(isValidSlug('jwt-structure')).toBe(true);
    expect(isValidSlug('csrf')).toBe(true);
  });

  it('rejects anything that would fragment the graph', () => {
    expect(isValidSlug('JWT-Structure')).toBe(false);
    expect(isValidSlug('jwt structure')).toBe(false);
    expect(isValidSlug('-jwt')).toBe(false);
    expect(isValidSlug('jwt--structure')).toBe(false);
    expect(isValidSlug('')).toBe(false);
  });

  it('round-trips: normalizing always yields a valid slug', () => {
    for (const input of ['Hello World', 'a_b_c', '  spaced  out  ', 'Ünïcode Näme']) {
      expect(isValidSlug(normalizeSlug(input))).toBe(true);
    }
  });
});

describe('fuzzy matching', () => {
  it('folds a meaningless qualifier onto the concept it qualifies', () => {
    const candidates = [{ slug: 'jwt-structure' }, { slug: 'refresh-token-rotation' }];
    expect(findFuzzyMatch('jwt-structure-basics', candidates)?.slug).toBe('jwt-structure');
    expect(findFuzzyMatch('intro-jwt-structure', candidates)?.slug).toBe('jwt-structure');
  });

  it('matches a pure token reordering', () => {
    expect(findFuzzyMatch('structure-jwt', [{ slug: 'jwt-structure' }])?.slug).toBe('jwt-structure');
  });

  it('refuses to merge concepts whose extra token carries meaning', () => {
    expect(findFuzzyMatch('refresh-token-rotation', [{ slug: 'refresh-token' }])).toBeUndefined();
    expect(findFuzzyMatch('middleware-order-auth', [{ slug: 'auth-middleware' }])).toBeUndefined();
    expect(findFuzzyMatch('react-useeffect-deps', [{ slug: 'react-useeffect-cleanup' }])).toBeUndefined();
  });

  it('returns nothing when there is no near match', () => {
    expect(findFuzzyMatch('websocket-heartbeats', [{ slug: 'jwt-structure' }])).toBeUndefined();
  });

  it('no two shipped seed concepts match each other', () => {
    const slugs = loadSeedGraphs().flatMap((g) => g.concepts.map((c) => c.slug));
    const collisions: string[] = [];
    for (let i = 0; i < slugs.length; i += 1) {
      const others = slugs.filter((_, j) => j !== i).map((slug) => ({ slug }));
      const match = findFuzzyMatch(slugs[i]!, others);
      if (match) collisions.push(`${slugs[i]} ~ ${match.slug}`);
    }
    expect(collisions).toEqual([]);
  });
});

describe('plurals are not a second concept', () => {
  const match = (slug: string, candidates: string[]) =>
    findFuzzyMatch(slug, candidates.map((c) => ({ slug: c })))?.slug;

  it('merges a slug differing only by a plural', () => {
    // Found in a real graph: both of these existed side by side, one concept
    // split by a letter. They score 0.60, so no threshold catches them without
    // also merging things that must stay apart.
    expect(match('claude-code-hooks-lifecycle', ['claude-code-hook-lifecycle'])).toBe(
      'claude-code-hook-lifecycle',
    );
    expect(match('forward-only-sql-migrations', ['forward-only-sql-migration'])).toBe(
      'forward-only-sql-migration',
    );
    expect(match('react-effect-cleanups', ['react-effect-cleanup'])).toBe('react-effect-cleanup');
  });

  it('still refuses the pair the threshold exists to keep apart', () => {
    // slug.ts's own comment names this one: a qualifier is not a plural, and
    // rotation is a different idea from the token itself.
    expect(match('refresh-token', ['refresh-token-rotation'])).toBeUndefined();
    expect(match('refresh-token-rotation', ['refresh-token'])).toBeUndefined();
  });

  it('does not mangle a word that merely ends in s', () => {
    // Singularising `https` yields `http`, which would merge two real and
    // different concepts. Same shape for class/process/status/axis.
    expect(match('https-basics', ['http-basics'])).toBeUndefined();
    expect(match('class-fields', ['clas-fields'])).toBeUndefined();
    expect(match('process-isolation', ['proces-isolation'])).toBeUndefined();
    expect(match('status-codes', ['statu-codes'])).toBeUndefined();
  });

  it('leaves short tokens alone, since they are acronyms more often than plurals', () => {
    expect(match('cors-preflight', ['cor-preflight'])).toBeUndefined();
    expect(match('dns-resolution', ['dn-resolution'])).toBeUndefined();
  });
});
