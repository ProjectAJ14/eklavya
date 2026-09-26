import { describe, it, expect } from 'vitest';
import { claudeArgs, ProviderError, readResult } from '../src/memory/provider.js';

/** The observer runs as `claude -p`; these pin how its JSON envelope is read. */
describe('the claude -p observer', () => {
  const envelope = (e: Record<string, unknown>) => JSON.stringify({ subtype: 'success', is_error: false, ...e });
  const classOf = (stdout: string) => {
    try {
      readResult(stdout);
    } catch (err) {
      return (err as ProviderError).errorClass;
    }
    return null;
  };

  it('returns the structured output', () => {
    expect(readResult(envelope({ structured_output: { observations: [] } }))).toEqual({ observations: [] });
  });

  it('classifies failures so auth and quota pause the queue instead of retrying', () => {
    expect(classOf('not json')).toBe('malformed');
    expect(classOf(envelope({}))).toBe('malformed');
    expect(classOf(envelope({ is_error: true, result: 'Not logged in · Please run /login' }))).toBe('auth');
    expect(classOf(envelope({ is_error: true, result: 'x', api_error_status: 429 }))).toBe('quota');
    expect(classOf(envelope({ is_error: true, result: 'Claude usage limit reached' }))).toBe('quota');
    expect(classOf(envelope({ is_error: true, result: 'overloaded' }))).toBe('transient');
  });

  it('runs with no tools, no MCP servers and no hooks, so it never records itself', () => {
    const args = claudeArgs('claude-haiku-4-5');
    expect(args).toEqual(expect.arrayContaining(['-p', '--strict-mcp-config', '--no-session-persistence', '--safe-mode']));
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(JSON.parse(args[args.indexOf('--settings') + 1]!)).toEqual({ disableAllHooks: true, apiKeyHelper: null });
  });
});

describe('output past the limits', () => {
  it('is trimmed to them instead of failing the batch', async () => {
    const { trimToLimits } = await import('../src/memory/provider.js');
    const obs = (n: number) => ({
      title: 't'.repeat(250),
      type: 'change',
      narrative: 'n',
      facts: Array.from({ length: 15 }, () => 'f'.repeat(500)),
      files: [],
      tags: Array.from({ length: 14 }, () => 'tag'),
      n,
    });
    const trimmed = trimToLimits({ observations: Array.from({ length: 8 }, (_, i) => obs(i)) }) as {
      observations: { title: string; facts: string[]; tags: string[] }[];
    };
    expect(trimmed.observations).toHaveLength(6);
    expect(trimmed.observations[0]!.facts).toHaveLength(12);
    expect(trimmed.observations[0]!.facts[0]!.length).toBe(400);
    expect(trimmed.observations[0]!.title.length).toBe(200);
    expect(trimmed.observations[0]!.tags).toHaveLength(12);
  });

  it('leaves a wrong shape alone, so validation still rejects it', async () => {
    const { trimToLimits } = await import('../src/memory/provider.js');
    expect(trimToLimits({ nope: 1 })).toEqual({ nope: 1 });
    expect(trimToLimits('text')).toBe('text');
  });
});

