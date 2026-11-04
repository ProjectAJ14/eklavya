import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readCalls, readTranscript } from '../src/economy/transcript.js';

// Real Claude Code sessions on the oldest and newest supported versions,
// scrubbed by eval/scrub-transcript.mjs. `expected.json` holds the session's
// own `modelUsage` totals from `claude -p --output-format json`, which count
// subagents too (the envelope's top-level `usage` does not).
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'transcripts');
const fixtures = fs.readdirSync(root).sort();

interface Expected {
  claudeCode: string;
  scenario: 'stuck' | 'long' | 'subagents' | 'quiz';
  models: string[];
  modelUsage: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

describe('recorded transcripts', () => {
  it('covers four scenarios on both supported versions', () => {
    const seen = fixtures.map((n) => {
      const e = JSON.parse(fs.readFileSync(path.join(root, n, 'expected.json'), 'utf8')) as Expected;
      return `${e.claudeCode} ${e.scenario}`;
    });
    expect(seen.sort()).toEqual(
      ['2.1.283', '2.1.318'].flatMap((v) => ['long', 'quiz', 'stuck', 'subagents'].map((s) => `${v} ${s}`)).sort(),
    );
  });

  it.each(fixtures)('%s: usage equals Claude Code’s own totals', (name) => {
    const dir = path.join(root, name);
    const e = JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')) as Expected;
    const r = readTranscript(path.join(dir, 'session.jsonl'));

    expect(r.version).toBe(e.claudeCode);
    expect(Object.keys(r.byModel).sort()).toEqual([...e.models].sort());
    expect({
      input: r.usage.input,
      cacheRead: r.usage.cacheRead,
      cacheWrite: r.usage.cacheWrite5m + r.usage.cacheWrite1h,
      output: r.usage.output,
    }).toEqual(e.modelUsage);
    expect(r.deferredTools).toContain('WebFetch');

    if (e.scenario === 'stuck') {
      const calls = readCalls(path.join(dir, 'session.jsonl'));
      expect(calls.filter((c) => c.failed).map((c) => c.input)).toEqual(['ls ./missing-dir']);
      // The model piped the test run through `tail`, so the failures show only in the output.
      const runs = calls.filter((c) => c.input.startsWith('python3 -m unittest'));
      expect(runs).toHaveLength(8);
      for (const run of runs) expect(run.output).toMatch(/FAILED \(failures=1\)/);
    }
    if (e.scenario === 'subagents') {
      expect(r.files).toBe(3);
      expect(Object.keys(r.subagents)).toEqual(['general-purpose']);
      expect(r.tools.Agent).toBe(2);
    }
    if (e.scenario === 'quiz') {
      expect(r.tools['mcp__eklavya__get_session_quiz_plan']).toBeGreaterThan(0);
      expect(r.eklavya.usage.output).toBeGreaterThan(0);
      expect(r.eklavya.usage.output).toBeLessThan(r.usage.output);
    }
    if (e.scenario === 'long') expect(r.tools.Bash).toBeGreaterThanOrEqual(3);
  });
});
