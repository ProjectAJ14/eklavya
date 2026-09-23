import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { getSessionQuizPlan } from '../src/tools/get_session_quiz_plan.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { getGateStatus } from '../src/tools/get_gate_status.js';
import { tempDbPath, cleanup } from './helpers.js';

/**
 * An enforced gate must always be passable by answering what the plan offers.
 *
 * `required` is frozen when work is logged and never drops, but the plan used to
 * offer a touched concept only while it was unmastered or due. So a concept that
 * another session mastered after this one logged it could never be asked here,
 * and the bar it had helped set could never be met: session A logs three
 * concepts (needed = ceil(3 x 0.7) = 3), session B masters one, A can pass at
 * most two -- then the plan served widening questions that count for nothing,
 * then `already_covered`, and the commit stayed blocked until the mastered
 * concept came due six days later.
 */

let dbFile = '';
let db: DB;
let home = '';
let cwd = '';
const envBackup = { ...process.env };

const WORK = ['httponly-cookies', 'jwt-structure', 'csrf'];

function configure(patch: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ min_minutes_between_quizzes: 0, ...patch }));
}

const call = <T>(tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown> = {}): T =>
  tool.handler({ cwd, ...args }, { db }) as T;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cwd-'));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
  dbFile = tempDbPath('gate-passable');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  process.env = { ...envBackup };
});

function logWork(session: string, slugs = WORK) {
  return call<any>(logSessionConcepts, {
    session_id: session,
    concepts: slugs.map((slug) => ({ slug, context: `touched ${slug}` })),
  });
}

/** Two good answers in another session: `known`, and not due for days. */
function masterElsewhere(slug: string, session = 'sess-B') {
  for (const n of [1, 2]) {
    call(recordAttempt, { session_id: session, slug, question: `B ${slug} ${n}`, answer: 'a', grade: 4, difficulty: 1 });
  }
}

/**
 * Plays the learner who answers every offered question correctly, until the
 * plan stops offering. Returns every plan item served, in order.
 */
function answerEverything(session: string): { slug: string; reason: string; gateOpen: boolean }[] {
  const served: { slug: string; reason: string; gateOpen: boolean }[] = [];
  for (let round = 0; round < 12; round += 1) {
    const gateOpen = !call<any>(getGateStatus, { session_id: session }).passed;
    const plan = call<any>(getSessionQuizPlan, { session_id: session });
    if (plan.questions_needed === 0) break;
    for (const c of plan.concepts) {
      served.push({ slug: c.slug, reason: c.reason, gateOpen });
      call(recordAttempt, {
        session_id: session,
        slug: c.slug,
        question: `A ${c.slug} round ${round}`,
        answer: 'a',
        grade: 4,
        difficulty: c.tier_to_ask,
        format: 'mcq',
      });
    }
  }
  return served;
}

describe('an enforced gate is always passable', () => {
  for (const focus of ['project', 'concept'] as const) {
    for (const cadence of ['interleaved', 'end'] as const) {
      it(`clears after a work concept is mastered in another session (focus ${focus}, cadence ${cadence})`, () => {
        configure({ quiz: { enabled: true, enforced: true }, focus, cadence });
        const opened = logWork('sess-A');
        expect(opened.gate.required).toBe(3);
        expect(opened.gate.needed).toBe(3);

        masterElsewhere(WORK[0]!);

        const served = answerEverything('sess-A');
        expect(call<any>(getGateStatus, { session_id: 'sess-A' }).passed).toBe(true);

        // The mastered concept was asked here, and nothing that cannot count
        // toward the gate was served while it stood open.
        expect(served.map((s) => s.slug)).toContain(WORK[0]);
        expect(served.find((s) => s.slug === WORK[0])!.reason).toBe('gate_work');
        expect(served.filter((s) => s.gateOpen).every((s) => WORK.includes(s.slug))).toBe(true);
      });
    }
  }

  it('offers every work concept when all of them were mastered elsewhere after logging', () => {
    configure({ quiz: { enabled: true, enforced: true }, focus: 'concept', cadence: 'end' });
    logWork('sess-A');
    for (const slug of WORK) masterElsewhere(slug);

    const plan = call<any>(getSessionQuizPlan, { session_id: 'sess-A' });
    expect(plan.concepts.map((c: any) => c.slug).sort()).toEqual([...WORK].sort());
    expect(plan.concepts.every((c: any) => c.reason === 'gate_work')).toBe(true);

    answerEverything('sess-A');
    expect(call<any>(getGateStatus, { session_id: 'sess-A' }).passed).toBe(true);
  });

  it('opens no gate at all when the work was already mastered before it was logged', () => {
    configure({ quiz: { enabled: true, enforced: true }, cadence: 'end' });
    for (const slug of WORK) masterElsewhere(slug);
    const opened = logWork('sess-A');
    expect(opened.gate.required).toBe(0);
    expect(opened.gate.passed).toBe(true);
  });

  it('does not re-ask a concept already passed this session while the gate waits on the others', () => {
    configure({ quiz: { enabled: true, enforced: true }, cadence: 'end' });
    logWork('sess-A');
    call(recordAttempt, { session_id: 'sess-A', slug: WORK[1], question: 'q', answer: 'a', grade: 4, difficulty: 1 });
    masterElsewhere(WORK[0]!);
    const slugs = call<any>(getSessionQuizPlan, { session_id: 'sess-A' }).concepts.map((c: any) => c.slug);
    expect(slugs).not.toContain(WORK[1]);
    expect(slugs).toEqual(expect.arrayContaining([WORK[0], WORK[2]]));
  });

  it('serves no widening or review question while the gate is open, and resumes them once it passes', () => {
    configure({ quiz: { enabled: true, enforced: true }, focus: 'concept', cadence: 'end', max_questions_per_task: 4 });
    logWork('sess-A');
    const open = call<any>(getSessionQuizPlan, { session_id: 'sess-A' });
    expect(open.concepts.every((c: any) => WORK.includes(c.slug))).toBe(true);

    for (const slug of WORK) {
      call(recordAttempt, { session_id: 'sess-A', slug, question: `q ${slug}`, answer: 'a', grade: 4, difficulty: 1 });
    }
    expect(call<any>(getGateStatus, { session_id: 'sess-A' }).passed).toBe(true);
    const after = call<any>(getSessionQuizPlan, { session_id: 'sess-A' });
    expect(after.concepts.some((c: any) => c.reason === 'concept_widening')).toBe(true);
  });

  it('still holds the bar: skips count as answered, never as passing, and the bar never lowers', () => {
    configure({ quiz: { enabled: true, enforced: true }, cadence: 'end' });
    logWork('sess-A');
    masterElsewhere(WORK[0]!);
    for (const slug of WORK) {
      call(recordAttempt, { session_id: 'sess-A', slug, question: `skip ${slug}`, grade: 0, difficulty: 1, outcome: 'dont_know', feedback: 'taught' });
    }
    const gate = call<any>(getGateStatus, { session_id: 'sess-A' });
    expect(gate.required).toBe(3);
    expect(gate.answered).toBe(3);
    expect(gate.passed).toBe(false);
    // And the way out is the retry pass, for all three -- the mastered one included.
    const retry = call<any>(getSessionQuizPlan, { session_id: 'sess-A' });
    expect(retry.concepts.map((c: any) => c.slug).sort()).toEqual([...WORK].sort());
    expect(retry.concepts.every((c: any) => c.reason === 'gate_retry')).toBe(true);
  });
});

describe('unenforced quizzing is unchanged', () => {
  it('still never offers a concept mastered elsewhere', () => {
    configure({ quiz: { enabled: true, enforced: false }, focus: 'project', cadence: 'end' });
    logWork('sess-A');
    masterElsewhere(WORK[0]!);
    const plan = call<any>(getSessionQuizPlan, { session_id: 'sess-A' });
    const slugs = plan.concepts.map((c: any) => c.slug);
    expect(slugs).not.toContain(WORK[0]);
    expect(plan.concepts.some((c: any) => c.reason === 'gate_work')).toBe(false);
  });

  it('still widens in concept focus', () => {
    configure({ quiz: { enabled: true, enforced: false }, focus: 'concept', cadence: 'end' });
    logWork('sess-A');
    const plan = call<any>(getSessionQuizPlan, { session_id: 'sess-A' });
    expect(plan.concepts.some((c: any) => c.reason === 'concept_widening')).toBe(true);
  });
});
