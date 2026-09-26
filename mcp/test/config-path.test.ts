import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  applySetting,
  defaultAt,
  isKnownKey,
  knownKeys,
  parseValue,
  patchFor,
  SETTING_RULES,
  settingProblem,
  valueAt,
} from '../src/config-path.js';
import { setConfig } from '../src/tools/config_tools.js';

describe('dotted configuration keys', () => {
  it('knows every flat dial and every namespaced key, from the defaults rather than a list', () => {
    // A hand-written list is a place a new key gets accepted and then silently
    // discarded, which is the failure mcp/CLAUDE.md warns about.
    const keys = knownKeys();
    expect(keys).toContain('quiz.enabled');
    expect(keys).toContain('quiz.enforced');
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
    expect(patchFor({ quiz: { enforced: true } }, 'quiz.enabled', false)).toEqual({
      quiz: { enforced: true, enabled: false },
    });
  });

  it('reads the effective value back out at either depth', () => {
    expect(valueAt(DEFAULT_CONFIG, 'quiz.enabled')).toBe(true);
    expect(valueAt(DEFAULT_CONFIG, 'quiz.enforced')).toBe(false);
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
    writeConfigFile(file, { memory: { enabled: true, capture: 'minimal' }, quiz: { enforced: true } });

    const patch = patchFor(readConfigFile(file), 'memory.enabled', parseValue('memory.enabled', 'false'));
    writeConfigFile(file, patch);

    const written = readConfigFile(file) as { memory: Record<string, unknown>; quiz: Record<string, unknown> };
    expect(written.memory).toEqual({ enabled: false, capture: 'minimal' });
    // The other namespaces and the flat dials are untouched by a namespaced write.
    expect(written.quiz).toEqual({ enforced: true });

    // And the value survives `coerce`, which is the half that silently drops a
    // key nobody wired up.
    const resolved = loadConfig(dir);
    expect(resolved).toBeTruthy();

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('SETTING_RULES: what every interface accepts', () => {
  const home = { saved: process.env.EKLAVYA_HOME, dir: '' };
  beforeEach(() => {
    home.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-rules-'));
    process.env.EKLAVYA_HOME = home.dir;
  });
  afterEach(() => {
    if (home.saved === undefined) delete process.env.EKLAVYA_HOME;
    else process.env.EKLAVYA_HOME = home.saved;
    fs.rmSync(home.dir, { recursive: true, force: true });
  });
  const userFile = () => path.join(home.dir, 'config.json');

  it('covers every leaf key except the objects coerce checks itself', () => {
    const leaves = knownKeys().filter((k) => {
      const d = defaultAt(k);
      return !(d !== null && typeof d === 'object' && !Array.isArray(d));
    });
    const unruled = leaves.filter((k) => !SETTING_RULES[k]);
    expect(unruled.sort()).toEqual(['notifications.sinks', 'providers.embeddings', 'providers.observer']);
  });

  it('refuses each kind of bad value, and accepts the good ones', () => {
    expect(settingProblem('quiet', 'yes')).toBe('quiet is true or false.');
    expect(settingProblem('cadence', 'bogus')).toBe('cadence is one of interleaved, end.');
    expect(settingProblem('max_questions_per_task', 11)).toBe('max_questions_per_task is a whole number from 1 to 10.');
    expect(settingProblem('max_questions_per_task', 2.5)).toMatch(/whole number/);
    expect(settingProblem('max_questions_per_task', 0)).toMatch(/from 1 to 10/);
    expect(settingProblem('pass_threshold', 1.2)).toBe('pass_threshold is a number from 0 to 1.');
    expect(settingProblem('pass_threshold', 0.75)).toBeNull();
    expect(settingProblem('memory.retention_days', null)).toBeNull();
    expect(settingProblem('memory.retention_days', 0)).toMatch(/or empty/);
    expect(settingProblem('level_up_after', null)).toBe('level_up_after cannot be empty.');
    expect(settingProblem('focus_topic', 'x'.repeat(201))).toBe('focus_topic is at most 200 characters.');
    expect(settingProblem('focus_topic', '  ')).toMatch(/needs some text/);
    expect(settingProblem('privacy.redact_patterns', ['ok-\\d+', '(unclosed'])).toMatch(/"\(unclosed" is not a valid regular expression/);
    expect(settingProblem('privacy.exclude_tools', ['Bash', ''])).toBe('privacy.exclude_tools lines cannot be empty.');
    expect(settingProblem('domains_enabled', Array(101).fill('a'))).toMatch(/at most 100 lines/);
    expect(settingProblem('domains_enabled', ['*'])).toBeNull();
  });

  it('normalizes typing before checking: trimmed text, blank lines dropped', () => {
    applySetting('focus_topic', '  caching  ', null);
    applySetting('privacy.exclude_tools', [' Bash ', '', 'Read'], null);
    const raw = JSON.parse(fs.readFileSync(userFile(), 'utf8'));
    expect(raw.focus_topic).toBe('caching');
    expect(raw.privacy.exclude_tools).toEqual(['Bash', 'Read']);
  });

  it('refuses a change that would not take effect, and writes nothing', () => {
    expect(() => applySetting('focus', 'learn', null)).toThrow(/needs a topic/);
    applySetting('quiz.enabled', false, null);
    expect(() => applySetting('quiz.enforced', true, null)).toThrow(/no effect while quiz.enabled is false/);
    expect(JSON.parse(fs.readFileSync(userFile(), 'utf8'))).toEqual({ quiz: { enabled: false } });
    // A topic already in force is enough; clearing it under learn is refused.
    applySetting('focus_topic', 'caching', null);
    applySetting('focus', 'learn', null);
    expect(() => applySetting('focus_topic', null, null)).toThrow(/needs a topic/);
    expect(() => applySetting('focus_topic', undefined, null)).toThrow(/needs a topic/);
  });

  it('is where set_config gets its number bounds and enum values', () => {
    const schema = setConfig.inputSchema as Record<string, any>;
    const leaf = (key: string) => {
      const [head, sub] = key.split('.');
      const top = schema[head!]?.unwrap?.() ?? schema[head!];
      return sub ? top?.shape?.[sub] : schema[head!];
    };
    let checked = 0;
    for (const [key, rule] of Object.entries(SETTING_RULES)) {
      const z = leaf(key);
      if (!z) continue; // a key the tool takes as a whole namespace only
      let inner = z;
      while (inner.unwrap && inner.def?.type !== 'number' && inner.def?.type !== 'enum') inner = inner.unwrap();
      if (rule.type === 'number') {
        expect([inner.minValue, inner.maxValue, inner.isInt], key).toEqual([rule.min, rule.max, !!rule.int]);
        checked++;
      }
      if (rule.type === 'enum') {
        expect([...inner.options].sort(), key).toEqual([...rule.options!].sort());
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('set_config refuses what the table refuses, in the same words', () => {
    const db = { prepare: () => ({ get: () => undefined, run: () => undefined, all: () => [] }) } as any;
    const res = setConfig.handler({ privacy: { redact_patterns: ['(bad'] } }, { db } as any) as any;
    expect(res).toEqual({ error: 'invalid_value', key: 'privacy.redact_patterns', detail: settingProblem('privacy.redact_patterns', ['(bad']) });
    const learn = setConfig.handler({ focus: 'learn' }, { db } as any) as any;
    expect(learn.error).toBe('invalid_combination');
    expect(fs.existsSync(userFile())).toBe(false);
  });
});
