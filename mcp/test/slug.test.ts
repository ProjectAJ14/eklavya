import { describe, it, expect } from 'vitest';
import { normalizeSlug, isValidSlug } from '../src/slug.js';

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
