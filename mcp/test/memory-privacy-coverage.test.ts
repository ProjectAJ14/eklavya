import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIVACY, isOwnTraffic, redact } from '../src/memory/privacy.js';

describe('privacy edges', () => {
  it('skips an unparseable configured pattern and still applies the valid ones', () => {
    const policy = { ...DEFAULT_PRIVACY, redactPatterns: ['([unclosed', 'internal-\\d+'] };
    const out = redact('ticket internal-42 filed', policy);
    expect(out.text).toBe('ticket [redacted:configured] filed');
    expect(out.kinds).toEqual(['configured']);
  });

  it('keeps an ordinary Bash command that only mentions eklavya', () => {
    expect(isOwnTraffic('Bash', 'npm test -- eklavya')).toBe(false);
    expect(isOwnTraffic('Bash', 'eklavya dashboard')).toBe(true);
  });
});
