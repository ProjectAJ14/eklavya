import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { getLearnerProfile } from '../src/tools/get_learner_profile.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { getSessionQuizPlan } from '../src/tools/get_session_quiz_plan.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { getGateStatus } from '../src/tools/get_gate_status.js';
import { upsertConcepts } from '../src/tools/upsert_concepts.js';
import { getConceptGraph } from '../src/tools/get_concept_graph.js';
import { getConfig, setConfig } from '../src/tools/config_tools.js';
import { resolveSessionId, setCurrentSession, FALLBACK_SESSION_ID } from '../src/session.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let home = '';
let cwd = '';
const envBackup = { ...process.env };

const SESSION = 'sess-1';

function configure(patch: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(patch));
}

/** Handlers take (args, ctx); ctx is just the db. */
const call = <T>(tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown> = {}): T =>
  tool.handler({ cwd, ...args }, { db }) as T;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cwd-'));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
  dbFile = tempDbPath('tools');
  db = openDb(dbFile);
  // No cooldown by default: cadence has its own tests.
  configure({ min_minutes_between_quizzes: 0 });
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  process.env = { ...envBackup };
});

function logAuthWork(session = SESSION) {
  return call<any>(logSessionConcepts, {
    session_id: session,
    concepts: [
      { slug: 'httponly-cookies', context: 'set httpOnly on the refresh cookie in auth.ts' },
      { slug: 'jwt-structure', context: 'signed the access token in token.ts' },
      { slug: 'csrf', context: 'chose SameSite=Lax on the session cookie' },
    ],
  });
}

/** Answer a concept well enough, twice, to reach "known". */
function master(slug: string, session = SESSION) {
  for (const _ of [1, 2]) {
    call(recordAttempt, {
      session_id: session,
      slug,
      question: `about ${slug}`,
      answer: 'a good answer',
      grade: 5,
      difficulty: 2,
    });
  }
}

describe('session resolution (G1)', () => {
  it('prefers an explicit id', () => {
    expect(resolveSessionId(db, 'explicit')).toBe('explicit');
  });

  it('falls back to the env var, then the stamped session, then default', () => {
    expect(resolveSessionId(db)).toBe(FALLBACK_SESSION_ID);

    setCurrentSession(db, 'from-hook');
    expect(resolveSessionId(db)).toBe('from-hook');

    process.env.EKLAVYA_SESSION_ID = 'from-env';
    expect(resolveSessionId(db)).toBe('from-env');

    // Explicit still beats everything.
    expect(resolveSessionId(db, 'explicit')).toBe('explicit');
  });

  it('ignores blank ids rather than writing rows under an empty key', () => {
    setCurrentSession(db, 'from-hook');
    expect(resolveSessionId(db, '   ')).toBe('from-hook');
  });
});

describe('log_session_concepts', () => {
  it('logs seeded concepts without inventing new ones', () => {
    const res = logAuthWork();
    expect(res.logged).toEqual(['httponly-cookies', 'jwt-structure', 'csrf']);
    expect(res.created).toEqual([]);
  });

  it('creates concepts it has never seen, marked as llm-authored', () => {
    const res = call<any>(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'Fastify Hooks', domain: 'node-backend', tier: 3, context: 'registered an onRequest hook' }],
    });
    expect(res.created).toEqual(['fastify-hooks']);
    const row = db.prepare('SELECT source, domain, tier FROM concepts WHERE slug = ?').get('fastify-hooks');
    expect(row).toEqual({ source: 'llm', domain: 'node-backend', tier: 3 });
  });

  it('folds a near-duplicate slug into the existing concept (G6)', () => {
    const res = call<any>(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'jwt-structure-basics', context: 'decoded the token' }],
    });
    expect(res.created).toEqual([]);
    expect(res.matched).toEqual([{ requested: 'jwt-structure-basics', resolved: 'jwt-structure' }]);
  });

  it('does not fold genuinely different concepts together', () => {
    const res = call<any>(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'websocket-heartbeats', context: 'ping/pong loop' }],
    });
    expect(res.created).toEqual(['websocket-heartbeats']);
  });

  it('caps how many new concepts one session may mint (PRD §15)', () => {
    configure({ max_new_concepts_per_session: 2, min_minutes_between_quizzes: 0 });
    const res = call<any>(logSessionConcepts, {
      session_id: SESSION,
      concepts: [
        { slug: 'novel-alpha' },
        { slug: 'novel-beta' },
        { slug: 'novel-gamma' },
        { slug: 'novel-delta' },
      ],
    });
    expect(res.created).toHaveLength(2);
    expect(res.capped).toBe(2);
  });

  it('keeps the first context when the same concept is logged twice', () => {
    call(logSessionConcepts, { session_id: SESSION, concepts: [{ slug: 'csrf', context: 'first' }] });
    call(logSessionConcepts, { session_id: SESSION, concepts: [{ slug: 'csrf' }] });
    const row = db
      .prepare('SELECT context FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id WHERE c.slug = ?')
      .get('csrf') as { context: string };
    expect(row.context).toBe('first');
  });
});

describe('get_session_quiz_plan', () => {
  it('asks about the session\'s unmastered concepts, with their code context', () => {
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBe(3);
    expect(plan.concepts.map((c: any) => c.slug).sort()).toEqual(['csrf', 'httponly-cookies', 'jwt-structure']);
    expect(plan.concepts.find((c: any) => c.slug === 'httponly-cookies').context).toMatch(/auth\.ts/);
    expect(plan.concepts.every((c: any) => c.reason === 'unmastered')).toBe(true);
  });

  it('never re-asks a concept the learner has mastered', () => {
    logAuthWork();
    master('jwt-structure');

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.concepts.map((c: any) => c.slug)).not.toContain('jwt-structure');
  });

  it('honors the max cap', () => {
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION, max: 2 });
    expect(plan.concepts).toHaveLength(2);
  });

  it('defaults the cap to max_questions_per_task', () => {
    configure({ max_questions_per_task: 1, min_minutes_between_quizzes: 0 });
    logAuthWork();
    expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).concepts).toHaveLength(1);
  });

  it('escalates the tier for a concept the learner keeps nailing (G3)', () => {
    // Mastered in an earlier session, and now due again — which is the only way
    // a mastered concept resurfaces. Within one session it stays spent.
    master('jwt-structure', 'sess-last-week');
    logAuthWork();
    db.prepare('UPDATE mastery SET next_review = ? WHERE concept_id = (SELECT id FROM concepts WHERE slug = ?)')
      .run(new Date(Date.now() - 86_400_000).toISOString(), 'jwt-structure');

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    const jwt = plan.concepts.find((c: any) => c.slug === 'jwt-structure');
    expect(jwt.reason).toBe('due_review');
    expect(jwt.tier_to_ask).toBe(3); // asked at 2, nailed it, so ask harder
  });

  it('does not re-offer a concept already answered in this session', () => {
    logAuthWork();
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'why is the CSRF token needed here?',
      answer: 'hesitant but right',
      grade: 3,
      difficulty: 2,
    });

    // Grade 3 leaves it unmastered, so the old selection would hand it straight
    // back — asking the same thing twice inside one session.
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION, max: 10 });
    expect(plan.concepts.map((c: any) => c.slug)).not.toContain('csrf');
  });

  it('says so when everything in the session has already been asked about', () => {
    call(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'csrf', context: 'added a token check' }],
    });
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'what does the token prove?',
      grade: 1,
      difficulty: 1,
    });

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBe(0);
    expect(plan.reason).toBe('already_covered');
  });

  it('hands back the questions already asked, so none of them is asked again', () => {
    master('jwt-structure', 'sess-old');
    logAuthWork();
    db.prepare('UPDATE mastery SET next_review = ? WHERE concept_id = (SELECT id FROM concepts WHERE slug = ?)')
      .run(new Date(Date.now() - 86_400_000).toISOString(), 'jwt-structure');

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    const jwt = plan.concepts.find((c: any) => c.slug === 'jwt-structure');
    expect(jwt.asked_before.map((a: any) => a.question)).toContain('about jwt-structure');
    expect(jwt.asked_before[0]).toMatchObject({ tier: 2, grade: 5 });
  });

  it('carries the concept description, so a question can be about the concept', () => {
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    for (const c of plan.concepts) expect(typeof c.description).toBe('string');
  });

  it('reports unmet prerequisites and asks about foundations first', () => {
    call(logSessionConcepts, {
      session_id: SESSION,
      concepts: [
        { slug: 'jwt-structure', context: 'signed the access token' },
        { slug: 'http-statelessness', context: 'why the token exists at all' },
      ],
    });

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    const first = plan.concepts[0];
    // http-statelessness is a tier-1 root: nothing is missing underneath it.
    expect(first.slug).toBe('http-statelessness');
    expect(first.prereqs_unmet).toEqual([]);
    const jwt = plan.concepts.find((c: any) => c.slug === 'jwt-structure');
    expect(jwt.prereqs_unmet.length).toBeGreaterThan(0);
  });

  it('honors an explicit request during the cooldown', () => {
    configure({ min_minutes_between_quizzes: 30, mode: 'ambient' });
    logAuthWork();
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'q',
      grade: 4,
      difficulty: 2,
    });

    expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).reason).toBe('cooldown');
    const asked = call<any>(getSessionQuizPlan, { session_id: SESSION, ignore_cooldown: true });
    expect(asked.questions_needed).toBeGreaterThan(0);
  });

  it('plans a topic quiz on a domain the session never touched', () => {
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION, domain: 'git', max: 3 });
    expect(plan.questions_needed).toBe(3);
    expect(plan.concepts.every((c: any) => c.reason === 'topic')).toBe(true);
  });

  it('leaves a mastered concept out of a topic quiz unless review is due', () => {
    master('git-commit', 'sess-old');
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION, domain: 'git', max: 10 });
    expect(plan.concepts.map((c: any) => c.slug)).not.toContain('git-commit');

    db.prepare('UPDATE mastery SET next_review = ? WHERE concept_id = (SELECT id FROM concepts WHERE slug = ?)')
      .run(new Date(Date.now() - 86_400_000).toISOString(), 'git-commit');
    const due = call<any>(getSessionQuizPlan, { session_id: SESSION, domain: 'git', max: 10 });
    expect(due.concepts.map((c: any) => c.slug)).toContain('git-commit');
  });

  it('plans around named slugs', () => {
    const plan = call<any>(getSessionQuizPlan, {
      session_id: SESSION,
      slugs: ['csrf', 'jwt-structure'],
    });
    expect(plan.concepts.map((c: any) => c.slug).sort()).toEqual(['csrf', 'jwt-structure']);
  });

  it('pays down review debt from the same domain once session work is covered', () => {
    logAuthWork();
    master('httponly-cookies');
    master('jwt-structure');
    master('csrf');

    // An unrelated web-auth concept that fell overdue.
    const id = (db.prepare('SELECT id FROM concepts WHERE slug = ?').get('pkce') as { id: number }).id;
    db.prepare(
      'INSERT INTO mastery (concept_id, score, ease, interval_d, reps, next_review) VALUES (?, 0.5, 2.5, 1, 1, ?)',
    ).run(id, new Date(Date.now() - 86_400_000).toISOString());

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.concepts.map((c: any) => c.slug)).toContain('pkce');
    expect(plan.concepts.find((c: any) => c.slug === 'pkce').reason).toBe('domain_review');
  });

  it('goes quiet in ambient mode during the cooldown (G5)', () => {
    configure({ min_minutes_between_quizzes: 30, mode: 'ambient' });
    logAuthWork();
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'q',
      answer: 'a',
      grade: 4,
      difficulty: 2,
    });

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBe(0);
    expect(plan.reason).toBe('cooldown');
  });

  it('ignores the cooldown in enforced mode, or the gate could never be passed', () => {
    configure({ min_minutes_between_quizzes: 30, mode: 'enforced' });
    logAuthWork();
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'q',
      answer: 'a',
      grade: 4,
      difficulty: 2,
    });

    expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).questions_needed).toBeGreaterThan(0);
  });

  it('asks nothing at all when the mode is off', () => {
    configure({ mode: 'off' });
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBe(0);
    expect(plan.reason).toBe('mode_off');
  });
});

describe('record_attempt', () => {
  it('moves the score and schedules the next review', () => {
    logAuthWork();
    const res = call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'why SameSite=Lax here?',
      answer: 'it stops the browser attaching the cookie to cross-site POSTs',
      grade: 5,
      difficulty: 3,
      feedback: 'right — and it is why the CSRF token became optional',
    });

    expect(res.new_score).toBe(1);
    expect(res.reps).toBe(1);
    expect(res.interval_days).toBe(1);
    expect(Date.parse(res.next_review)).toBeGreaterThan(Date.now());
  });

  it('records a skip as grade 0 without crediting the learner', () => {
    logAuthWork();
    const res = call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'q',
      grade: 0,
      difficulty: 2,
      feedback: 'skipped',
    });
    expect(res.new_score).toBe(0);
    expect(res.known).toBe(false);
  });

  // A concept attempted in this session is filtered out of this session's plan,
  // so the question these tests actually ask is the real one: what does the NEXT
  // session see? Hence a fresh session id reading the same concept by slug.
  const nextSessionView = (slug: string) => {
    const plan = call<any>(getSessionQuizPlan, {
      session_id: `${SESSION}-tomorrow`,
      slugs: [slug],
      ignore_cooldown: true,
    });
    return plan.concepts.find((c: any) => c.slug === slug);
  };

  it('tells a blank apart from a decline, since both are grade 0', () => {
    logAuthWork();
    const blank = call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'why SameSite=Lax here?',
      grade: 0,
      difficulty: 2,
      outcome: 'dont_know',
      feedback: 'taught it: Lax withholds the cookie on cross-site POSTs',
    });
    expect(blank.new_score).toBe(0);

    // The whole point of the column: tomorrow's question must know it is a
    // follow-up to an explanation, not a first encounter.
    const csrf = nextSessionView('csrf');
    expect(csrf.already_taught).toBe(true);
    expect(csrf.asked_before[0].outcome).toBe('dont_know');
    expect(csrf.asked_before[0].taught).toBe(true);
  });

  it('does not mark a decline as taught', () => {
    logAuthWork();
    call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'why SameSite=Lax here?',
      grade: 0,
      difficulty: 2,
      outcome: 'declined',
    });
    const csrf = nextSessionView('csrf');
    expect(csrf.asked_before[0].outcome).toBe('declined');
    expect(csrf.already_taught).toBe(false);
  });

  it('leaves outcome unknown rather than guessing when the tutor omits it', () => {
    logAuthWork();
    call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'why SameSite=Lax here?',
      grade: 0,
      difficulty: 2,
    });
    const csrf = nextSessionView('csrf');
    expect(csrf.asked_before[0].outcome).toBe(null);
    expect(csrf.already_taught).toBe(false);
  });

  it('flags a question the learner has already been asked (PRD goal 2)', () => {
    const ask = (question: string) =>
      call<any>(recordAttempt, {
        session_id: SESSION,
        slug: 'csrf',
        question,
        answer: 'a',
        grade: 4,
        difficulty: 2,
      });

    expect(ask('What does the CSRF token prove?').repeat_question).toBe(false);
    expect(ask('What breaks if the token is omitted?').repeat_question).toBe(false);
    // Punctuation and casing are not a new question.
    expect(ask('what does the csrf token prove').repeat_question).toBe(true);
  });

  it('refuses a concept that does not exist rather than inventing one', () => {
    const res = call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'not-a-real-concept',
      question: 'q',
      grade: 4,
      difficulty: 2,
    });
    expect(res.error).toBe('unknown_concept');
  });

  it('counts an attempt on review debt toward this session', () => {
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'pkce',
      question: 'q',
      answer: 'a',
      grade: 4,
      difficulty: 3,
    });
    const n = db.prepare('SELECT count(*) n FROM session_concepts WHERE session_id = ?').get(SESSION) as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('gate arithmetic (G8)', () => {
  it('opens with a bar set by the work, capped at questions per task', () => {
    configure({ max_questions_per_task: 2, min_minutes_between_quizzes: 0 });
    const res = logAuthWork();
    expect(res.gate.required).toBe(2);
    expect(res.gate.answered).toBe(0);
    expect(res.gate.passed).toBe(false);
  });

  it('passes once enough concepts are answered correctly', () => {
    configure({ max_questions_per_task: 2, pass_threshold: 1, min_minutes_between_quizzes: 0 });
    logAuthWork();

    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 4, difficulty: 2 });
    expect(call<any>(getGateStatus, { session_id: SESSION }).passed).toBe(false);

    call(recordAttempt, { session_id: SESSION, slug: 'jwt-structure', question: 'q', answer: 'a', grade: 4, difficulty: 2 });
    expect(call<any>(getGateStatus, { session_id: SESSION }).passed).toBe(true);
  });

  it('counts a skip as answered but never as passing — the gate is not theater', () => {
    configure({ max_questions_per_task: 2, pass_threshold: 1, min_minutes_between_quizzes: 0 });
    logAuthWork();

    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', grade: 0, difficulty: 2 });
    call(recordAttempt, { session_id: SESSION, slug: 'jwt-structure', question: 'q', grade: 0, difficulty: 2 });

    const gate = call<any>(getGateStatus, { session_id: SESSION });
    expect(gate.answered).toBe(2);
    expect(gate.passed).toBe(false);
  });

  it('treats a barely-passing answer as passing, but not a wrong one', () => {
    configure({ max_questions_per_task: 1, pass_threshold: 1, min_minutes_between_quizzes: 0 });
    logAuthWork();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 2, difficulty: 2 });
    expect(call<any>(getGateStatus, { session_id: SESSION }).passed).toBe(false);

    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q2', answer: 'a', grade: 3, difficulty: 2 });
    expect(call<any>(getGateStatus, { session_id: SESSION }).passed).toBe(true);
  });

  it('never lowers the bar once it is set', () => {
    configure({ max_questions_per_task: 3, min_minutes_between_quizzes: 0 });
    logAuthWork();
    expect(call<any>(getGateStatus, { session_id: SESSION }).required).toBe(3);

    master('csrf');
    master('jwt-structure');
    master('httponly-cookies');

    expect(call<any>(getGateStatus, { session_id: SESSION }).required).toBe(3);
  });

  it('passes trivially when there is nothing to prove', () => {
    expect(call<any>(getGateStatus, { session_id: 'empty-session' }).passed).toBe(true);
  });

  it('keeps sessions independent', () => {
    logAuthWork('sess-a');
    logAuthWork('sess-b');
    master('csrf', 'sess-a');

    expect(call<any>(getGateStatus, { session_id: 'sess-a' }).answered).toBe(1);
    expect(call<any>(getGateStatus, { session_id: 'sess-b' }).answered).toBe(0);
  });
});

describe('get_learner_profile', () => {
  it('starts with everything unseen', () => {
    const p = call<any>(getLearnerProfile, { domain: 'web-auth' });
    expect(p.domains[0].known).toBe(0);
    expect(p.domains[0].unseen).toBeGreaterThan(20);
    expect(p.suggested_tier).toBe(1);
  });

  it('moves a concept from unseen to learning to known', () => {
    logAuthWork();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 5, difficulty: 3 });
    let p = call<any>(getLearnerProfile, { domain: 'web-auth' });
    expect(p.domains[0].learning).toBe(1);
    expect(p.domains[0].known).toBe(0);

    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q2', answer: 'a', grade: 5, difficulty: 3 });
    p = call<any>(getLearnerProfile, { domain: 'web-auth' });
    expect(p.domains[0].known).toBe(1);
  });

  it('surfaces weak concepts', () => {
    logAuthWork();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'no idea', grade: 1, difficulty: 2 });
    expect(call<any>(getLearnerProfile, { domain: 'web-auth' }).weak).toContain('csrf');
  });

  it('respects domains_enabled', () => {
    configure({ domains_enabled: ['react'], min_minutes_between_quizzes: 0 });
    const p = call<any>(getLearnerProfile, {});
    expect(p.domains.map((d: any) => d.domain)).toEqual(['react']);
  });

  it('names the mastered concepts, not just a count of them', () => {
    master('csrf');
    const profile = call<any>(getLearnerProfile, { domain: 'web-auth' });
    expect(profile.known).toContain('csrf');
    expect(profile.known_total).toBe(1);
  });

  it('reports the mode so the tutor knows how hard to push', () => {
    configure({ mode: 'enforced' });
    expect(call<any>(getLearnerProfile, {}).mode).toBe('enforced');
  });
});

describe('upsert_concepts', () => {
  it('creates a concept with edges to existing ones', () => {
    const res = call<any>(upsertConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'passkeys', name: 'Passkeys', domain: 'web-auth', tier: 4 }],
      edges: [{ from: 'password-hashing', to: 'passkeys', relation: 'prerequisite_of' }],
    });
    expect(res.created).toEqual(['passkeys']);
    expect(res.edges_added).toBe(1);
  });

  it('reports the canonical slug when it folds a near-duplicate', () => {
    const res = call<any>(upsertConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'refresh-token-rotation-strategy' }],
    });
    expect(res.created).toEqual([]);
    expect(res.matched[0].resolved).toBe('refresh-token-rotation');
  });

  it('rejects a slug that cannot be normalized', () => {
    const res = call<any>(upsertConcepts, { session_id: SESSION, concepts: [{ slug: '!!!' }] });
    expect(res.rejected[0].reason).toBe('invalid_slug');
  });

  it('ignores a self-edge', () => {
    const res = call<any>(upsertConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'csrf' }],
      edges: [{ from: 'csrf', to: 'csrf', relation: 'related_to' }],
    });
    expect(res.edges_added).toBe(0);
  });

  it('is idempotent for edges', () => {
    const args = {
      session_id: SESSION,
      concepts: [{ slug: 'csrf' }],
      edges: [{ from: 'csrf', to: 'samesite-cookies', relation: 'related_to' as const }],
    };
    expect(call<any>(upsertConcepts, args).edges_added).toBe(1);
    expect(call<any>(upsertConcepts, args).edges_added).toBe(0);
  });
});

describe('get_concept_graph', () => {
  it('returns prerequisites before the concepts that depend on them (G10)', () => {
    const g = call<any>(getConceptGraph, { domain: 'web-auth' });
    const order = g.concepts.map((c: any) => c.slug);
    expect(order.indexOf('http-cookies')).toBeLessThan(order.indexOf('cookie-attributes'));
    expect(order.indexOf('cookie-attributes')).toBeLessThan(order.indexOf('httponly-cookies'));
    expect(order.indexOf('jwt-structure')).toBeLessThan(order.indexOf('jwt-signing'));
  });

  it('annotates mastery on request', () => {
    logAuthWork();
    master('csrf');
    const g = call<any>(getConceptGraph, { domain: 'web-auth', include_mastery: true });
    expect(g.concepts.find((c: any) => c.slug === 'csrf').known).toBe(true);
  });

  it('can drop what the learner already knows', () => {
    logAuthWork();
    master('csrf');
    const g = call<any>(getConceptGraph, { domain: 'web-auth', unmastered_only: true });
    expect(g.concepts.map((c: any) => c.slug)).not.toContain('csrf');
  });

  it('returns empty for an unknown domain instead of failing', () => {
    expect(call<any>(getConceptGraph, { domain: 'cobol' }).concepts).toEqual([]);
  });
});

describe('config tools', () => {
  it('reads the effective config', () => {
    configure({ mode: 'enforced', min_minutes_between_quizzes: 0 });
    expect(call<any>(getConfig, {}).config.mode).toBe('enforced');
  });

  it('writes global config', () => {
    call(setConfig, { mode: 'enforced' });
    expect(call<any>(getConfig, {}).config.mode).toBe('enforced');
  });

  it('refuses a repo write with no repo to write to', () => {
    expect(call<any>(setConfig, { scope: 'repo', mode: 'enforced' }).error).toBe('no_repo_root');
  });

  it('exposes the Stop-hook block cap that the hook actually reads', () => {
    expect(call<any>(getConfig).config.max_stop_blocks_per_session).toBe(3);
    call(setConfig, { max_stop_blocks_per_session: 1 });
    expect(call<any>(getConfig).config.max_stop_blocks_per_session).toBe(1);
  });

  it('says so when asked to change nothing', () => {
    expect(call<any>(setConfig, {}).error).toBe('nothing_to_set');
  });
});
