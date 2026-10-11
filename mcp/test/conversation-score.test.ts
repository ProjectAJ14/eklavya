import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTurn, questionCount, summarise, toolName, type Rule, type TutorTurn } from '../src/eval/conversation-score.js';

const turn = (over: Partial<TutorTurn> = {}): TutorTurn => ({ tool_calls: [], message: '', ...over });
const ids = (t: TutorTurn, rules: Rule[]) => checkTurn(t, rules).map((v) => `${v.id}:${v.ok}`);

describe('toolName', () => {
  it('treats plugin-scoped and bare names as one tool', () => {
    expect(toolName('mcp__plugin_eklavya_eklavya__record_attempt')).toBe('record_attempt');
    expect(toolName('mcp__eklavya__record_attempt')).toBe('record_attempt');
    expect(toolName('AskUserQuestion')).toBe('AskUserQuestion');
  });
});

describe('questionCount', () => {
  it('counts both question tools and a lettered block, not prose', () => {
    expect(questionCount(turn({ tool_calls: [{ tool: 'AskUserQuestion' }, { tool: 'mcp__x__present_question' }] }))).toBe(2);
    expect(questionCount(turn({ message: 'Which?\n  A) one\n  B) two\n  C) three\n  D) four' }))).toBe(1);
    expect(questionCount(turn({ message: 'Option A) is fine. Why?' }))).toBe(0);
  });
});

describe('call rules', () => {
  const rec = (args: Record<string, unknown>): TutorTurn => turn({ tool_calls: [{ tool: 'mcp__a__record_attempt', args }] });
  const rule: Rule = { id: 'blank', kind: 'call', tool: 'record_attempt', where: { outcome: 'dont_know', grade: 0, feedback: { lengthMin: 5 } } };
  it('matches literals and string lengths', () => {
    expect(ids(rec({ outcome: 'dont_know', grade: 0, feedback: 'long enough' }), [rule])).toEqual(['blank:true']);
    expect(ids(rec({ outcome: 'dont_know', grade: 0, feedback: 'no' }), [rule])).toEqual(['blank:false']);
    expect(ids(turn(), [rule])).toEqual(['blank:false']);
  });
  it('supports ranges, regexes, absence, oneOf, nested paths and a ceiling of zero', () => {
    const t = turn({ tool_calls: [{ tool: 'Agent', args: { subagent_type: 'eklavya:eklavya-explainer', prompt: 'attempt 412', options: [{ correct: false }, { correct: true }] } }, { tool: 'record_attempt', args: { grade: 2 } }] });
    const rules: Rule[] = [
      { id: 'agent', kind: 'call', tool: 'Agent', where: { subagent_type: { regex: 'explainer' }, prompt: { regex: '412' }, 'options.1.correct': true } },
      { id: 'range', kind: 'call', tool: 'record_attempt', where: { grade: { min: 1, max: 2 } } },
      { id: 'absent', kind: 'call', tool: 'record_attempt', where: { feedback: { absent: true } } },
      { id: 'oneOf', kind: 'call', tool: 'record_attempt', where: { grade: { oneOf: [1, 2] } } },
      { id: 'none', kind: 'call', tool: 'get_session_quiz_plan', max: 0 },
      { id: 'outOfRange', kind: 'call', tool: 'record_attempt', where: { grade: { min: 3 } } },
      { id: 'badRegexTarget', kind: 'call', tool: 'record_attempt', where: { grade: { regex: '2' } } },
    ];
    expect(ids(t, rules)).toEqual(['agent:true', 'range:true', 'absent:true', 'oneOf:true', 'none:true', 'outOfRange:false', 'badRegexTarget:false']);
  });
  it('measures array length', () => {
    const t = turn({ tool_calls: [{ tool: 'record_attempt', args: { option_notes: ['a', 'b', 'c', 'd'] } }] });
    expect(ids(t, [{ id: 'notes', kind: 'call', tool: 'record_attempt', where: { option_notes: { lengthMin: 4 } } }])).toEqual(['notes:true']);
    expect(ids(t, [{ id: 'notes', kind: 'call', tool: 'record_attempt', where: { option_notes: { lengthMin: 5 } } }])).toEqual(['notes:false']);
    expect(ids(t, [{ id: 'n', kind: 'call', tool: 'record_attempt', where: { missing: { lengthMin: 1 } } }])).toEqual(['n:false']);
  });
});

describe('match edge cases', () => {
  const one = (where: Record<string, any>, args?: Record<string, unknown>) =>
    checkTurn(turn({ tool_calls: [{ tool: 'record_attempt', ...(args ? { args } : {}) }] }), [{ id: 'r', kind: 'call', tool: 'record_attempt', where }])[0]!.ok;
  it('handles a call with no args, bounds given one-sided, and absence of each kind', () => {
    expect(one({ grade: 3 })).toBe(false);
    expect(one({ x: { absent: true } })).toBe(true);
    expect(one({ x: { absent: true } }, { x: '' })).toBe(true);
    expect(one({ x: { absent: true } }, { x: null })).toBe(true);
    expect(one({ x: { absent: true } }, { x: 'set' })).toBe(false);
    expect(one({ g: { min: 2 } }, { g: 3 })).toBe(true);
    expect(one({ g: { max: 2 } }, { g: 3 })).toBe(false);
    expect(one({ g: {} }, { g: 3 })).toBe(true);
    expect(one({ f: { lengthMax: 3 } }, { f: 'abcd' })).toBe(false);
    expect(one({ f: { lengthMin: 1 } }, { f: 7 })).toBe(false);
    expect(one({ f: { lengthMin: 1 } }, { f: ['x'] })).toBe(true);
    expect(one({ 'a.b': 1 }, { a: 5 })).toBe(false);
  });
});

describe('question and message rules', () => {
  it('limits questions', () => {
    expect(ids(turn({ tool_calls: [{ tool: 'AskUserQuestion' }] }), [{ id: 'q', kind: 'questions', max: 0 }])).toEqual(['q:false']);
  });
  it('checks length, patterns and the closing question', () => {
    const rule: Rule = { id: 'm', kind: 'message', maxSentences: 2, minChars: 10, match: 'origin', notMatch: 'sorry', notEndsWithQuestion: true };
    expect(checkTurn(turn({ message: 'The Origin cannot be forged. Moving on.' }), [rule])[0]!.ok).toBe(true);
    const bad = checkTurn(turn({ message: 'Sorry. One. Two. Shall we?' }), [rule])[0]!;
    expect(bad.ok).toBe(false);
    expect(bad.detail).toMatch(/sentences.*does not match.*matches.*ends on a question/);
    expect(checkTurn(turn({ message: 'hi' }), [{ id: 'm', kind: 'message', minChars: 10 }])[0]!.detail).toMatch(/characters/);
  });
});

describe('summarise', () => {
  it('counts clean trials, failures per rule and unparsed replies', () => {
    const sum = summarise([
      { scenario: 'a', trial: 0, verdicts: [{ id: 'x', ok: true, detail: '' }] },
      { scenario: 'a', trial: 1, verdicts: [{ id: 'x', ok: false, detail: '' }, { id: 'y', ok: true, detail: '' }] },
      { scenario: 'a', trial: 2, unparsed: 'bad json', verdicts: [] },
    ]);
    expect(sum).toMatchObject({ trials: 3, clean: 1, unparsed: 1 });
    expect(sum.byScenario.a).toEqual({ trials: 3, clean: 1, unparsed: 1, failed: { x: 1 } });
  });
});

describe('the scenario fixtures', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'fixtures', 'conversation', 'scenarios.json');
  const { scenarios } = JSON.parse(fs.readFileSync(file, 'utf8')) as { scenarios: { id: string; rules: Rule[]; setting: string }[] };
  it('have unique ids and at least one well-formed rule each', () => {
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
    for (const s of scenarios) {
      expect(s.setting.length).toBeGreaterThan(20);
      expect(s.rules.length).toBeGreaterThan(0);
      for (const r of s.rules) expect(['call', 'questions', 'message']).toContain(r.kind);
      // Every rule must be satisfiable by some turn, so a typo cannot make a scenario unpassable:
      // a regex has to compile.
      for (const r of s.rules) if (r.kind === 'message') for (const p of [r.match, r.notMatch]) if (p) expect(() => new RegExp(p)).not.toThrow();
    }
  });
});

describe('order rules', () => {
  const calls = (...tools: string[]): TutorTurn => turn({ tool_calls: tools.map((tool) => ({ tool })) });
  const rule: Rule = { id: 'o', kind: 'order', tools: ['get_session_quiz_plan', 'AskUserQuestion', 'record_attempt', '@work'] };
  it('passes a subsequence in order, with other calls between', () => {
    expect(ids(calls('Skill', 'mcp__a__get_session_quiz_plan', 'AskUserQuestion', 'mcp__a__record_attempt', 'Write'), [rule])).toEqual(['o:true']);
  });
  it('fails a missing step, a wrong order, or a quiz that never resumes', () => {
    expect(ids(calls('AskUserQuestion', 'record_attempt', 'Write'), [rule])).toEqual(['o:false']);
    expect(ids(calls('get_session_quiz_plan', 'record_attempt', 'AskUserQuestion', 'Write'), [rule])).toEqual(['o:false']);
    const stalled = checkTurn(calls('Edit', 'get_session_quiz_plan', 'AskUserQuestion', 'record_attempt'), [rule])[0]!;
    expect(stalled).toMatchObject({ ok: false });
    expect(stalled.detail).toMatch(/no @work/);
  });
});

describe('the hook-text fixtures', () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'eval', 'fixtures', 'hook-text', 'scenarios.json');
  const { scenarios } = JSON.parse(fs.readFileSync(file, 'utf8')) as { scenarios: { id: string; hook: string; rules: Rule[] }[] };
  it('have unique ids, a known hook and well-formed rules', () => {
    expect(new Set(scenarios.map((s) => s.id)).size).toBe(scenarios.length);
    for (const s of scenarios) {
      expect(['checkpoint', 'stop']).toContain(s.hook);
      expect(new Set(s.rules.map((r) => r.id)).size).toBe(s.rules.length);
      for (const r of s.rules) expect(['call', 'questions', 'message', 'order']).toContain(r.kind);
      for (const r of s.rules) if (r.kind === 'message') for (const p of [r.match, r.notMatch]) if (p) expect(() => new RegExp(p)).not.toThrow();
    }
  });
  it('pass a clean checkpoint turn, so the rules are satisfiable', () => {
    const s = scenarios.find((x) => x.id === 'checkpoint-tool-correct')!;
    const clean: TutorTurn = {
      tool_calls: [
        { tool: 'mcp__plugin_eklavya_eklavya__get_session_quiz_plan', args: { max: 1, ignore_cooldown: true } },
        { tool: 'AskUserQuestion', args: { questions: [{ question: 'Why pin algorithms?', header: 'Eklavya' }] } },
        { tool: 'mcp__plugin_eklavya_eklavya__record_attempt', args: { format: 'mcq', grade: 4, options: ['a', 'b', 'c', 'd'] } },
        { tool: 'Write', args: { file_path: 'test/orders.auth.test.ts' } },
      ],
      message: 'Correct: pinning HS256 stops a token from choosing its own algorithm.',
    };
    expect(checkTurn(clean, s.rules).filter((v) => !v.ok)).toEqual([]);
  });
});

describe('firstParagraph', () => {
  it('judges the verdict, not the resume line after it', () => {
    const t = turn({ message: 'Right. One line of why.\n\nNow writing the test. It covers four cases. Then I run it.' });
    expect(ids(t, [{ id: 'p', kind: 'message', maxSentences: 2, firstParagraph: true }])).toEqual(['p:true']);
    expect(ids(t, [{ id: 'w', kind: 'message', maxSentences: 2 }])).toEqual(['w:false']);
  });
});
