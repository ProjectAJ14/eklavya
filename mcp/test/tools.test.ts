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
import { gateRetryConcepts } from '../src/store.js';
import { getConfig, setConfig } from '../src/tools/config_tools.js';
import { resolveSessionId, setCurrentSession, isSessionOff, FALLBACK_SESSION_ID } from '../src/session.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let home = '';
let cwd = '';
const envBackup = { ...process.env };

const SESSION = 'sess-1';

function configure(patch: Record<string, unknown>): void {
  // Pin `project` unless a test says otherwise. The shipped default is `concept`,
  // which deliberately widens a plan past the session's own concepts — right for
  // a learner, wrong for tests that are asserting exactly which session concepts
  // the planner picked. The default's own behaviour is covered by the `focus`
  // suite below, which sets it explicitly.
  //
  // `end` cadence for the same reason: the shipped default caps a plan at one
  // question, which is right for a learner and useless for a test asserting the
  // order and contents of a whole plan. The cap has its own suite below.
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ focus: 'project', cadence: 'end', ...patch }),
  );
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

/** Makes `cwd` a git checkout. The backlog only exists inside a project. */
function inProject() {
  fs.mkdirSync(path.join(cwd, '.git'));
}

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

  it('resolves per checkout, so a tool call cannot land in another repo\'s session', () => {
    // The pointer is global state in a database every checkout shares, and the
    // tools tell the model to omit `session_id`. Before this was keyed on the
    // checkout, a model still working in one repo resolved to whichever session
    // its developer had most recently typed in — so its log_session_concepts
    // call filed that repo's work under the other repo's session, and the other
    // session then quizzed its developer on code from a project they were not in.
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-b-'));
    fs.mkdirSync(path.join(a, '.git'));
    fs.mkdirSync(path.join(b, '.git'));
    try {
      setCurrentSession(db, 'session-in-a', a);
      // b types last — which used to be all it took to capture a's tool calls.
      setCurrentSession(db, 'session-in-b', b);

      expect(resolveSessionId(db, undefined, a)).toBe('session-in-a');
      expect(resolveSessionId(db, undefined, b)).toBe('session-in-b');
    } finally {
      fs.rmSync(a, { recursive: true, force: true });
      fs.rmSync(b, { recursive: true, force: true });
    }
  });
});

describe('log_session_concepts', () => {
  it('logs seeded concepts without inventing new ones', () => {
    const res = logAuthWork();
    expect(res.logged).toEqual(['httponly-cookies', 'jwt-structure', 'csrf']);
    expect(res.created).toEqual([]);
    // Nothing was created, so there is no debt to report.
    expect(res.next_action).toBeUndefined();
  });

  // The tutor skill already asks for this, but it is model-invoked and may never
  // load — the same gap that forced the concept-logging directive into the
  // SessionStart banner. Saying it in the response reaches the model regardless.
  it('names the upsert_concepts debt in the response when it mints bare concepts', () => {
    const res = call<any>(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'raft-leader-election', context: 'wrote the election timeout in raft.ts' }],
    });
    expect(res.created).toEqual(['raft-leader-election']);
    expect(res.next_action).toContain('upsert_concepts');
    expect(res.next_action).toContain('raft-leader-election');
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

  it('caps how many new concepts one session may mint', () => {
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
  // The model reads this on every interleaved question; "ask, grade, back to
  // work" alone left the developer never told whether they were right.
  it('tells the model to give the verdict before getting back to the work', () => {
    expect(getSessionQuizPlan.description).toMatch(/grade it, tell them whether they were right[^.]*get back to the work/);
  });

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

  // The bug this suite exists for: `interleaved` promised a question at a time
  // and the planner handed back four, which the tutor then asked end to end at
  // the moment the developer wanted to be finished.
  describe('cadence caps the plan', () => {
    it('plans one question under the interleaved cadence', () => {
      configure({ cadence: 'interleaved', min_minutes_between_quizzes: 0 });
      logAuthWork();
      const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
      expect(plan.questions_needed).toBe(1);
    });

    it('plans the whole budget under the end cadence', () => {
      configure({ cadence: 'end', min_minutes_between_quizzes: 0 });
      logAuthWork();
      expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).questions_needed).toBe(3);
    });

    // Decision G5: a pacing rule must not be the thing that makes a commit
    // impossible. The gate needs several passing answers and the Stop hook only
    // re-arms on new work, so enforced quizzing keeps the whole plan.
    it('plans the whole budget when enforced, cadence notwithstanding', () => {
      configure({ quiz: { enabled: true, enforced: true }, cadence: 'interleaved', min_minutes_between_quizzes: 0 });
      logAuthWork();
      expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).questions_needed).toBe(3);
    });

    it('still plans the budget when the developer asked to be quizzed', () => {
      configure({ cadence: 'interleaved', min_minutes_between_quizzes: 0 });
      logAuthWork();
      // An explicit max, or a named topic, is a request rather than an ambient
      // interruption — the cap is there to stop nagging, not to refuse.
      expect(
        call<any>(getSessionQuizPlan, { session_id: SESSION, max: 3 }).questions_needed,
      ).toBe(3);
      expect(
        call<any>(getSessionQuizPlan, { session_id: SESSION, domain: 'web-auth' })
          .questions_needed,
      ).toBeGreaterThan(1);
    });
  });

  it('escalates the tier for a concept the learner keeps nailing (G3)', () => {
    // Pinned past `easy`, because that band caps at tier 2 and would clamp the
    // escalation this test is about. The clamp has its own tests below.
    configure({ min_minutes_between_quizzes: 0, difficulty: 'medium' });
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
    configure({ min_minutes_between_quizzes: 30, quiz: { enabled: true, enforced: false } });
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

    // An unrelated web-auth concept, answered in this project, that fell overdue.
    call(recordAttempt, {
      session_id: 'earlier-session',
      slug: 'pkce',
      question: 'about pkce',
      answer: 'a',
      grade: 2,
      difficulty: 2,
    });
    const id = (db.prepare('SELECT id FROM concepts WHERE slug = ?').get('pkce') as { id: number }).id;
    db.prepare('UPDATE mastery SET next_review = ? WHERE concept_id = ?').run(
      new Date(Date.now() - 86_400_000).toISOString(),
      id,
    );

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.concepts.map((c: any) => c.slug)).toContain('pkce');
    expect(plan.concepts.find((c: any) => c.slug === 'pkce').reason).toBe('project_review');
  });

  // --- the backlog: only what was asked and not answered ---------------------
  // A concept enters the backlog by being asked. A decline, a blank or a miss
  // resets its review to a day out, and the next quiz in this project asks it
  // again. Work that was logged and never asked is not carried anywhere.

  function overdue(slug: string) {
    db.prepare(
      'UPDATE mastery SET next_review = ? WHERE concept_id = (SELECT id FROM concepts WHERE slug = ?)',
    ).run(new Date(Date.now() - 60_000).toISOString(), slug);
  }

  function decline(slug: string, session = 'earlier-session') {
    call(recordAttempt, {
      session_id: session,
      slug,
      question: `about ${slug}`,
      grade: 0,
      difficulty: 2,
      outcome: 'declined',
    });
  }

  it('asks a question the learner declined earlier in this project, in any domain', () => {
    inProject();
    decline('git-commit');
    overdue('git-commit');

    logAuthWork();
    master('httponly-cookies');
    master('jwt-structure');
    master('csrf');

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.concepts.find((c: any) => c.slug === 'git-commit')?.reason).toBe('project_review');
  });

  it('waits for the review date before asking a declined question again', () => {
    inProject();
    decline('git-commit');
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBe(0);
  });

  it('never carries over work an earlier session logged and no question reached', () => {
    inProject();
    call(logSessionConcepts, { session_id: 'earlier-session', concepts: [{ slug: 'pkce' }] });

    expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).questions_needed).toBe(0);

    logAuthWork();
    master('httponly-cookies');
    master('jwt-structure');
    master('csrf');
    const slugs = call<any>(getSessionQuizPlan, { session_id: SESSION }).concepts.map((c: any) => c.slug);
    expect(slugs).not.toContain('pkce');
  });

  it('puts the session the developer is actually in ahead of review', () => {
    inProject();
    configure({ min_minutes_between_quizzes: 0, max_questions_per_task: 2 });
    decline('pkce');
    overdue('pkce');
    logAuthWork();

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.concepts).toHaveLength(2);
    expect(plan.concepts.every((c: any) => c.reason === 'unmastered')).toBe(true);
  });

  it('outside a project, serves review only from the domains this session touched', () => {
    // Every session with no git root shares one project key, so "this project"
    // would mean any folder at all.
    decline('git-commit');
    overdue('git-commit');

    expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).questions_needed).toBe(0);

    logAuthWork();
    const slugs = call<any>(getSessionQuizPlan, { session_id: SESSION }).concepts.map((c: any) => c.slug);
    expect(slugs).toContain('httponly-cookies');
    expect(slugs).not.toContain('git-commit');
  });

  it('never offers review debt from another project, but points at it', () => {
    // One database serves every checkout. A quiz run in this one must not ask
    // about work answered in another, even when this session logged nothing.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-other-'));
    fs.mkdirSync(path.join(other, '.git'));
    try {
      call(logSessionConcepts, { cwd: other, session_id: 'other-session', concepts: [{ slug: 'git-commit' }] });
      call(recordAttempt, {
        cwd: other,
        session_id: 'other-reviewed',
        slug: 'pkce',
        question: 'about pkce',
        answer: 'a',
        grade: 4,
        difficulty: 2,
      });
      db.prepare("UPDATE mastery SET next_review = '2000-01-01T00:00:00Z'").run();

      const empty = call<any>(getSessionQuizPlan, { session_id: SESSION });
      expect(empty.questions_needed).toBe(0);
      // Only pkce: git-commit was logged there but never asked, so nothing waits on it.
      expect(empty.pending_elsewhere).toEqual([{ project: fs.realpathSync(other), pending: 1 }]);

      logAuthWork();
      master('httponly-cookies');
      master('jwt-structure');
      master('csrf');
      const slugs = call<any>(getSessionQuizPlan, { session_id: SESSION }).concepts.map((c: any) => c.slug);
      expect(slugs).not.toContain('git-commit');
      expect(slugs).not.toContain('pkce');
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('goes quiet during the cooldown when unenforced (G5)', () => {
    configure({ min_minutes_between_quizzes: 30, quiz: { enabled: true, enforced: false } });
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

  // The clock the cooldown reads has to be the one the Stop hook paces on, or the
  // hook clears its 4-minute checkpoint gap, blocks the turn, and this function
  // then refuses on a 20-minute quiz gap -- which reads to the model as being told
  // to teach and handed nothing to teach.
  it('paces interleaved on the checkpoint clock, never the quiz clock', () => {
    configure({
      quiz: { enabled: true, enforced: false },
      cadence: 'interleaved',
      min_minutes_between_quizzes: 0,
      min_minutes_between_checkpoints: 30,
    });
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
    expect(plan.reason).toBe('cooldown');
    expect(plan.minutes_remaining).toBeGreaterThan(20);
  });

  it('paces the end cadence on the quiz clock, never the checkpoint one', () => {
    configure({
      quiz: { enabled: true, enforced: false },
      cadence: 'end',
      min_minutes_between_quizzes: 30,
      min_minutes_between_checkpoints: 0,
    });
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
    expect(plan.reason).toBe('cooldown');
    expect(plan.minutes_remaining).toBeGreaterThan(20);
  });

  it('ignores the cooldown when enforced, or the gate could never be passed', () => {
    configure({ min_minutes_between_quizzes: 30, quiz: { enabled: true, enforced: true } });
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

  it('asks nothing at all when questions are off', () => {
    configure({ quiz: { enabled: false, enforced: false } });
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBe(0);
    expect(plan.reason).toBe('quiz_disabled');
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

  it('keeps already_taught after newer attempts push the blank out of the window', () => {
    logAuthWork();
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'why SameSite=Lax here?',
      grade: 0,
      difficulty: 2,
      outcome: 'dont_know',
      feedback: 'taught it',
    });
    // asked_before only keeps the last 3, so three newer attempts evict the
    // blank. The flag must survive that: it is a fact about the learner, not a
    // property of the visible slice.
    for (const q of ['q2', 'q3', 'q4']) {
      call(recordAttempt, {
        session_id: SESSION,
        slug: 'csrf',
        question: q,
        answer: 'partial',
        grade: 2,
        difficulty: 2,
        outcome: 'answered',
      });
    }

    const csrf = nextSessionView('csrf');
    expect(csrf.asked_before.every((a: any) => !a.taught)).toBe(true);
    expect(csrf.already_taught).toBe(true);
  });

  // Recognition is not recall. Grade 5 means "explained why", which picking one
  // of four cannot show — and one in four is a coin.
  it('caps a multiple-choice answer at 4, and says it did', () => {
    logAuthWork();
    const res = call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'What does SameSite=Lax actually withhold?',
      answer: 'The cookie on cross-site POSTs',
      grade: 5,
      difficulty: 2,
      format: 'mcq',
      options: ['a', 'b', 'c', 'd'],
      outcome: 'answered',
    });
    expect(res.recorded_grade).toBe(4);
    expect(res.grade_capped).toBe(true);
    expect(
      (db.prepare('SELECT grade FROM attempts WHERE concept_id = (SELECT id FROM concepts WHERE slug = ?)').get('csrf') as any)
        .grade,
    ).toBe(4);
  });

  it('does not cap an answer they explained in their own words', () => {
    logAuthWork();
    const res = call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'Why SameSite=Lax rather than Strict here?',
      answer: 'a full explanation',
      grade: 5,
      difficulty: 2,
      // No format: they picked "Other" and typed a real explanation, which is
      // free recall and not what the multiple-choice cap is for.
      outcome: 'answered',
    });
    expect(res.recorded_grade).toBe(5);
    expect(res.grade_capped).toBeUndefined();
  });

  it('leaves a capped grade able to reach mastery — it slows the claim, not blocks it', () => {
    logAuthWork();
    for (const q of ['q1', 'q2']) {
      call(recordAttempt, {
        session_id: SESSION,
        slug: 'csrf',
        question: q,
        answer: 'right option',
        grade: 5,
        difficulty: 2,
        format: 'mcq',
        options: ['a', 'b', 'c', 'd'],
        outcome: 'answered',
      });
    }
    const profile = call<any>(getLearnerProfile, {});
    expect(profile.known).toContain('csrf');
  });

  // The stem is what gets fingerprinted. Options baked into it would make every
  // reshuffle look like a brand-new question and quietly undo
  // "never ask the same question twice".
  it('keeps options out of the question text so reshuffling cannot defeat the repeat check', () => {
    logAuthWork();
    const stem = 'What does SameSite=Lax actually withhold?';
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: stem,
      answer: 'b',
      grade: 4,
      difficulty: 2,
      format: 'mcq',
      options: ['first', 'second', 'third', 'fourth'],
      outcome: 'answered',
    });

    // Same stem, options in a different order: still the same question.
    const again = call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: stem,
      answer: 'b',
      grade: 4,
      difficulty: 2,
      format: 'mcq',
      options: ['fourth', 'first', 'third', 'second'],
      outcome: 'answered',
    });
    expect(again.repeat_question).toBe(true);

    const row = db
      .prepare(
        `SELECT question, options, format FROM attempts
          WHERE concept_id = (SELECT id FROM concepts WHERE slug = ?) ORDER BY id ASC LIMIT 1`,
      )
      .get('csrf') as { question: string; options: string; format: string };
    expect(row.question).toBe(stem);
    expect(row.format).toBe('mcq');
    expect(JSON.parse(row.options)).toEqual(['first', 'second', 'third', 'fourth']);
  });

  it('surfaces the format of past questions so the next one can vary', () => {
    logAuthWork();
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'a multiple choice question',
      answer: 'b',
      grade: 4,
      difficulty: 2,
      format: 'mcq',
      options: ['a', 'b', 'c', 'd'],
      outcome: 'answered',
    });
    const csrf = nextSessionView('csrf');
    expect(csrf.asked_before[0].format).toBe('mcq');
  });

  it('flags a question the learner has already been asked', () => {
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

// A blank grades 0 and burns the concept for the session, so a session answered
// entirely with "I don't know" used to leave the gate permanently unmet: the
// planner had nothing left to offer and the commit hook denied forever, while
// telling the developer to run a quiz that would refuse. These pin the way out.
describe('enforced gate retry', () => {
  const blankEverything = () => {
    logAuthWork();
    for (const slug of ['httponly-cookies', 'jwt-structure', 'csrf']) {
      call(recordAttempt, {
        session_id: SESSION,
        slug,
        question: `first question about ${slug}`,
        grade: 0,
        difficulty: 2,
        outcome: 'dont_know',
        feedback: 'taught it',
      });
    }
  };

  // The retry pass is guarded on `picked.length === 0`, so anything that fills
  // `picked` suppresses it. The backlog source would have, on every real database:
  // it runs immediately before, and a backlog answer is recorded with
  // `origin = 'review'` while the gate counts only `origin = 'work'` -- so it
  // cannot open the commit it just displaced the way out of.
  it('is not starved by a backlog of unasked work from other sessions', () => {
    configure({ quiz: { enabled: true, enforced: true }, min_minutes_between_quizzes: 0 });
    call(logSessionConcepts, {
      session_id: 'earlier-session',
      concepts: [{ slug: 'pkce' }, { slug: 'oauth2-authorization-code' }],
    });
    blankEverything();

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBeGreaterThan(0);
    expect(plan.concepts.every((c: any) => c.reason === 'gate_retry')).toBe(true);
    expect(plan.concepts.map((c: any) => c.slug)).not.toContain('pkce');
  });

  it('re-offers taught concepts once the gate is otherwise unreachable', () => {
    configure({ quiz: { enabled: true, enforced: true }, min_minutes_between_quizzes: 0 });
    blankEverything();
    expect(call<any>(getGateStatus, { session_id: SESSION }).passed).toBe(false);

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBeGreaterThan(0);
    expect(plan.concepts.every((c: any) => c.reason === 'gate_retry')).toBe(true);
    // Taught, then re-opened a tier lower — not a cold re-ask at the same pitch.
    expect(plan.concepts.every((c: any) => c.already_taught)).toBe(true);
    expect(plan.concepts.every((c: any) => c.tier_to_ask >= 1)).toBe(true);
    // Grounded in the same code the first question was about.
    expect(plan.concepts.some((c: any) => c.context)).toBeTruthy();
    // The retry must not repeat the question that produced the blank.
    expect(
      plan.concepts.every((c: any) =>
        c.asked_before.some((a: any) => a.question.startsWith('first question')),
      ),
    ).toBe(true);
  });

  it('lets a retried answer actually pass the gate', () => {
    configure({ quiz: { enabled: true, enforced: true }, min_minutes_between_quizzes: 0 });
    blankEverything();

    for (const slug of ['httponly-cookies', 'jwt-structure', 'csrf']) {
      call(recordAttempt, {
        session_id: SESSION,
        slug,
        question: `follow-up about ${slug}`,
        answer: 'the thing you just taught me',
        grade: 4,
        difficulty: 1,
        outcome: 'answered',
      });
    }
    expect(call<any>(getGateStatus, { session_id: SESSION }).passed).toBe(true);
  });

  it('does not re-offer a concept the learner declined', () => {
    configure({ quiz: { enabled: true, enforced: true }, min_minutes_between_quizzes: 0 });
    logAuthWork();
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'why SameSite=Lax here?',
      grade: 0,
      difficulty: 2,
      outcome: 'declined',
    });
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'jwt-structure',
      question: 'what is in the payload?',
      grade: 0,
      difficulty: 2,
      outcome: 'dont_know',
      feedback: 'taught it',
    });
    // httponly-cookies is untouched, so it is still a normal candidate; the
    // retry pass only runs once the ordinary plan is empty.
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'httponly-cookies',
      question: 'what does httpOnly stop?',
      grade: 0,
      difficulty: 2,
      outcome: 'dont_know',
      feedback: 'taught it',
    });

    const slugs = call<any>(getSessionQuizPlan, { session_id: SESSION }).concepts.map(
      (c: any) => c.slug,
    );
    expect(slugs).toContain('jwt-structure');
    expect(slugs).not.toContain('csrf');
  });

  it('leaves unenforced quizzing alone — no gate to deadlock, and re-offering is nagging', () => {
    configure({ quiz: { enabled: true, enforced: false }, min_minutes_between_quizzes: 0 });
    blankEverything();

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBe(0);
    expect(plan.reason).toBe('already_covered');
  });

  it('does not retry once the gate is passed', () => {
    configure({ quiz: { enabled: true, enforced: true }, min_minutes_between_quizzes: 0 });
    logAuthWork();
    for (const slug of ['httponly-cookies', 'jwt-structure', 'csrf']) {
      call(recordAttempt, {
        session_id: SESSION,
        slug,
        question: `about ${slug}`,
        answer: 'good',
        grade: 4,
        difficulty: 2,
        outcome: 'answered',
      });
    }
    expect(call<any>(getGateStatus, { session_id: SESSION }).passed).toBe(true);
    expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).questions_needed).toBe(0);
  });
});

/**
 * Every ask path calls the planner first -- both hooks, the quiz command and
 * the tutor subagent -- so this is the one place that can state a host-specific
 * rule to all of them. `writing-mcq.md` is a static file and cannot.
 */
describe('ask_attribution travels with the plan', () => {
  const ENTRYPOINT = 'CLAUDE_CODE_ENTRYPOINT';
  afterEach(() => delete process.env[ENTRYPOINT]);

  it('carries the chip rule in a terminal', () => {
    process.env[ENTRYPOINT] = 'cli';
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.ask_attribution).toContain('Header "Eklavya"');
    expect(plan.ask_attribution).not.toContain('[Eklavya]');
  });

  it('carries the stem prefix on a Claude Desktop host', () => {
    process.env[ENTRYPOINT] = 'claude-desktop';
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.ask_attribution).toContain('[Eklavya]');
  });
});

// `quiz` is whether and how hard Eklavya pushes; `focus` is what it teaches. The two
// are independent, and these pin that they stay that way.
describe('focus', () => {
  it('ships with concept as the default, not project', () => {
    // Not DEFAULT_CONFIG — the planner, with nothing configured at all. The
    // default is only real if it survives the whole config path.
    fs.rmSync(path.join(home, 'config.json'), { force: true });
    logAuthWork();

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.focus).toBe('concept');
    expect(plan.framing).toContain('transferable');
  });

  it('plans from the diff alone when project focus is set', () => {
    configure({ focus: 'project', min_minutes_between_quizzes: 0 });
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.focus).toBe('project');
    expect(plan.concepts.every((c: any) => c.reason === 'unmastered')).toBe(true);
    // project focus keeps the code: the diff is the subject.
    expect(plan.concepts.every((c: any) => c.context)).toBeTruthy();
    expect(plan.framing).toContain('diff');
  });

  it('widens past the session in concept focus, and withholds the code', () => {
    configure({ focus: 'concept', min_minutes_between_quizzes: 0 });
    // One concept only, so widening has somewhere to go inside max.
    call(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'csrf', context: 'chose SameSite=Lax on the session cookie' }],
    });

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    const widened = plan.concepts.filter((c: any) => c.reason === 'concept_widening');

    expect(plan.focus).toBe('concept');
    expect(widened.length).toBeGreaterThan(0);
    // Withheld on purpose: handing over a line of code invites the grounded
    // question this focus exists to avoid.
    expect(widened.every((c: any) => c.context === null)).toBe(true);
    expect(plan.framing).toContain('transferable');
  });

  it('plans from the topic in learn focus, and bridges to real work where it overlaps', () => {
    // A slug rather than a domain, so the concept is deterministically in the
    // plan: a 33-concept domain capped at max need not include any given one.
    configure({ focus: 'learn', focus_topic: 'csrf', min_minutes_between_quizzes: 0 });
    logAuthWork();

    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.focus).toBe('learn');
    expect(plan.topic).toBe('csrf');
    expect(plan.concepts.every((c: any) => c.reason === 'learn_topic')).toBe(true);
    // csrf is both in the topic and in this session's work, so it carries the
    // real code as the worked example.
    const csrf = plan.concepts.find((c: any) => c.slug === 'csrf');
    expect(csrf?.bridge_context).toContain('SameSite=Lax');
  });

  it('teaches topic concepts the session never touched, without inventing a bridge', () => {
    configure({ focus: 'learn', focus_topic: 'web-auth', min_minutes_between_quizzes: 0 });
    // No session work at all — learn focus does not depend on it.
    const plan = call<any>(getSessionQuizPlan, { session_id: 'untouched-session' });
    expect(plan.questions_needed).toBeGreaterThan(0);
    expect(plan.concepts.every((c: any) => c.bridge_context === undefined)).toBe(true);
  });

  it('refuses rather than guessing when learn focus has no topic', () => {
    configure({ focus: 'learn', min_minutes_between_quizzes: 0 });
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBe(0);
    expect(plan.reason).toBe('no_topic');
  });

  it('says so rather than inventing questions when the topic is not in the graph', () => {
    configure({ focus: 'learn', focus_topic: 'quantum-basket-weaving', min_minutes_between_quizzes: 0 });
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.questions_needed).toBe(0);
    expect(plan.reason).toBe('topic_unknown');
  });

  it('lets an explicitly named topic outrank the standing focus', () => {
    configure({ focus: 'learn', focus_topic: 'web-auth', min_minutes_between_quizzes: 0 });
    const plan = call<any>(getSessionQuizPlan, {
      session_id: SESSION,
      domain: 'react',
      ignore_cooldown: true,
    });
    expect(plan.concepts.every((c: any) => c.reason === 'topic')).toBe(true);
    expect(plan.concepts.every((c: any) => c.domain === 'react')).toBe(true);
  });

  it('is overridden per call without touching the config', () => {
    configure({ focus: 'project', min_minutes_between_quizzes: 0 });
    logAuthWork();
    expect(call<any>(getSessionQuizPlan, { session_id: SESSION, focus: 'concept' }).focus).toBe(
      'concept',
    );
    expect(call<any>(getConfig, {}).config.focus).toBe('project');
  });

  it('stays dormant when questions are off, whatever the focus says', () => {
    configure({ quiz: { enabled: false, enforced: false }, focus: 'learn', focus_topic: 'web-auth' });
    expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).reason).toBe('quiz_disabled');
  });
});

// `required` is set by the work; `passed` must be earned on the work. Widening
// (concept focus) and unrelated topics (learn focus) would otherwise let a gate
// be cleared without answering anything about the diff that raised it.
describe('gate counts work, not review debt', () => {
  it('does not let a widened concept satisfy the bar the work set', () => {
    configure({ max_questions_per_task: 1, pass_threshold: 1, min_minutes_between_quizzes: 0 });
    call(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'csrf', context: 'chose SameSite=Lax' }],
    });
    expect(call<any>(getGateStatus, { session_id: SESSION }).required).toBe(1);

    // A concept the work never touched, answered perfectly.
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'jwt-structure',
      question: 'q',
      answer: 'a',
      grade: 5,
      difficulty: 2,
    });

    const gate = call<any>(getGateStatus, { session_id: SESSION });
    expect(gate.answered).toBe(1); // review debt still counts as answered
    expect(gate.passed).toBe(false); // but cannot clear the work's bar

    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'q',
      answer: 'a',
      grade: 4,
      difficulty: 2,
    });
    expect(call<any>(getGateStatus, { session_id: SESSION }).passed).toBe(true);
  });

  it('does not let review debt raise a bar nothing can clear', () => {
    configure({ max_questions_per_task: 4, pass_threshold: 1, min_minutes_between_quizzes: 0 });
    call(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'csrf', context: 'chose SameSite=Lax' }],
    });
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'jwt-structure',
      question: 'q',
      answer: 'a',
      grade: 5,
      difficulty: 2,
    });
    // The mirror of the test above: `required` must stay on the work too, or
    // quizzing review debt makes the gate harder without making it passable.
    expect(call<any>(getGateStatus, { session_id: SESSION }).required).toBe(1);
  });

  it('promotes a concept to work when the task turns out to touch it', () => {
    configure({ max_questions_per_task: 1, pass_threshold: 1, min_minutes_between_quizzes: 0 });
    call(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'csrf', context: 'chose SameSite=Lax' }],
    });
    // Quizzed first as review debt...
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'jwt-structure',
      question: 'q',
      answer: 'a',
      grade: 4,
      difficulty: 2,
    });
    // ...then genuinely touched by the work. Work wins and never degrades.
    call(logSessionConcepts, {
      session_id: SESSION,
      concepts: [{ slug: 'jwt-structure', context: 'signed the access token in token.ts' }],
    });

    const row = db
      .prepare(
        `SELECT sc.origin FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id
          WHERE sc.session_id = ? AND c.slug = ?`,
      )
      .get(SESSION, 'jwt-structure') as { origin: string };
    expect(row.origin).toBe('work');
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

  it('reports the quiz settings so the tutor knows how hard to push', () => {
    configure({ quiz: { enabled: true, enforced: true } });
    const profile = call<any>(getLearnerProfile, {});
    expect(profile.quiz_enabled).toBe(true);
    expect(profile.quiz_enforced).toBe(true);
  });

  it('answers which project, what was learned there, and what was skipped', () => {
    logAuthWork();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 5, difficulty: 3 });
    call(recordAttempt, {
      session_id: SESSION, slug: 'jwt-structure', question: 'q', grade: 0, difficulty: 2, outcome: 'declined',
    });
    const p = call<any>(getLearnerProfile, {});

    // One project, and the declined answer still counts as an answer on it.
    expect(p.projects).toHaveLength(1);
    expect(p.projects[0].answers).toBe(2);
    expect(p.projects[0].passed).toBe(1);

    // The context line is the point: a slug alone is not a memory.
    expect(p.recent_concepts.map((r: any) => r.slug)).toContain('csrf');
    expect(p.recent_concepts.find((r: any) => r.slug === 'csrf').context).toMatch(/SameSite/);

    expect(p.skipped.map((s: any) => s.slug)).toEqual(['jwt-structure']);
    expect(p.skipped[0].outcome).toBe('declined');
  });

  it('does not count a pre-migration attempt with no outcome as a skip', () => {
    logAuthWork();
    call(recordAttempt, { session_id: SESSION, slug: 'csrf', question: 'q', answer: 'a', grade: 1, difficulty: 2 });
    // Migration 004 added `outcome`; rows written before it are NULL, and a
    // NULL is "we did not record why", not "they ducked it".
    db.prepare('UPDATE attempts SET outcome = NULL').run();
    expect(call<any>(getLearnerProfile, {}).skipped).toEqual([]);
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
    configure({ quiz: { enabled: true, enforced: true }, min_minutes_between_quizzes: 0 });
    expect(call<any>(getConfig, {}).config.quiz.enforced).toBe(true);
  });

  it('writes global config', () => {
    call(setConfig, { quiz: { enabled: true, enforced: true } });
    expect(call<any>(getConfig, {}).config.quiz).toEqual({ enabled: true, enforced: true, only_on_changes: true });
  });

  // The schema still takes the retired word, so it still has to land somewhere.
  // The patch is built from the keys of DEFAULT_CONFIG and `mode` is not one any
  // more -- without the fold, set_config would accept it and drop it silently.
  it('folds a legacy `mode` write onto the quiz flags', () => {
    call(setConfig, { mode: 'enforced' });
    expect(call<any>(getConfig, {}).config.quiz).toEqual({ enabled: true, enforced: true, only_on_changes: true });
  });

  it('lets an explicit quiz win when a call sends both', () => {
    call(setConfig, { mode: 'off', quiz: { enabled: true, enforced: false } });
    expect(call<any>(getConfig, {}).config.quiz.enabled).toBe(true);
  });

  it('refuses a repo write with no repo to write to', () => {
    expect(call<any>(setConfig, { scope: 'repo', quiz: { enabled: true, enforced: true } }).error).toBe('no_repo_root');
  });

  it('exposes the Stop-hook block cap that the hook actually reads', () => {
    expect(call<any>(getConfig).config.max_stop_blocks_per_session).toBe(3);
    call(setConfig, { max_stop_blocks_per_session: 1 });
    expect(call<any>(getConfig).config.max_stop_blocks_per_session).toBe(1);
  });

  it('says so when asked to change nothing', () => {
    expect(call<any>(setConfig, {}).error).toBe('nothing_to_set');
  });

  // The urgent-afternoon switch. The bug it prevents is the one a file-scoped
  // `off` creates: silence that outlives the reason for it.
  describe('session scope', () => {
    it('silences one session without touching either config file', () => {
      const res = call<any>(setConfig, { scope: 'session', session_id: SESSION, quiz: { enabled: false, enforced: false } });
      expect(res.session_off).toBe(true);
      expect(res.session_id).toBe(SESSION);

      // The file-backed config is exactly what it was.
      expect(call<any>(getConfig).config.quiz).toEqual({ enabled: true, enforced: false, only_on_changes: true });
      expect(call<any>(getConfig, { session_id: SESSION }).session_off).toBe(true);

      logAuthWork();
      const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
      expect(plan.reason).toBe('session_off');
      expect(plan.questions_needed).toBe(0);
    });

    it('silences only the session it was asked about', () => {
      call(setConfig, { scope: 'session', session_id: SESSION, quiz: { enabled: false, enforced: false } });
      logAuthWork('other-session');
      expect(call<any>(getSessionQuizPlan, { session_id: 'other-session' }).reason).not.toBe(
        'session_off',
      );
    });

    it('brings the session back on any other mode', () => {
      call(setConfig, { scope: 'session', session_id: SESSION, quiz: { enabled: false, enforced: false } });
      const back = call<any>(setConfig, { scope: 'session', session_id: SESSION, quiz: { enabled: true, enforced: false } });
      expect(back.session_off).toBe(false);

      logAuthWork();
      expect(call<any>(getSessionQuizPlan, { session_id: SESSION }).reason).not.toBe('session_off');
    });

    it('says the commit gate still holds in an enforced repo', () => {
      configure({ quiz: { enabled: true, enforced: true }, min_minutes_between_quizzes: 0 });
      const res = call<any>(setConfig, { scope: 'session', session_id: SESSION, quiz: { enabled: false, enforced: false } });
      expect(res.note).toMatch(/commit gate/);
    });

    it('refuses when no real session id can be resolved', () => {
      // `resolveSessionId` falls back to the literal "default" where no hook has
      // ever stamped a session. A row under that key would silence every future
      // session that lands on the same fallback, with nothing to notice it by —
      // the exact "off outlives its reason" failure this scope exists to avoid.
      expect(resolveSessionId(db)).toBe(FALLBACK_SESSION_ID);
      expect(call<any>(setConfig, { scope: 'session', quiz: { enabled: false, enforced: false } }).error).toBe('no_session');
      expect(isSessionOff(db, FALLBACK_SESSION_ID)).toBe(false);
    });

    it('acts on the session the hooks last stamped when none was passed', () => {
      // Stamped for the same cwd `call` passes: the pointer is per checkout.
      setCurrentSession(db, 'sess-from-hook', cwd);
      expect(call<any>(setConfig, { scope: 'session', quiz: { enabled: false, enforced: false } }).session_id).toBe(
        'sess-from-hook',
      );
      expect(isSessionOff(db, 'sess-from-hook')).toBe(true);
    });

    it('warns that an enforced gate grows while the session is silent', () => {
      configure({ quiz: { enabled: true, enforced: true }, min_minutes_between_quizzes: 0 });
      expect(
        call<any>(setConfig, { scope: 'session', session_id: SESSION, quiz: { enabled: false, enforced: false } }).note,
      ).toMatch(/keeps growing/);
    });

    it('takes only quiz — a vanishing difficulty would be a dial that unset itself', () => {
      expect(
        call<any>(setConfig, { scope: 'session', session_id: SESSION, difficulty: 'hard' }).error,
      ).toBe('session_scope_is_quiz_only');
      expect(
        call<any>(setConfig, { scope: 'session', session_id: SESSION, quiz: { enabled: false, enforced: false }, focus: 'project' })
          .error,
      ).toBe('session_scope_is_quiz_only');
    });

    it('still silences a session for a caller that sends the retired `mode`', () => {
      expect(
        call<any>(setConfig, { scope: 'session', session_id: SESSION, mode: 'off' }).session_off,
      ).toBe(true);
    });
  });

  // The setup skill branches on this field, and it is the only channel that can
  // carry the answer: a shell command in Cowork runs inside a sandbox VM and
  // cannot read the host environment the surface is derived from.
  //
  // Both branches pin `EKLAVYA_SURFACE` rather than letting either read the
  // ambient environment. The first assertion used to be bare, which made the
  // suite fail for anyone running it from inside a Cowork session — the very
  // surface this change adds, and a test that fails by where you ran it is
  // worse than no test.
  it('reports the surface, because a shell probe cannot', () => {
    const before = process.env.EKLAVYA_SURFACE;
    try {
      process.env.EKLAVYA_SURFACE = 'code';
      expect(call<any>(getConfig).surface).toBe('code');

      process.env.EKLAVYA_SURFACE = 'cowork';
      expect(call<any>(getConfig).surface).toBe('cowork');
    } finally {
      if (before === undefined) delete process.env.EKLAVYA_SURFACE;
      else process.env.EKLAVYA_SURFACE = before;
    }
  });
});

describe('difficulty levels, earned per project', () => {
  /** A directory that looks like a git root, so `repoRoot` resolves to it. */
  function repo(label: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `eklavya-${label}-`));
    fs.mkdirSync(path.join(dir, '.git'));
    return dir;
  }

  /** Pass one question per concept, in one project. */
  function passConcepts(slugs: string[], where: string, grade = 4): any {
    let last: any;
    for (const slug of slugs) {
      last = call<any>(recordAttempt, {
        cwd: where,
        session_id: SESSION,
        slug,
        question: `about ${slug} at ${where}`,
        answer: 'a good answer',
        grade,
        difficulty: 2,
      });
    }
    return last;
  }

  function seedSlugs(n: number): string[] {
    return (db.prepare('SELECT slug FROM concepts ORDER BY id LIMIT ?').all(n) as { slug: string }[]).map(
      (r) => r.slug,
    );
  }

  it('starts a fresh project on easy and asks nothing above tier 2', () => {
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.level).toBe('easy');
    expect(plan.level_framing).toMatch(/tiers 1-2/);
    for (const c of plan.concepts) expect(c.tier_to_ask).toBeLessThanOrEqual(2);
  });

  it('promotes once the answers, the accuracy and the spread all clear', () => {
    configure({ min_minutes_between_quizzes: 0, level_up_after: 6 });
    const where = repo('proj');
    try {
      const slugs = seedSlugs(6);
      const last = passConcepts(slugs, where);
      expect(last.level_up).toEqual(
        expect.objectContaining({ from: 'easy', to: 'medium' }),
      );
      // And the next plan really asks harder questions.
      logAuthWork();
      const plan = call<any>(getSessionQuizPlan, { cwd: where, session_id: SESSION });
      expect(plan.level).toBe('medium');
      expect(Math.max(...plan.concepts.map((c: any) => c.tier_to_ask))).toBeGreaterThanOrEqual(2);
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });

  it('does not promote on volume when the accuracy is not there', () => {
    configure({ min_minutes_between_quizzes: 0, level_up_after: 3 });
    const where = repo('sloppy');
    try {
      const slugs = seedSlugs(9);
      // Six failures, then three passes: the runway is met and the accuracy is
      // 0.33. The order matters — a promotion is evaluated on every attempt, so
      // three clean answers first would have promoted before the failures landed.
      passConcepts(slugs.slice(0, 6), where, 1);
      const last = passConcepts(slugs.slice(6), where, 4);
      expect(last.level_up).toBeUndefined();
      expect(last.level).toBe('easy');
      expect(last.level_progress.unmet).toContain('accuracy');
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });

  it('does not let one concept ground out forty ways carry a promotion', () => {
    configure({ min_minutes_between_quizzes: 0, level_up_after: 6 });
    const where = repo('grind');
    try {
      let last: any;
      for (let i = 0; i < 8; i += 1) {
        last = call<any>(recordAttempt, {
          cwd: where,
          session_id: SESSION,
          slug: 'csrf',
          question: `csrf, angle ${i}`,
          answer: 'a good answer',
          grade: 4,
          difficulty: 2,
        });
      }
      expect(last.level_up).toBeUndefined();
      expect(last.level_progress.unmet).toContain('concepts');
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });

  it('keeps progress per project — a second repo still starts at easy', () => {
    configure({ min_minutes_between_quizzes: 0, level_up_after: 6 });
    const first = repo('first');
    const second = repo('second');
    try {
      expect(passConcepts(seedSlugs(6), first).level).toBe('medium');
      // Same database, same learner, different codebase: the runway restarts,
      // because "how hard should this be" is a question about a codebase.
      const other = call<any>(recordAttempt, {
        cwd: second,
        session_id: SESSION,
        slug: 'csrf',
        question: 'csrf on the second project',
        answer: 'a good answer',
        grade: 4,
        difficulty: 1,
      });
      expect(other.level).toBe('easy');
      expect(other.level_progress.passed).toBe(1);
    } finally {
      fs.rmSync(first, { recursive: true, force: true });
      fs.rmSync(second, { recursive: true, force: true });
    }
  });

  it('a pinned level sets the band and stops progression entirely', () => {
    configure({ min_minutes_between_quizzes: 0, level_up_after: 3, difficulty: 'hard' });
    const where = repo('pinned');
    try {
      logAuthWork();
      const plan = call<any>(getSessionQuizPlan, { cwd: where, session_id: SESSION });
      expect(plan.level).toBe('hard');
      for (const c of plan.concepts) expect(c.tier_to_ask).toBeGreaterThanOrEqual(3);
      expect(plan.level_progress.pinned).toBe(true);

      const last = passConcepts(seedSlugs(9), where);
      expect(last.level_up).toBeUndefined();
      expect(last.level).toBe('hard');
      // Nothing earned, nothing written: drop the pin later and the project is
      // back where its own evidence left it.
      expect(db.prepare('SELECT count(*) n FROM project_levels').get()).toEqual({ n: 0 });
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });

  it('ignores attempts recorded before levels existed', () => {
    configure({ min_minutes_between_quizzes: 0, level_up_after: 2 });
    const where = repo('legacy');
    try {
      const id = (db.prepare('SELECT id FROM concepts LIMIT 1').get() as { id: number }).id;
      // A pre-migration row: no repo, no level, and a tier-3 grade that must not
      // be read as evidence at any band.
      for (let i = 0; i < 20; i += 1) {
        db.prepare(
          `INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty)
           VALUES (?, 'old', ?, 'a', 5, 3)`,
        ).run(id, `ancient question ${i}`);
      }
      const last = passConcepts(seedSlugs(1), where);
      expect(last.level).toBe('easy');
      expect(last.level_progress.passed).toBe(1);
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });

  it('does not count a decline against the accuracy', () => {
    configure({ min_minutes_between_quizzes: 0, level_up_after: 2 });
    const where = repo('declined');
    try {
      const slugs = seedSlugs(3);
      call(recordAttempt, {
        cwd: where,
        session_id: SESSION,
        slug: slugs[0],
        question: 'one they skipped',
        grade: 0,
        difficulty: 1,
        outcome: 'declined',
      });
      const last = passConcepts(slugs.slice(1), where);
      // Two passes out of two answers: the decline is in neither half of the
      // fraction, so skipping honestly cost nothing.
      expect(last.level_up).toEqual(expect.objectContaining({ to: 'medium', accuracy: 1 }));
      // And the reported progress is the new level's, which starts empty.
      expect(last.level_progress.passed).toBe(0);
    } finally {
      fs.rmSync(where, { recursive: true, force: true });
    }
  });
});

describe('the settings line, end to end', () => {
  it('never ships one — the dials are in the status bar now', () => {
    configure({ min_minutes_between_quizzes: 0, focus: 'project', quiz: { enabled: true, enforced: true } });
    logAuthWork();
    const plan = call<any>(getSessionQuizPlan, { session_id: SESSION });
    expect(plan.concepts.length).toBeGreaterThan(0);
    for (const c of plan.concepts) {
      expect(c.ask_header).toBeUndefined();
      // Nothing else in the item may smuggle one back in either: a model that
      // finds a bracketed dial string anywhere will paste it above the stem.
      expect(JSON.stringify(c)).not.toMatch(/mode:\s*(ambient|enforced|off)/);
    }
  });

  it('never reaches the recorded stem, so the repeat check still fires', () => {
    logAuthWork();
    const stem = 'What does httpOnly stop a script from doing?';
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'httponly-cookies',
      question: `[ambient · concept · easy · tier 2 mechanism]\n\n${stem}`,
      answer: 'reading the cookie',
      grade: 4,
      difficulty: 2,
      format: 'mcq',
    });

    const stored = db
      .prepare('SELECT question FROM attempts ORDER BY id DESC LIMIT 1')
      .get() as { question: string };
    expect(stored.question).toBe(stem);

    // The same stem, now with a different settings line because the level moved on: one
    // question, not two.
    const again = call<any>(recordAttempt, {
      session_id: SESSION,
      slug: 'httponly-cookies',
      question: `[ambient · concept · medium · tier 3 judgement]\n\n${stem}`,
      answer: 'reading the cookie',
      grade: 4,
      difficulty: 3,
      format: 'mcq',
    });
    expect(again.repeat_question).toBe(true);
  });
});

describe('a decline that was explained anyway', () => {

  it('is reported, because the two outcomes are not interchangeable', () => {
    call(logSessionConcepts, { session_id: SESSION, concepts: [{ slug: 'csrf', context: 'the csrf token check in auth.ts' }] });
    const res = call<{ outcome_conflict?: string }>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'Why is a CSRF token needed here?',
      difficulty: 2,
      grade: 0,
      outcome: 'declined',
      feedback: 'A CSRF token proves the request came from your own page.',
    });
    expect(res.outcome_conflict).toMatch(/dont_know/);
  });

  it('says nothing when a decline is a clean decline', () => {
    call(logSessionConcepts, { session_id: SESSION, concepts: [{ slug: 'csrf', context: 'the csrf token check in auth.ts' }] });
    const res = call<{ outcome_conflict?: string }>(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'Why is a CSRF token needed here?',
      difficulty: 2,
      grade: 0,
      outcome: 'declined',
    });
    expect(res.outcome_conflict).toBeUndefined();
  });

  it('does not strand an explained decline outside the gate retry', () => {
    // The exclusion exists to honour "leave me alone". A row with a taught
    // explanation is not that, and treating it as one removes the concept from
    // the only route out of a blocked commit gate -- so in enforced mode the
    // developer is stuck while the tool insists enforcement is working.
    call(logSessionConcepts, { session_id: SESSION, concepts: [{ slug: 'csrf', context: 'the csrf token check in auth.ts' }] });
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'Why is a CSRF token needed here?',
      difficulty: 2,
      grade: 0,
      outcome: 'declined',
      feedback: 'Taught it: the token proves same-origin intent.',
    });
    expect(gateRetryConcepts(db, SESSION).map((c) => c.slug)).toContain('csrf');
  });

  it('still keeps a clean decline out of the gate retry', () => {
    call(logSessionConcepts, { session_id: SESSION, concepts: [{ slug: 'csrf', context: 'the csrf token check in auth.ts' }] });
    call(recordAttempt, {
      session_id: SESSION,
      slug: 'csrf',
      question: 'Why is a CSRF token needed here?',
      difficulty: 2,
      grade: 0,
      outcome: 'declined',
    });
    expect(gateRetryConcepts(db, SESSION).map((c) => c.slug)).not.toContain('csrf');
  });
});

describe('set_config project scope stamps the checkout', () => {
  // `belongsTo` compares this field to tell two slug-colliding checkouts apart.
  // Written without it, the file is trusted by whichever checkout reads it --
  // and a file the CLI had stamped for another checkout would be mutated here
  // while this project's own read discarded it, success reported either way.
  it('writes the project key, like the CLI does', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-stamp-')));
    fs.mkdirSync(path.join(dir, '.git'));
    try {
      const res = call<any>(setConfig, { scope: 'project', cwd: dir, difficulty: 'hard' });
      expect(res.error).toBeUndefined();
      expect(res.written_to.startsWith(home)).toBe(true);

      const written = JSON.parse(fs.readFileSync(res.written_to, 'utf8')) as Record<string, unknown>;
      expect(written.project).toBe(dir);
      expect(written.difficulty).toBe('hard');

      // And the file is honoured, which is what the stamp has to not break.
      expect(call<any>(getConfig, { cwd: dir }).config.difficulty).toBe('hard');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
