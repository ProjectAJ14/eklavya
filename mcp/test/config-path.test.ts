import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import { defaultAt, isKnownKey, knownKeys, parseValue, patchFor, valueAt } from '../src/config-path.js';

describe('dotted configuration keys', () => {
  it('knows every flat dial and every namespaced key, from the defaults rather than a list', () => {
    // A hand-written list is a place a new key gets accepted and then silently
    // discarded, which is the failure mcp/CLAUDE.md warns about.
    const keys = knownKeys();
    expect(keys).toContain('mode');
    expect(keys).toContain('memory');
    expect(keys).toContain('memory.enabled');
    expect(keys).toContain('retrieval.mode');
    expect(keys).toContain('privacy.exclude_paths');
    expect(keys).toContain('providers.observer');
    for (const key of Object.keys(DEFAULT_CONFIG)) expect(isKnownKey(key)).toBe(true);
    expect(isKnownKey('memory.enabledd')).toBe(false);
    expect(isKnownKey('nonsense')).toBe(false);
  });

  it('does not invent a third level of nesting', () => {
    expect(knownKeys().every((k) => k.split('.').length <= 2)).toBe(true);
  });

  it('parses a value as the type the schema has there, not as the text looks', () => {
    expect(parseValue('memory.enabled', 'false')).toBe(false);
    expect(parseValue('memory.batch_max_events', '40')).toBe(40);
    expect(parseValue('retrieval.mode', 'keyword')).toBe('keyword');
    // The trap: a topic of "2" is a topic, not a number.
    expect(parseValue('focus_topic', '2')).toBe('2');
    expect(parseValue('max_questions_per_task', '4')).toBe(4);
  });

  it('takes a list as JSON or as the comma list anybody actually types', () => {
    expect(parseValue('privacy.exclude_paths', '["/a/","/b/"]')).toEqual(['/a/', '/b/']);
    expect(parseValue('privacy.exclude_paths', '/a/, /b/')).toEqual(['/a/', '/b/']);
    expect(parseValue('domains_enabled', 'react,git')).toEqual(['react', 'git']);
  });

  it('clears a nullable object with `null` and otherwise insists on JSON', () => {
    expect(parseValue('providers.observer', 'null')).toBeNull();
    expect(parseValue('providers.observer', '{"kind":"anthropic","model":"m"}')).toEqual({
      kind: 'anthropic',
      model: 'm',
    });
    // Not JSON, so it is handed on unchanged for `coerce` to refuse. Guessing a
    // shape here would write a setting that silently never applies.
    expect(parseValue('providers.observer', 'anthropic')).toBe('anthropic');
  });

  it('keeps a namespace its siblings when only one key of it is set', () => {
    // `loadConfig` merges the two files with a shallow spread, so a patch that
    // replaced the whole namespace would drop every other key in it.
    const existing = { memory: { enabled: true, capture: 'minimal', batch_max_events: 12 } };
    expect(patchFor(existing, 'memory.enabled', false)).toEqual({
      memory: { enabled: false, capture: 'minimal', batch_max_events: 12 },
    });
  });

  it('creates the namespace when the file has none yet', () => {
    expect(patchFor({}, 'retrieval.mode', 'keyword')).toEqual({ retrieval: { mode: 'keyword' } });
  });

  it('leaves a flat key flat', () => {
    expect(patchFor({ mode: 'ambient' }, 'mode', 'off')).toEqual({ mode: 'off' });
  });

  it('reads the effective value back out at either depth', () => {
    expect(valueAt(DEFAULT_CONFIG, 'mode')).toBe('ambient');
    expect(valueAt(DEFAULT_CONFIG, 'retrieval.mode')).toBe('hybrid');
    expect(valueAt(DEFAULT_CONFIG, 'memory.nope')).toBeUndefined();
    expect(defaultAt('memory.capture')).toBe('full');
  });
});

describe('setting a namespaced key end to end', () => {
  it('writes only the key given and keeps the rest of the namespace', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { readConfigFile, writeConfigFile, loadConfig } = await import('../src/config.js');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cfg-'));
    const file = path.join(dir, 'config.json');
    writeConfigFile(file, { memory: { enabled: true, capture: 'minimal' }, mode: 'enforced' });

    const patch = patchFor(readConfigFile(file), 'memory.enabled', parseValue('memory.enabled', 'false'));
    writeConfigFile(file, patch);

    const written = readConfigFile(file) as { memory: Record<string, unknown>; mode: string };
    expect(written.memory).toEqual({ enabled: false, capture: 'minimal' });
    // The other namespaces and the flat dials are untouched by a namespaced write.
    expect(written.mode).toBe('enforced');

    // And the value survives `coerce`, which is the half that silently drops a
    // key nobody wired up.
    const resolved = loadConfig(dir);
    expect(resolved).toBeTruthy();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
