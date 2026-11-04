import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import {
  argRepairs,
  boundaries,
  emptyProbes,
  envPrefix,
  envValues,
  errorPhrase,
  formOf,
  formRepairEvidence,
  formRepairs,
  infraError,
  intentOf,
  observe,
  render,
  type Call,
} from '../src/economy/envfacts.js';
import { foldSessionFacts, fromObservation, fromProposal, injectable, listFacts, pinnedLines, retireFact, sessionEvidence } from '../src/memory/pinned.js';
import { recall } from '../src/memory/recall.js';
import { insertEntry } from '../src/memory/store.js';

const config = (patch: (c: EklavyaConfig) => void = () => {}): EklavyaConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  patch(c);
  return c;
};
const bash = (input: string, output: string, failed = false): Call => ({ tool: 'Bash', input, output, failed });

describe('families', () => {
  it('reads forms, intents, prefixes and error classes', () => {
    expect(envPrefix('FOO=1 BAR="a b" cmd x')).toEqual([{ FOO: '1', BAR: 'a b' }, 'cmd x']);
    expect(intentOf('pytest -q')).toBe('run_tests');
    expect(intentOf('python3 script.py')).toBe('run_interpreter');
    expect(intentOf('pip install x')).toBe('package_tool');
    expect(intentOf('ls')).toBeNull();
    expect(formOf('python -m pytest tests/x.py')).toBe('python -m pytest');
    expect(formOf('npx vitest run')).toBe('npx vitest');
    expect(formOf('npm run test')).toBe('npm run test');
    expect(formOf('npm test')).toBe('npm test');
    expect(formOf('uv run pytest')).toBe('uv run pytest');
    expect(formOf('go test ./...')).toBe('go test');
    expect(formOf('cd api && pytest -x')).toBe('cd api && pytest');
    expect(formOf('npx -y x')).toBe('npx');
    expect(infraError('bash: pytest: command not found')).toBe('command_missing');
    expect(infraError('ok')).toBeNull();
    expect(errorPhrase('module_missing')).toBe('a missing-module error');
    expect(errorPhrase('other')).toBe('other');
  });

  it('FormRepair: a failing form then a working one of the same intent', () => {
    const calls = [
      bash('pytest -q', 'bash: pytest: command not found', true),
      bash('pytest -q', 'bash: pytest: command not found', true),
      bash('python -m pytest -q', '3 passed'),
      bash('ls', 'x'),
      bash('python3 x.py', "ModuleNotFoundError: No module named 'y'", true),
      bash('python3 x.py', 'ok'),
      bash('PYTHONPATH=. python3 -m pytest', 'ok'),
    ];
    const [o] = formRepairs(calls);
    expect(o).toMatchObject({ key: 'form_repair:run_tests:pytest', params: { a: 'pytest', b: 'python -m pytest', error: 'command_missing' }, verdict: 'confirm' });
    expect(formRepairs(calls)).toHaveLength(1);
    expect(render('form_repair', o!.params)).toBe('`pytest …` fails here with command not found; `python -m pytest …` works.');
    const fact = { a: 'pytest', b: 'python -m pytest', intent: 'run_tests' };
    expect(formRepairEvidence([bash('python -m pytest', 'ok')], fact)).toEqual({ verdict: null, exercised: true, applied: true });
    expect(formRepairEvidence([bash('pytest', 'ok')], fact)).toEqual({ verdict: 'contradict', exercised: true, applied: false });
    expect(formRepairEvidence([bash('pytest', 'command not found', true)], fact)).toEqual({ verdict: 'confirm', exercised: true, applied: false });
    expect(formRepairEvidence([bash('ls', ''), { tool: 'Read', input: '', output: '', failed: false }], fact)).toEqual({ verdict: null, exercised: false, applied: false });
  });

  it('EnvValue, Boundary, ArgRepair and EmptyProbe', () => {
    expect(envValues([bash('python app.py', 'KeyError: \'DATABASE_URL\'', true), bash('DATABASE_URL=sqlite:// python app.py', 'ok'), bash('X=1 ls', 'ok'), { tool: 'Read', input: '', output: '', failed: false }])).toEqual([
      expect.objectContaining({ key: 'env_value:DATABASE_URL', params: { var: 'DATABASE_URL', good: 'sqlite://' } }),
    ]);
    expect(envValues([bash('x', 'environment variable API_KEY is required', false)])).toEqual([]);
    const b = boundaries([
      { tool: 'WebFetch', input: 'https://pypi.org/simple', output: 'getaddrinfo ENOTFOUND pypi.org', failed: true },
      bash('curl https://example.com/x', 'hello'),
      bash('curl -s localhost', 'x'),
      bash('ls', ''),
      bash('curl https://down.io', '', true),
    ]);
    expect(b.map((o) => [o.key, o.verdict])).toEqual([['boundary:pypi.org', 'confirm'], ['boundary:example.com', 'contradict']]);
    expect(render('boundary', { host: 'pypi.org' })).toContain('pypi.org');
    const arg = argRepairs([
      bash('pytest tests/a.py::T::t', 'ERROR: not found: tests/a.py::T::t', true),
      bash('pytest tests.a.T.t', '1 passed'),
      bash('pytest -k x', 'ok'),
      bash('ls a::b', ''),
    ]);
    expect(arg).toEqual([expect.objectContaining({ key: 'arg_repair:pytest', verdict: 'confirm' })]);
    expect(argRepairs([bash('pytest a::b', 'ERROR: not found', true), bash('pytest a::b', '1 passed')])[0]!.verdict).toBe('contradict');
    expect(argRepairs([bash('pytest a.b', 'ok')])).toEqual([]);
    expect(render('arg_repair', { form: 'pytest' })).toContain('dotted test labels');
    expect(emptyProbes([bash('git remote', ''), bash('git branch -a', '* main')])[0]).toMatchObject({ verdict: 'confirm', high: true });
    expect(emptyProbes([bash('git remote -v', 'origin git@x (fetch)')])[0]!.verdict).toBe('contradict');
    expect(emptyProbes([bash('git remote', '', true), bash('ls', '')])).toEqual([]);
    expect(render('env_value', { var: 'A', good: '1' })).toContain('`A=1`');
    expect(render('empty_probe', {})).toContain('no git remote');
    expect(observe([bash('git remote', '')])).toHaveLength(1);
  });
});

describe('the lifecycle', () => {
  let home: string;
  let db: DB;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-facts-'));
    db = openDb(path.join(home, 'knowledge.db'));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  const P = '/repo';
  const missing = [bash('pytest', 'bash: pytest: command not found', true), bash('python -m pytest', '2 passed')];

  it('forms after three sessions, is shown, and a clean contradiction streak retires it (the #264 gate)', () => {
    for (const s of ['s1', 's2']) foldSessionFacts(db, P, s, sessionEvidence(db, P, missing));
    expect(listFacts(db, P)[0]).toMatchObject({ state: 'forming', confirmations: 2 });
    expect(pinnedLines(db, config(), P, 'x')).toBeNull();
    foldSessionFacts(db, P, 's3', sessionEvidence(db, P, missing));
    // Counting a session twice changes nothing.
    foldSessionFacts(db, P, 's3', sessionEvidence(db, P, missing));
    expect(listFacts(db, P)[0]).toMatchObject({ state: 'active', confirmations: 3 });
    const lines = pinnedLines(db, config(), P, 's4')!;
    expect(lines[1]).toBe('- `pytest …` fails here with command not found; `python -m pytest …` works.');
    expect(db.prepare('SELECT COUNT(*) AS n FROM pinned_fact_shown WHERE session_id = ?').get('s4')).toEqual({ n: 1 });
    // The next session uses the working form: applied.
    foldSessionFacts(db, P, 's4', sessionEvidence(db, P, [bash('python -m pytest', 'ok')]));
    expect(listFacts(db, P)[0]).toMatchObject({ applied: 3, exercised: 4 });
    // Bare pytest works once: not yet a contradiction. Twice in a row: retired.
    foldSessionFacts(db, P, 's5', sessionEvidence(db, P, [bash('pytest', '3 passed')]));
    expect(listFacts(db, P)[0]!.state).toBe('active');
    foldSessionFacts(db, P, 's6', sessionEvidence(db, P, [bash('pytest', '3 passed')]));
    expect(listFacts(db, P)).toEqual([]);
    expect(listFacts(db, P, true)[0]).toMatchObject({ state: 'retired', retired_reason: 'contradicted' });
  });

  it('retires a high-stakes fact on one contradiction, fades an unused one, and retires by hand', () => {
    const probe = (out: string) => sessionEvidence(db, P, [bash('git remote', out)]);
    for (const s of ['a', 'b', 'c']) foldSessionFacts(db, P, s, probe(''));
    expect(listFacts(db, P)[0]!.state).toBe('active');
    foldSessionFacts(db, P, 'd', probe('origin x'));
    expect(listFacts(db, P, true)[0]).toMatchObject({ state: 'retired', retired_reason: 'contradicted (high stakes)' });

    foldSessionFacts(db, P, 'e', sessionEvidence(db, P, missing));
    const id = listFacts(db, P)[0]!.id;
    expect(retireFact(db, P, id)).toBe(true);
    expect(retireFact(db, P, id)).toBe(false);
    // A contradicted fact that is not high stakes and has little score retires by score.
    foldSessionFacts(db, P, 'f', sessionEvidence(db, P, [bash('curl https://h.io', 'Could not resolve host', true)]));
    foldSessionFacts(db, P, 'g', sessionEvidence(db, P, [bash('curl https://h.io', 'ok')]));
    expect(listFacts(db, P, true).find((f) => f.family === 'boundary')).toMatchObject({ state: 'retired', retired_reason: 'contradicted' });
    // An observed fact not seen again decays; it stays while above zero.
    foldSessionFacts(db, P, 'h', [fromObservation({ family: 'env_value', key: 'env_value:A', params: { var: 'A', good: '1' }, verdict: 'confirm', exercised: true, applied: false, high: false })]);
    for (const s of ['i', 'j']) foldSessionFacts(db, P, s, []);
    expect(listFacts(db, P).find((f) => f.family === 'env_value')!.score).toBeCloseTo(0.64);
  });

  it('holds back a fact that stops applying, keeps the budgets, and leaves out observer facts unless asked', () => {
    expect(injectable({ state: 'active', text: 'x', exercised: 4, applied: 1 })).toBe(false);
    expect(injectable({ state: 'active', text: 'x', exercised: 5, applied: 2 })).toBe(true);
    expect(injectable({ state: 'active', text: 'do not run tests', exercised: 0, applied: 0 })).toBe(false);
    expect(fromProposal('decision', 'short')).toBeNull();
    expect(fromProposal('decision', 'You can skip the slow integration tests')).toBeNull();
    const p = fromProposal('decision', 'CSV exports use  ; as the separator')!;
    expect(p.text).toBe('CSV exports use ; as the separator');
    for (const s of ['a', 'b', 'c']) foldSessionFacts(db, P, s, [p], { only: true });
    for (let i = 0; i < 6; i++) {
      const e = fromObservation({ family: 'env_value', key: `env_value:V${i}`, params: { var: `V${i}`, good: '1' }, verdict: 'confirm', exercised: false, applied: false, high: false });
      for (const s of ['a', 'b', 'c']) foldSessionFacts(db, P, `${s}${i}`, [e], { only: true });
    }
    const free = pinnedLines(db, config(), P, null)!;
    expect(free.filter((l) => l.startsWith('- ')).length).toBe(4);
    const both = pinnedLines(db, config((c) => (c.economy.envfacts = 'observer')), P, null)!;
    expect(both.some((l) => l.includes('CSV exports'))).toBe(true);
    expect(pinnedLines(db, config((c) => (c.memory.pinned_facts = 1)), P, null)!.length).toBe(2);
    expect(pinnedLines(db, config((c) => (c.memory.pinned_facts = 0)), P, null)).toBeNull();
    expect(pinnedLines(db, config((c) => (c.economy.envfacts = 'off')), P, null)).toBeNull();
    // A fact too long for what is left of the budget is skipped.
    db.prepare(`UPDATE pinned_facts SET text = ? WHERE fact_key = 'env_value:V0'`).run('x'.repeat(1200));
    expect(pinnedLines(db, config(), P, null)!.some((l) => l.length > 1000)).toBe(false);
  });

  it('puts pinned facts at the top of the session-start block', () => {
    insertEntry(db, { project: P, sessionId: 'old', title: 'Some work' });
    const block = recall(db, config(), { project: P, index: true, pinned: ['Pinned facts:', '- a fact'] }).block!;
    expect(block.indexOf('- a fact')).toBeLessThan(block.indexOf('Some work'));
  });
});
