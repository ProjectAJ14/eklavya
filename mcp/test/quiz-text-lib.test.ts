import { describe, it, expect } from 'vitest';
import { checkpointText, stopText } from '../src/hooks/quiz-text-lib.js';

const base = { concept: 'jwt-verification (verify.ts:12)', remaining: 3, justLogged: true, panel: false, focus: 'project' };

describe('checkpointText', () => {
  it('names the seam, the concept, the plan call and the budget', () => {
    const text = checkpointText(base);
    expect(text).toMatch(/^\[Eklavya checkpoint\] You just logged a concept/);
    expect(text).toContain('Concept: jwt-verification (verify.ts:12)');
    expect(text).toContain('get_session_quiz_plan with max: 1 and ignore_cooldown: true');
    expect(text).toContain('3 left in this session');
    expect(text).toContain("Focus is 'project'");
  });
  it('does not claim a log on a work-tool seam', () => {
    expect(checkpointText({ ...base, justLogged: false })).not.toMatch(/just logged/);
  });
  it('asks with AskUserQuestion, grades, and parts a skip from a blank on the card', () => {
    const text = checkpointText(base);
    expect(text).toMatch(/AskUserQuestion[\s\S]*record_attempt[\s\S]*verdict[\s\S]*Resume the task/);
    expect(text).toMatch(/say skip, record grade 0 with outcome declined and carry on without teaching it/);
    expect(text).toMatch(/do not know, record grade 0 with outcome dont_know and teach the answer/);
  });
  it('presents in the panel and neither records nor waits', () => {
    const text = checkpointText({ ...base, panel: true });
    expect(text).toContain('present_question');
    expect(text).toContain('Do not call record_attempt');
    expect(text).not.toMatch(/AskUserQuestion|say skip/);
  });
});

describe('stopText', () => {
  const stop = { asked: 1, names: ['jwt-verification'], due: false, logFirst: false, gate: false };
  it('asks one question on this session\'s work', () => {
    expect(stopText(stop)).toBe('Eklavya: one question on jwt-verification before this turn ends -- call get_session_quiz_plan and follow it.');
  });
  it('counts several, names review work, and adds the gate', () => {
    expect(stopText({ ...stop, asked: 2, names: ['a', 'b'], due: true, gate: true })).toBe(
      'Eklavya: up to 2 questions, one at a time, on earlier work in this project that is due again (a, b) before this turn ends -- call get_session_quiz_plan and follow it. The commit gate needs it.',
    );
  });
  it('logs first when the session logged nothing', () => {
    expect(stopText({ ...stop, names: [], logFirst: true })).toMatch(/one question on this work .* call log_session_concepts .* then get_session_quiz_plan/);
  });
});
