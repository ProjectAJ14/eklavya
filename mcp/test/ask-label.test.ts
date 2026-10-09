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
