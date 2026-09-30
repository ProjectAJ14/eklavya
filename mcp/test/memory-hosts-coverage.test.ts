import { describe, expect, it } from 'vitest';
import { capabilitiesOf } from '../src/memory/hosts.js';

describe('capabilitiesOf', () => {
  it('reads a missing host as Claude Code and names an unknown one by itself', () => {
    expect(capabilitiesOf(undefined)).toBe(capabilitiesOf('claude-code'));
    expect(capabilitiesOf(null).id).toBe('claude-code');
    expect(capabilitiesOf('some-editor')).toMatchObject({ id: 'some-editor', label: 'some-editor', hooks: false, status: 'unverified' });
  });
});
