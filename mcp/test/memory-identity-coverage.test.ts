import { describe, expect, it } from 'vitest';
import { entryUid, identityFor } from '../src/memory/identity.js';

describe('identity defaults', () => {
  it('reads the process cwd when none is given', () => {
    const here = identityFor({ sessionId: 's' });
    expect(here).toEqual(identityFor({ cwd: process.cwd(), sessionId: 's' }));
    expect(here.host).toBe('claude-code');
  });

  it('treats a missing salt as an empty one', () => {
    const parts = { project: 'p', title: 't', occurredAt: '2025-10-04T00:00:00Z' };
    expect(entryUid(parts)).toBe(entryUid({ ...parts, salt: '' }));
    expect(entryUid(parts)).not.toBe(entryUid({ ...parts, salt: 'x' }));
  });
});
