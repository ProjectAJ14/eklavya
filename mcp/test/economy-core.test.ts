import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { basename, shellEditTargets, shellTokens } from '../src/economy/shell-edits.js';
import { TurnState, commandTemplate, emptyTurn, failureSignature, isErrorText } from '../src/economy/signals.js';
import { effectiveTokens, priceByModel, weightsFor } from '../src/economy/pricing.js';
import {
  DEFAULT_THRESHOLDS,
  decide,
  envelopeOf,
  gateOpen,
  isStuck,
  parseVerdict,
  percentile,
  redirectText,
  thresholdsFor,
} from '../src/economy/loopguard.js';
import {
  addUsage,
  findTranscript,
  isEklavyaTool,
  isPrompt,
  projectFolder,
  projectsDir,
  readTranscript,
  safeSessionId,
  subagentFiles,
  totalTokens,
  usageOf,
  zeroUsage,
} from '../src/economy/transcript.js';

describe('shell edits', () => {
  it('reads in-place editors, redirects into source, tee and patches', () => {
    expect(shellEditTargets("sed -i 's/a/b/' src/app.ts lib/b.py")).toEqual(['app.ts', 'b.py']);
    expect(shellEditTargets("sed -e 's/a/b/' -i src/x.ts")).toEqual(['x.ts']);
    expect(shellEditTargets("sed -i -e 's/a/b/' src/x.ts")).toEqual(['x.ts']);
    expect(shellEditTargets("sed 's/a/b/' src/x.ts")).toEqual([]);
    expect(shellEditTargets("perl -pi -e 's/a/b/' x.rb")).toEqual(['x.rb']);
    expect(shellEditTargets('echo hi > src/a.ts && echo log >> out.log 2> err.txt')).toEqual(['a.ts']);
    expect(shellEditTargets('cmd | tee -a src/b.yaml run.txt')).toEqual(['b.yaml']);
    expect(shellEditTargets('git apply fix.diff')).toEqual(['(patch)']);
    expect(shellEditTargets('patch -p1 < fix.diff')).toEqual(['(patch)']);
    expect(shellEditTargets('git checkout -- src/a.ts src/b.ts')).toEqual(['a.ts', 'b.ts']);
    expect(shellEditTargets('git restore src/c.ts')).toEqual(['c.ts']);
    expect(shellEditTargets('git checkout main')).toEqual([]);
    expect(shellEditTargets('sudo FOO=1 sed -i s/a/b/ /tmp/scratch.ts x.go')).toEqual(['x.go']);
    expect(shellEditTargets('env')).toEqual([]);
    expect(shellEditTargets("echo '>' 'x.ts'")).toEqual([]);
  });

  it('reads apply_patch bodies and inline Python writes', () => {
    expect(shellEditTargets("apply_patch <<'PATCH'\n*** Update File: src/a.ts\n*** Add File: b.ts\nPATCH")).toEqual(['a.ts', 'b.ts']);
    expect(shellEditTargets('apply_patch')).toEqual(['(patch)']);
    expect(shellEditTargets(`python3 -c "open('src/a.py','w').write('x')"`)).toEqual(['a.py']);
    expect(shellEditTargets(`python - <<'EOF'\np='src/b.py'\nopen(p,'w').write(s)\nEOF`)).toEqual(['b.py']);
    expect(shellEditTargets(`python - <<'EOF'\nfrom pathlib import Path\nPath('c.py').write_text('x')\nq = Path('d.py')\nq.write_text('y')\nEOF`)).toEqual(['c.py', 'd.py']);
    expect(shellEditTargets(`python - <<'EOF'\nfor f in ['e.py', 'g.py']:\n    open(f, 'a').write('x')\nEOF`)).toEqual(['e.py', 'g.py']);
    expect(shellEditTargets(`python -c "open(path, 'w')"`)).toEqual(['(script)']);
    expect(shellEditTargets(`python -c "open('r.py','r').read()"`)).toEqual([]);
    expect(shellEditTargets(`python - <<EOF\nopen('unclosed.py','w')`)).toEqual(['unclosed.py']);
  });

  it('survives an unbalanced quote on one line, and ignores non-commands', () => {
    expect(shellEditTargets("echo 'oops\nsed -i s/a/b/ ok.ts")).toEqual(['ok.ts']);
    expect(() => shellTokens("echo 'x")).toThrow();
    expect(shellTokens('a&&b ; c')).toEqual(['a', '&&', 'b', ';', 'c']);
    expect(shellEditTargets(42)).toEqual([]);
    expect(shellEditTargets('   ')).toEqual([]);
    expect(shellEditTargets('> x.ts')).toEqual(['x.ts']);
    expect(shellEditTargets('echo >')).toEqual([]);
    expect(basename('a/b/')).toBe('b');
  });
});

describe('turn signals', () => {
  it('recognises errors across ecosystems, and Go failures case-sensitively', () => {
    expect(isErrorText('TypeError: x')).toBe(true);
    expect(isErrorText('# fail 2')).toBe(true);
    expect(isErrorText('--- FAIL: TestX')).toBe(true);
    expect(isErrorText('all good')).toBe(false);
    expect(failureSignature('ok\nAssertionError at /a/b.py:12')).toBe(failureSignature('AssertionError at /c/d.py:99'));
    expect(failureSignature('')).toBeNull();
    expect(failureSignature('fine')).toBeNull();
  });

  it('folds edits, shell edits, tests, repeated failures and the verdict', () => {
    const t = new TurnState();
    expect(t.verdict).toBe('unknown');
    t.update('Edit', { file_path: '/r/src/a.ts' }, '', false);
    t.update('Edit', {}, '', false);
    t.update('Bash', { command: "sed -i 's/x/y/' src/b.ts" }, '', false);
    expect(t.verdict).toBe('unknown');
    t.update('Bash', { command: 'npm test -- --grep "x 12"' }, 'AssertionError: expected 1', null);
    t.update('Bash', { command: 'npm test' }, 'AssertionError: expected 2', null);
    expect(t.verdict).toBe('red');
    expect(t.d.repeatedFailSigs).toBe(1);
    expect(t.stagnation).toBe(0.5);
    t.update('Read', {}, 'assert x', null);
    t.update('Read', {}, 'Error reading', true);
    t.update('Bash', { command: 'ls nope' }, '', true);
    t.update('Bash', { command: 'npm test' }, 'ok', false);
    expect(t.verdict).toBe('green');
    t.update('', {}, '', false);
    expect(t.snapshot()).toMatchObject({ calls: 10, edit_churn: 1, distinct_edit_files: 2, test_runs: 3, error_outputs: 4 });
    expect(t.digest(null)).toContain('$ npm test -- --grep "…"');
    expect(t.digest(8)).toContain('= 1.3x that');
    for (let i = 0; i < 40; i++) t.update('Glob', {}, '', false);
    expect(t.d.recent).toHaveLength(40);
    expect(new TurnState().stagnation).toBe(0);
    expect(new TurnState(emptyTurn()).editChurn).toBe(0);
    expect(commandTemplate("grep -n 'secret' file 42")).toBe("grep -n '…' file N");
  });
});

describe('pricing', () => {
  const u = { input: 100, cacheRead: 1000, cacheWrite5m: 40, cacheWrite1h: 10, output: 20 };
  it('prices each part by its ratio, with separate cache-write rates', () => {
    const w = weightsFor('claude-sonnet-4-5-20250929')!;
    expect(effectiveTokens(u, w)).toBe(100 + 100 + 50 + 20 + 100);
    expect(weightsFor('anthropic/claude-haiku-4-5')).toEqual(w);
    expect(weightsFor('claude-3-5-sonnet-20241022')).toEqual(w);
    expect(weightsFor('gpt-5')).toBeNull();
  });

  it('reports a model with no price as unpriced and skips one with no tokens', () => {
    expect(priceByModel({ 'claude-opus-4-6': u, 'gpt-5': u, '<synthetic>': zeroUsage() })).toEqual({ effective: 370, unpriced: ['gpt-5'] });
  });
});

describe('loop guard rules', () => {
  const snap = (over: Partial<ReturnType<TurnState['snapshot']>> = {}) => ({
    calls: 30, edit_churn: 5, distinct_edit_files: 1, error_outputs: 7, test_runs: 4, stagnation: 0.5, repeated_fail_sigs: 3, ...over,
  });
  const t = DEFAULT_THRESHOLDS;

  it('levels and pins overlay the defaults', () => {
    expect(thresholdsFor('aggressive').min_calls).toBe(14);
    expect(thresholdsFor('default', { judge_confidence: 0.9 }).judge_confidence).toBe(0.9);
  });

  it('opens the gate and judges stuck by the strict rule', () => {
    expect(gateOpen(snap({ calls: 5 }), t)).toBe(false);
    expect(gateOpen(snap({ repeated_fail_sigs: 0, error_outputs: 9 }), t)).toBe(true);
    expect(gateOpen(snap({ repeated_fail_sigs: 0, error_outputs: 1 }), t)).toBe(false);
    expect(isStuck(snap({ calls: 3 }), t)).toBe(false);
    expect(isStuck(snap(), t)).toBe(true);
    expect(isStuck(snap({ edit_churn: 1, distinct_edit_files: 4 }), t)).toBe(true);
    expect(isStuck(snap({ edit_churn: 1 }), t)).toBe(false);
  });

  it('computes percentiles and the envelope', () => {
    expect(percentile([], 90)).toBeNull();
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10, 20], 90)).toBe(19);
    expect(envelopeOf([10, 10, 10, 10], t)).toBeNull();
    expect(envelopeOf([10, 10, 10, 10, 10], t)).toBe(12.5);
  });

  it('decides with and without a judge, with the backstop first', () => {
    const none = { configured: false, verdict: undefined };
    expect(decide(snap({ calls: 40 }), t, 10, none).act).toBe('redirect');
    expect(decide(snap({ calls: 20 }), t, 10, none)).toMatchObject({ act: 'redirect', reason: expect.stringContaining('envelope') });
    expect(decide(snap({ calls: 20 }), t, 30, none).reason).toBe('stuck but within the envelope');
    expect(decide(snap({ calls: 20 }), t, null, none).reason).toBe('stuck but within the envelope');
    expect(decide(snap({ stagnation: 0 }), t, 10, none).reason).toBe('not stuck');
    const j = (verdict: unknown) => ({ configured: true, verdict: verdict as never });
    expect(decide(snap({ calls: 20 }), t, 100, j({ stuck: true, confidence: 0.8 })).act).toBe('redirect');
    expect(decide(snap({ calls: 20 }), t, 100, j({ stuck: true, confidence: 0.5 })).reason).toBe('judge: unsure');
    expect(decide(snap({ calls: 20 }), t, 100, j({ stuck: false, confidence: 0.9 })).reason).toBe('judge: productive');
    expect(decide(snap({ calls: 20 }), t, 100, j(null)).reason).toBe('judge pending');
    expect(decide(snap({ calls: 20 }), t, 100, j(undefined)).act).toBe('ask_judge');
    expect(decide(snap({ calls: 10 }), t, null, j(undefined)).act).toBe('none');
    expect(decide(snap({ calls: 10 }), t, 8, j(undefined)).act).toBe('ask_judge');
  });

  it('writes a redirect from the turn\'s own actions, and parses verdicts', () => {
    const s = new TurnState();
    expect(redirectText(s)).toContain('most to `one file`');
    s.update('Edit', { file_path: 'b.ts' }, '', false);
    s.update('Edit', { file_path: 'a.ts' }, '', false);
    expect(redirectText(s)).toContain('2 edit(s) across 2 file(s) (most to `a.ts`)');
    expect(parseVerdict(null)).toBeNull();
    expect(parseVerdict({ stuck: 'yes', confidence: 1 })).toBeNull();
    expect(parseVerdict({ stuck: true })).toBeNull();
    expect(parseVerdict({ stuck: null, confidence: 3 })).toEqual({ stuck: null, confidence: 1 });
    expect(parseVerdict({ stuck: true, confidence: -1, reason: 'r', redirect: ' try x ' })).toEqual({ stuck: true, confidence: 0, reason: 'r', redirect: ' try x ' });
    expect(parseVerdict({ stuck: false, confidence: 0.5, redirect: '  ' })).toEqual({ stuck: false, confidence: 0.5 });
  });
});

describe('transcript reader', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-transcript-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const line = (o: unknown) => JSON.stringify(o);
  const usage = (input: number, extra: Record<string, unknown> = {}) => ({ input_tokens: input, output_tokens: 10, cache_read_input_tokens: 100, ...extra });

  it('reads usage once per message, splits cache writes and attributes subagents', () => {
    const file = path.join(dir, 's1.jsonl');
    fs.writeFileSync(
      file,
      [
        line({ type: 'user', sessionId: 's1', cwd: '/r', version: '2.1.300', timestamp: '2026-11-01T10:00:00Z', message: { content: 'fix the bug' } }),
        line({ type: 'user', isMeta: true, message: { content: 'meta' } }),
        line({ type: 'user', message: { content: [{ type: 'text', text: '<local-command-stdout>x' }] } }),
        line({ type: 'user', message: { content: [{ type: 'text', text: 'second prompt' }, 'junk'] } }),
        // Notices the host sends on its own are not prompts.
        line({ type: 'user', message: { content: '<task-notification>\n<task-id>a1</task-id>\n</task-notification>' } }),
        line({ type: 'user', message: { content: [{ type: 'text', text: '<agent-message from="builder">done</agent-message>' }] } }),
        // One message written as two blocks: counted once, last counts win.
        line({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-4-5', usage: usage(5), content: [{ type: 'text', text: 'hi' }] } }),
        line({ type: 'assistant', message: { id: 'm1', model: 'claude-sonnet-4-5', usage: usage(7, { cache_creation_input_tokens: 50, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 } }), content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } }),
        line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'no' }] } }),
        line({ type: 'assistant', message: { id: 'm2', model: 'claude-sonnet-4-5', usage: usage(3, { cache_creation_input_tokens: 9 }), content: [{ type: 'tool_use', id: 't2', name: 'mcp__plugin_eklavya_eklavya__record_attempt', input: {} }] } }),
        line({ type: 'assistant', message: { id: 'm3', model: 'claude-haiku-4-5', usage: usage(1), content: [{ type: 'tool_use', id: 't3', name: 'Agent', input: { subagent_type: 'eklavya:eklavya-explainer' } }, { type: 'tool_use', id: 't4', name: 'Task', input: {} }, null] } }),
        line({ type: 'user', toolUseResult: { agentId: 'abc' }, message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'done' }] } }),
        line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'again' }] } }),
        line({ type: 'assistant', message: { usage: usage(2), content: [] } }),
        line({ type: 'assistant', message: { usage: 'bad', content: 'x' } }),
        line({ attachment: { type: 'deferred_tools_delta', addedNames: ['WebFetch', 'X', 3], removedNames: ['X', 4] } }),
        line({ attachment: { type: 'other' } }),
        line([1]),
        'not json',
        line({ type: 'assistant', timestamp: '2026-11-01T11:00:00Z', message: { id: 'm4', model: '', usage: usage(1), content: [] } }),
      ].join('\n'),
    );
    fs.mkdirSync(path.join(dir, 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 's1', 'subagents', 'agent-abc.jsonl'),
      line({ type: 'assistant', message: { id: 'sa1', model: 'claude-haiku-4-5', usage: usage(4), content: [{ type: 'tool_use', id: 'x', name: 'Write', input: {} }] } }),
    );
    fs.writeFileSync(
      path.join(dir, 's1', 'subagents', 'agent-zzz.jsonl'),
      [
        line({ type: 'assistant', message: { id: 'sb1', model: 'claude-haiku-4-5', usage: usage(6), content: [{ type: 'tool_use', id: 'y', name: 'Bash', input: {} }] } }),
        line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'y', is_error: true }] } }),
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 's1', 'subagents', 'notes.txt'), 'x');

    const r = readTranscript(file);
    expect(r).toMatchObject({ sessionId: 's1', cwd: '/r', version: '2.1.300', startedAt: '2026-11-01T10:00:00Z', endedAt: '2026-11-01T11:00:00Z', prompts: 2, files: 3, toolErrors: 2 });
    expect(r.requests).toBe(7);
    expect(r.byModel['claude-sonnet-4-5']).toEqual({ input: 10, cacheRead: 200, cacheWrite5m: 29, cacheWrite1h: 30, output: 20 });
    expect(r.eklavya.usage.input).toBe(3);
    expect(r.subagents['eklavya:eklavya-explainer']!.usage.input).toBe(4);
    expect(r.subagents.unknown!.usage.input).toBe(6);
    expect(r.tools).toMatchObject({ Bash: 2, Agent: 1, Task: 1, Write: 1 });
    expect(r.deferredTools).toEqual(['WebFetch']);
    expect(r.model).toBe('claude-haiku-4-5');
    expect(r.byModel.unknown!.input).toBe(3);
  });

  it('reads a missing file as an empty session, and helpers behave', () => {
    const r = readTranscript(path.join(dir, 'missing.jsonl'));
    expect(r).toMatchObject({ requests: 0, files: 0, model: null, sessionId: null });
    expect(subagentFiles(path.join(dir, 'missing.jsonl'))).toEqual([]);
    expect(usageOf(null)).toBeNull();
    expect(usageOf({ input_tokens: -3, output_tokens: 2.7, cache_creation_input_tokens: 5 })).toEqual({ input: 0, cacheRead: 0, cacheWrite5m: 5, cacheWrite1h: 0, output: 2 });
    expect(totalTokens(addUsage(zeroUsage(), { input: 1, cacheRead: 2, cacheWrite5m: 3, cacheWrite1h: 4, output: 5 }))).toBe(15);
    expect(isEklavyaTool('mcp__eklavya__memory_get')).toBe(true);
    expect(isEklavyaTool('mcp__other__x')).toBe(false);
    expect(isPrompt({ type: 'user', message: { content: [{ type: 'tool_result' }] } })).toBe(false);
    expect(isPrompt({ type: 'user', message: { content: '[Request interrupted by user]' } })).toBe(false);
    expect(isPrompt({ type: 'user', message: { content: 3 } })).toBe(false);
    expect(isPrompt({ type: 'user', message: { content: [{ type: 'text' }] } })).toBe(true);
    expect(isPrompt({ type: 'user' })).toBe(false);
    expect(projectsDir({ CLAUDE_CONFIG_DIR: '/c' }, '/h')).toBe(path.join('/c', 'projects'));
    expect(projectsDir({}, '/h')).toBe(path.join('/h', '.claude', 'projects'));
    expect(projectFolder('/home/u/widget')).toBe('-home-u-widget');
    expect(safeSessionId('ab-1')).toBe(true);
    expect(safeSessionId('../x')).toBe(false);
  });

  it('finds a transcript under the checkout folder or any folder', () => {
    const projects = path.join(dir, 'projects');
    fs.mkdirSync(path.join(projects, '-r'), { recursive: true });
    fs.mkdirSync(path.join(projects, 'other'), { recursive: true });
    fs.writeFileSync(path.join(projects, '-r', 'a.jsonl'), '');
    fs.writeFileSync(path.join(projects, 'other', 'b.jsonl'), '');
    expect(findTranscript(projects, 'a', '/r')).toBe(path.join(projects, '-r', 'a.jsonl'));
    expect(findTranscript(projects, 'b', '/r')).toBe(path.join(projects, 'other', 'b.jsonl'));
    expect(findTranscript(projects, 'b')).toBe(path.join(projects, 'other', 'b.jsonl'));
    expect(findTranscript(projects, 'c')).toBeNull();
    expect(findTranscript(projects, '../x')).toBeNull();
    expect(findTranscript(path.join(dir, 'none'), 'a')).toBeNull();
  });

  it('skips an over-long line', () => {
    const file = path.join(dir, 'long.jsonl');
    fs.writeFileSync(file, `${'x'.repeat(8 << 20)}\n${line({ type: 'assistant', message: { id: 'm', model: 'claude-opus-4-6', usage: usage(1), content: [] } })}`);
    expect(readTranscript(file).requests).toBe(1);
  });
});
