import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks', 'ask-label.js');

function ask(entrypoint: string, questions: unknown[], extra: Record<string, unknown> = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'AskUserQuestion', tool_input: { questions }, ...extra }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: entrypoint, EKLAVYA_SURFACE: '' },
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

const unsigned = { header: 'Eklavya', question: 'What does const buy you?' };

describe('ask-label', () => {
  it('denies an unsigned Eklavya question on a card host', () => {
    expect(JSON.parse(ask('claude-desktop', [unsigned])).hookSpecificOutput.permissionDecision).toBe('deny');
  });
  it('lets a signed one, another header, a terminal and a subagent through', () => {
    expect(ask('claude-desktop', [{ ...unsigned, question: '[Eklavya]\nWhat?' }])).toBe('');
    expect(ask('claude-desktop', [{ header: 'Plan', question: 'Which?' }])).toBe('');
    expect(ask('cli', [unsigned])).toBe('');
    expect(ask('claude-desktop', [unsigned], { agent_id: 'a1' })).toBe('');
    expect(ask('claude-desktop', [{ header: 'Eklavya', question: ' [eklavya] What?' }])).toBe('');
  });
  it('ignores other tools and malformed input, and treats Cowork as a card host', () => {
    expect(ask('claude-desktop', [unsigned], { tool_name: 'Bash' })).toBe('');
    expect(ask('claude-desktop', 'nope' as any)).toBe('');
    expect(ask('claude-desktop', [null, { header: 'Eklavya' }])).toBe('');
    expect(JSON.parse(ask('local-agent', [unsigned])).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('ask-label: conspicuous options', () => {
  const opt = (label: string, description: string) => ({ label, description });
  const lopsided = (stem: string) => ({
    header: 'Eklavya',
    question: stem,
    options: [
      opt('Compares a value', 'Checks a header'),
      opt('Checks a value the browser adds itself and a page cannot set', 'A forged cross-site request then carries a different origin and fails'),
      opt('Signs a value', 'Adds a signature'),
      opt('Hashes a value', 'Adds a digest'),
    ],
  });
  it('denies once, then lets the same stem through', () => {
    const q = lopsided(`Why compare the Origin header? ${Date.now()}`);
    const sid = { session_id: `s-${Date.now()}` };
    expect(JSON.parse(ask('cli', [q], sid)).hookSpecificOutput.permissionDecisionReason).toMatch(/option 2 is/);
    expect(ask('cli', [q], sid)).toBe('');
  });
  it('leaves other headers and balanced questions alone', () => {
    expect(ask('cli', [{ ...lopsided('Which?'), header: 'Plan' }])).toBe('');
    const balanced = { header: 'Eklavya', question: 'Balanced?', options: ['a', 'b', 'c', 'd'].map((x) => opt(`Option ${x}`, 'Same length here')) };
    expect(ask('cli', [balanced])).toBe('');
  });
});
