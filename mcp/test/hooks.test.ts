import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { conceptBySlug, gradeConcept, logSessionConcept } from '../src/store.js';
import { tempDbPath, cleanup } from './helpers.js';

const hooksDir = path.join(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
  'hooks',
);
const SESSION_START = path.join(hooksDir, 'session-start.sh');
const STOP_CHECK = path.join(hooksDir, 'stop-quiz-check.sh');
const CHECKPOINT = path.join(hooksDir, 'checkpoint-quiz.sh');

const SESSION = 'hook-session';

let dbFile = '';
let db: DB;
let home = '';
let cwd = '';

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runHook(script: string, input: Record<string, unknown>, env: Record<string, string> = {}): HookResult {
  const res = spawnSync('/bin/sh', [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

const stop = (extra: Record<string, unknown> = {}) =>
  runHook(STOP_CHECK, { session_id: SESSION, cwd, hook_event_name: 'Stop', stop_reason: 'end_turn', ...extra });

/**
 * The mid-work checkpoint, as PostToolUse delivers it: right after the model
 * called log_session_concepts.
 */
const checkpoint = (extra: Record<string, unknown> = {}) =>
  runHook(CHECKPOINT, {
    session_id: SESSION,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__eklavya__log_session_concepts',
    tool_input: { concepts: [{ slug: 'csrf' }] },
    ...extra,
  });

/** The instruction the model actually receives, or null when the hook stayed quiet. */
function checkpointContext(res: HookResult): string | null {
  if (!res.stdout.trim()) return null;
  const parsed = JSON.parse(res.stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? null;
}

const sessionStart = (extra: Record<string, unknown> = {}) =>
  runHook(SESSION_START, { session_id: SESSION, cwd, hook_event_name: 'SessionStart', session_start_reason: 'startup', ...extra });

function configure(patch: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(patch));
}

/** Log concepts for the session the way the MCP tool would. */
function logConcepts(slugs: string[], session = SESSION): void {
  for (const slug of slugs) {
    const c = conceptBySlug(db, slug);
    if (!c) throw new Error(`no seed concept ${slug}`);
    logSessionConcept(db, session, c.id, `touched ${slug} in auth.ts`);
  }
}

function answer(slug: string, grade: number, session = SESSION): void {
  const c = conceptBySlug(db, slug)!;
  gradeConcept(db, {
    conceptId: c.id,
    sessionId: session,
    question: 'q',
    answer: 'a',
    grade,
    difficulty: 2,
    feedback: null,
    now: new Date(),
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cwd-'));
  dbFile = tempDbPath('hooks');
  db = openDb(dbFile);
  configure({ min_minutes_between_quizzes: 0 });
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('SessionStart never breaks a session (PRD §9.1)', () => {
  it('says nothing and exits 0 when the database does not exist', () => {
    const res = runHook(SESSION_START, { session_id: SESSION, cwd }, { EKLAVYA_DB: '/nonexistent/eklavya.db' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('exits 0 on a corrupt database', () => {
    const corrupt = path.join(home, 'corrupt.db');
    fs.writeFileSync(corrupt, 'this is not a sqlite file at all');
    const res = runHook(SESSION_START, { session_id: SESSION, cwd }, { EKLAVYA_DB: corrupt });
    expect(res.status).toBe(0);
  });

  it('exits 0 when jq is not installed', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-bin-'));
    try {
      for (const tool of ['sh', 'cat', 'sed', 'dirname', 'sqlite3', 'printf', 'command']) {
        const found = spawnSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout?.trim();
        if (found) fs.symlinkSync(found, path.join(bin, tool));
      }
      const res = runHook(SESSION_START, { session_id: SESSION, cwd }, { PATH: bin });
      expect(res.status).toBe(0);
      expect(res.stdout).toBe('');
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('exits 0 on malformed hook input', () => {
    const res = spawnSync('/bin/sh', [SESSION_START], {
      input: 'not json at all',
      encoding: 'utf8',
      env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home },
    });
    expect(res.status).toBe(0);
  });
});

describe('SessionStart output', () => {
  it('stamps the session id so MCP tools resolve the same session (G1)', () => {
    sessionStart();
    const row = db.prepare("SELECT value FROM meta WHERE key = 'current_session'").get() as { value: string };
    expect(row.value).toBe(SESSION);
  });

  it('reports having no history yet on a fresh install', () => {
    const res = sessionStart();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/No learning history yet/);
  });

  it('tells the model to log concepts on a fresh install, where nothing else will', () => {
    const res = sessionStart();
    expect(res.stdout).toMatch(/Standing instruction/);
    expect(res.stdout).toMatch(/log_session_concepts/);
  });

  it('repeats the logging instruction once there is history — the loop still needs feeding', () => {
    logConcepts(['csrf']);
    answer('csrf', 5);
    answer('csrf', 5);
    const res = sessionStart();
    expect(res.stdout).toMatch(/Learner profile/);
    expect(res.stdout).toMatch(/log_session_concepts/);
  });

  it('drops the logging instruction when quiet is set', () => {
    configure({ quiet: true });
    expect(sessionStart().stdout).not.toMatch(/log_session_concepts/);
  });

  it('reports per-domain progress once something is known', () => {
    logConcepts(['csrf']);
    answer('csrf', 5);
    answer('csrf', 5);

    const res = sessionStart();
    expect(res.stdout).toMatch(/web-auth 1\/\d+ known/);
    expect(res.stdout).toMatch(/Mode: ambient/);
  });

  it('names weak concepts and counts what is due', () => {
    logConcepts(['csrf']);
    answer('csrf', 1);
    const res = sessionStart();
    expect(res.stdout).toMatch(/Weak: csrf/);
  });

  it('stays silent when quiet is set, but still stamps the session', () => {
    configure({ quiet: true });
    const res = sessionStart();
    expect(res.stdout).toBe('');
    expect(db.prepare("SELECT value FROM meta WHERE key='current_session'").get()).toBeTruthy();
  });

  it('stays silent when the mode is off', () => {
    configure({ mode: 'off' });
    expect(sessionStart().stdout).toBe('');
  });

  it('lets a repo config override the global mode', () => {
    configure({ mode: 'ambient' });
    fs.writeFileSync(path.join(cwd, '.eklavya.json'), JSON.stringify({ mode: 'off' }));
    expect(sessionStart().stdout).toBe('');
  });
});

// ---------------------------------------------------------------------------

describe('Stop hook — the loop guard (P0)', () => {
  it('blocks exactly once for one batch of work, however many times Claude stops', () => {
    logConcepts(['csrf', 'jwt-structure']);

    const first = stop();
    expect(first.status).toBe(2);
    expect(first.stderr).toMatch(/csrf/);

    // Every subsequent Stop must pass. This is the difference between a quiz
    // and an infinite loop.
    for (let i = 0; i < 5; i += 1) {
      expect(stop().status, `stop #${i + 2} blocked again`).toBe(0);
    }
  });

  it('does not re-block after the developer skips', () => {
    logConcepts(['csrf', 'jwt-structure']);
    expect(stop().status).toBe(2);

    answer('csrf', 0);
    answer('jwt-structure', 0);

    expect(stop().status).toBe(0);
  });

  it('does not re-block after the quiz is answered well', () => {
    logConcepts(['csrf']);
    expect(stop().status).toBe(2);

    answer('csrf', 5);
    answer('csrf', 5);

    expect(stop().status).toBe(0);
  });

  it('arms again only when genuinely new work is logged', () => {
    logConcepts(['csrf']);
    expect(stop().status).toBe(2);
    expect(stop().status).toBe(0);

    logConcepts(['jwt-structure']);
    expect(stop().status).toBe(2);
    expect(stop().status).toBe(0);
  });

  it('re-logging the same concepts does not re-arm it', () => {
    logConcepts(['csrf', 'jwt-structure']);
    expect(stop().status).toBe(2);

    logConcepts(['csrf', 'jwt-structure']);
    expect(stop().status).toBe(0);
  });

  it('stops blocking entirely after the per-session cap, even with new work', () => {
    configure({ min_minutes_between_quizzes: 0, max_stop_blocks_per_session: 2 });

    logConcepts(['csrf']);
    expect(stop().status).toBe(2);
    logConcepts(['jwt-structure']);
    expect(stop().status).toBe(2);
    logConcepts(['pkce']);
    expect(stop().status).toBe(0);
  });

  it('honors stop_hook_active if the harness still sends it', () => {
    logConcepts(['csrf']);
    expect(stop({ stop_hook_active: true }).status).toBe(0);
  });
});

describe('Stop hook — when not to fire', () => {
  it('passes when the session touched nothing', () => {
    expect(stop().status).toBe(0);
  });

  it('passes when every touched concept is already mastered', () => {
    logConcepts(['csrf']);
    answer('csrf', 5);
    answer('csrf', 5);
    expect(stop().status).toBe(0);
  });

  it('passes when the mode is off', () => {
    configure({ mode: 'off' });
    logConcepts(['csrf']);
    expect(stop().status).toBe(0);
  });

  it('respects the ambient cooldown', () => {
    configure({ mode: 'ambient', min_minutes_between_quizzes: 60 });
    logConcepts(['csrf']);
    expect(stop().status).toBe(2);

    logConcepts(['jwt-structure']);
    expect(stop().status).toBe(0);
  });

  it('ignores the cooldown in enforced mode, or the gate could never be passed', () => {
    configure({ mode: 'enforced', min_minutes_between_quizzes: 60 });
    logConcepts(['csrf']);
    expect(stop().status).toBe(2);

    logConcepts(['jwt-structure']);
    expect(stop().status).toBe(2);
  });

  it('passes when every touched concept has already been asked about', () => {
    logConcepts(['csrf']);
    // Grade 3 leaves it unmastered, so only the already-asked filter stops this.
    answer('csrf', 3);
    logConcepts(['csrf']);
    expect(stop().status).toBe(0);
  });

  it('still fires for concepts logged after the quiz', () => {
    logConcepts(['csrf']);
    answer('csrf', 3);
    logConcepts(['jwt-structure']);
    const res = stop();
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/jwt-structure/);
    expect(res.stderr).not.toMatch(/csrf/);
  });

  it('does not block a turn the quiz plan would then refuse as too soon', () => {
    // A manual /eklavya:quiz just happened; the cooldown is measured from the
    // answer, not only from the last block, or Claude is told to teach and then
    // handed questions_needed: 0.
    configure({ mode: 'ambient', min_minutes_between_quizzes: 60 });
    logConcepts(['csrf']);
    answer('csrf', 3);
    logConcepts(['jwt-structure']);
    expect(stop().status).toBe(0);
  });

  it('exits 0 when the database is missing', () => {
    const res = runHook(STOP_CHECK, { session_id: SESSION, cwd }, { EKLAVYA_DB: '/nonexistent/x.db' });
    expect(res.status).toBe(0);
  });

  it('lets EKLAVYA_SESSION_ID override the harness id, for two-pane workflows', () => {
    logConcepts(['csrf'], 'shared-pane-session');
    const res = runHook(
      STOP_CHECK,
      { session_id: 'this-panes-own-id', cwd, hook_event_name: 'Stop' },
      { EKLAVYA_SESSION_ID: 'shared-pane-session' },
    );
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/csrf/);
  });

  it('falls back to the stamped session when the input has no session_id', () => {
    logConcepts(['csrf'], 'stamped-session');
    db.prepare("INSERT INTO meta (key, value) VALUES ('current_session', 'stamped-session')").run();

    const res = runHook(STOP_CHECK, { cwd, hook_event_name: 'Stop' });
    expect(res.status).toBe(2);
  });
});

describe('Stop hook — what it tells Claude', () => {
  it('names the concepts and the code context behind them', () => {
    logConcepts(['csrf', 'jwt-structure']);
    const res = stop();
    expect(res.stderr).toMatch(/csrf \(touched csrf in auth\.ts\)/);
    expect(res.stderr).toMatch(/get_session_quiz_plan/);
    expect(res.stderr).toMatch(/ONE question at a time/);
  });

  it('caps the list at the configured questions per task', () => {
    configure({ min_minutes_between_quizzes: 0, max_questions_per_task: 1 });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);
    const res = stop();
    // The concepts line, not the whole message: prose elsewhere may legitimately
    // contain a semicolon, and matching on that made this assert something it
    // did not mean.
    const line = res.stderr.split('\n').find((l) => l.startsWith('Concepts:')) ?? '';
    expect(line).toMatch(/csrf/);
    expect(line.match(/;/g) ?? []).toHaveLength(0);
  });

  it('says the gate needs it in enforced mode, and offers the skip in ambient', () => {
    configure({ mode: 'enforced', min_minutes_between_quizzes: 0 });
    logConcepts(['csrf']);
    expect(stop().stderr).toMatch(/enforced mode/);

    configure({ mode: 'ambient', min_minutes_between_quizzes: 0 });
    logConcepts(['jwt-structure']);
    expect(stop().stderr).toMatch(/say skip/);
  });
});

// ---------------------------------------------------------------------------

describe('PostToolUse checkpoint — asking while the agent still works', () => {
  it('asks about the concept that was just logged, not the oldest one', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);
    logConcepts(['jwt-structure']);

    const ctx = checkpointContext(checkpoint());
    expect(ctx).toMatch(/jwt-structure/);
    expect(ctx).not.toMatch(/csrf/);
  });

  it('tells the model to ask exactly one question and then resume', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);

    const ctx = checkpointContext(checkpoint())!;
    expect(ctx).toMatch(/max: 1/);
    expect(ctx).toMatch(/ignore_cooldown/);
    expect(ctx).toMatch(/ONE question/);
    expect(ctx).toMatch(/Resume the task/);
  });

  it('exits 0 with valid JSON, never exit 2 — nothing here is an error to prevent', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);

    const res = checkpoint();
    expect(res.status).toBe(0);
    expect(() => JSON.parse(res.stdout)).not.toThrow();
    expect(JSON.parse(res.stdout).hookSpecificOutput.hookEventName).toBe('PostToolUse');
  });

  it('carries the configured focus, because the tutor skill may never have loaded', () => {
    configure({ min_minutes_between_checkpoints: 0, focus: 'project' });
    logConcepts(['csrf']);
    expect(checkpointContext(checkpoint())).toMatch(/Focus is 'project'/);
  });
});

describe('PostToolUse checkpoint — the burst guard', () => {
  it('does not fire twice in a row: eight logged concepts are not eight questions', () => {
    // The default gap. Two calls in the same second must produce one question.
    logConcepts(['csrf', 'jwt-structure', 'pkce']);

    expect(checkpointContext(checkpoint())).toMatch(/\w/);
    expect(checkpoint().stdout).toBe('');
    expect(checkpoint().stdout).toBe('');
  });

  it('stays quiet once the session budget is spent, wherever it was spent', () => {
    configure({ min_minutes_between_checkpoints: 0, max_questions_per_task: 2 });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);

    answer('csrf', 3);
    answer('jwt-structure', 3);

    expect(checkpoint().stdout).toBe('');
  });

  it('stays quiet when everything logged has already been asked about', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);
    answer('csrf', 3);
    expect(checkpoint().stdout).toBe('');
  });

  it('stays quiet when the session touched nothing', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    expect(checkpoint().stdout).toBe('');
  });

  it('stays quiet inside a subagent, which cannot ask the developer anything', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);
    expect(checkpoint({ agent_id: 'sub-1', agent_type: 'general-purpose' }).stdout).toBe('');
  });

  it('stays quiet when cadence is "end" — the pre-1.4 behaviour, on request', () => {
    configure({ min_minutes_between_checkpoints: 0, cadence: 'end' });
    logConcepts(['csrf']);
    expect(checkpoint().stdout).toBe('');
  });

  it('stays quiet when the mode is off', () => {
    configure({ min_minutes_between_checkpoints: 0, mode: 'off' });
    logConcepts(['csrf']);
    expect(checkpoint().stdout).toBe('');
  });

  it('lets a repo config turn checkpoints off for one project', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    fs.writeFileSync(path.join(cwd, '.eklavya.json'), JSON.stringify({ cadence: 'end' }));
    logConcepts(['csrf']);
    expect(checkpoint().stdout).toBe('');
  });

  it('never breaks a tool call: no database, no output, exit 0', () => {
    const res = runHook(
      CHECKPOINT,
      { session_id: SESSION, cwd, hook_event_name: 'PostToolUse' },
      { EKLAVYA_DB: '/nonexistent/eklavya.db' },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('exits 0 on malformed hook input', () => {
    const res = spawnSync('/bin/sh', [CHECKPOINT], {
      input: 'not json at all',
      encoding: 'utf8',
      env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home },
    });
    expect(res.status).toBe(0);
  });
});

describe('The budget is shared: checkpoints spend what the Stop sweep would have', () => {
  it('says nothing at the end when the whole budget was answered during the work', () => {
    configure({ min_minutes_between_quizzes: 0, max_questions_per_task: 2 });
    logConcepts(['csrf', 'jwt-structure']);

    answer('csrf', 3);
    answer('jwt-structure', 3);

    // Two questions already asked mid-task, budget of two. The end of the task
    // is exactly as quiet as it would have been without Eklavya installed.
    expect(stop().status).toBe(0);
  });

  it('sweeps up only the remainder', () => {
    configure({ min_minutes_between_quizzes: 0, max_questions_per_task: 2 });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);

    answer('csrf', 3);

    const res = stop();
    expect(res.status).toBe(2);
    // One left in the budget, so one concept named -- not the other two.
    const named = ['jwt-structure', 'pkce'].filter((slug) => res.stderr.includes(slug));
    expect(named).toHaveLength(1);
  });
});

describe('SessionStart says which level the project is on', () => {
  /** Attempts as `record_attempt` writes them: stamped with a project and a band. */
  function answerIn(repo: string, slug: string, grade: number): void {
    const c = conceptBySlug(db, slug)!;
    db.prepare(
      `INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, repo, level)
       VALUES (?, ?, ?, 'a', ?, 2, ?, 'easy')`,
    ).run(c.id, SESSION, `about ${slug}`, grade, repo);
  }

  it('reports the level and how far into it they are', () => {
    // The hook's cwd is not a git repository, so it falls into the shared '*'
    // bucket — the same key the server uses for work outside a repo.
    answerIn('*', 'csrf', 4);
    answerIn('*', 'jwt-structure', 4);
    answerIn('*', 'httponly-cookies', 1);
    const res = sessionStart();
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Level: easy (2/100 on this project)');
  });

  it('starts at easy with nothing answered', () => {
    expect(sessionStart().stdout).toContain('Level: easy (0/100 on this project)');
  });

  it('follows a shortened runway', () => {
    configure({ min_minutes_between_quizzes: 0, level_up_after: 20 });
    answerIn('*', 'csrf', 5);
    expect(sessionStart().stdout).toContain('Level: easy (1/20 on this project)');
  });

  it('says so when the level is pinned, rather than showing a runway nobody is on', () => {
    configure({ min_minutes_between_quizzes: 0, difficulty: 'hard' });
    expect(sessionStart().stdout).toContain('Level: hard (pinned)');
  });

  it('reads the level a promotion wrote', () => {
    db.prepare(
      `INSERT INTO project_levels (repo, level, promoted_at) VALUES ('*', 'medium', datetime('now','-1 day'))`,
    ).run();
    answerIn('*', 'csrf', 4); // easy-band evidence, spent with the old level
    expect(sessionStart().stdout).toContain('Level: medium (0/100 on this project)');
  });

  it('names difficulty when a repo pins it over the learner’s own setting', () => {
    configure({ difficulty: 'auto' });
    fs.writeFileSync(path.join(cwd, '.eklavya.json'), JSON.stringify({ difficulty: 'easy' }));
    expect(sessionStart().stdout).toContain('overrides your global setting for: difficulty');
  });
});
