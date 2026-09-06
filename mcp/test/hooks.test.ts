import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { conceptBySlug, gradeConcept, logSessionConcept } from '../src/store.js';
import { tempDbPath, cleanup } from './helpers.js';

// The built hooks, not the sources: these are what the plugin actually runs,
// and `pretest` builds them. They are Node rather than shell so that Windows,
// where `.sh` hooks are unreliable, runs the same code as everywhere else.
const hooksDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks');
const SESSION_START = path.join(hooksDir, 'session-start.js');
const STOP_CHECK = path.join(hooksDir, 'stop-quiz-check.js');
const CHECKPOINT = path.join(hooksDir, 'checkpoint-quiz.js');
const NUDGE = path.join(hooksDir, 'prompt-submit-nudge.js');

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
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, ...env },
  });
  return { status: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

/**
 * The concepts line, not the whole message: prose elsewhere may legitimately
 * contain a semicolon, and matching on that made these asserts something they
 * did not mean.
 */
const conceptsLine = (stderr: string): string =>
  stderr.split('\n').find((l) => l.startsWith('Concepts:')) ?? '';

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

  // The hooks used to shell out to `jq` and the `sqlite3` CLI, and degraded to
  // silence when either was missing -- which on Windows was most of the time.
  // They are Node now, so an empty PATH costs nothing: this asserts the profile
  // still prints with no external tool reachable at all.
  it('works with nothing on PATH — no jq, no sqlite3, no shell', () => {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-bin-'));
    try {
      const res = runHook(SESSION_START, { session_id: SESSION, cwd }, { PATH: bin });
      expect(res.status).toBe(0);
      expect(res.stdout).toMatch(/\[Eklavya\]/);
    } finally {
      fs.rmSync(bin, { recursive: true, force: true });
    }
  });

  it('exits 0 on malformed hook input', () => {
    const res = spawnSync(process.execPath, [SESSION_START], {
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

  it('still gives the logging instruction when quiet is set', () => {
    // `quiet` is about the greeting. It used to drop the directive too, which
    // meant a developer who turned the banner off logged nothing, was never
    // quizzed, and saw `mode: ambient` in `get_config` the whole time. Two
    // tests encoded that as intended behaviour; this is the corrected pair.
    configure({ quiet: true });
    const res = sessionStart();
    expect(res.stdout).toMatch(/log_session_concepts/);
    expect(res.stdout).not.toMatch(/Learner profile/);
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

  it('prints no banner when quiet is set, and still stamps the session', () => {
    configure({ quiet: true });
    const res = sessionStart();
    expect(res.stdout).not.toMatch(/Learner profile|No learning history|Mode: /);
    expect(res.stdout).toMatch(/Standing instruction/);
    expect(db.prepare("SELECT value FROM meta WHERE key='current_session'").get()).toBeTruthy();
  });

  it('says nothing at all only when the mode is off', () => {
    // The one setting that means "do nothing". `quiet` is not a second one.
    configure({ mode: 'off', quiet: false });
    expect(sessionStart().stdout).toBe('');
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
    configure({ min_minutes_between_quizzes: 0, cadence: 'end' });
    logConcepts(['csrf', 'jwt-structure']);
    const res = stop();
    expect(res.stderr).toMatch(/csrf \(touched csrf in auth\.ts\)/);
    expect(res.stderr).toMatch(/get_session_quiz_plan/);
    expect(res.stderr).toMatch(/ONE question at a time/);
  });

  // The cadence decides the size of the sweep, and this is the failure it was
  // written for: three questions in a row at the exact moment the developer
  // wanted to be finished, under the setting that promises the opposite.
  it('sweeps one concept only under the interleaved cadence', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'interleaved' });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);
    const res = stop();
    const line = conceptsLine(res.stderr);
    expect(line).toMatch(/csrf/);
    expect(line.match(/;/g) ?? []).toHaveLength(0);
    expect(res.stderr).toMatch(/One question, then let them finish/);
    expect(res.stderr).not.toMatch(/ONE question at a time/);
  });

  it('sweeps the whole remaining budget in enforced mode, cadence notwithstanding', () => {
    // Decision G5 again: the gate has to stay passable inside the session.
    configure({ mode: 'enforced', cadence: 'interleaved', min_minutes_between_quizzes: 0 });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);
    expect(conceptsLine(stop().stderr).match(/;/g) ?? []).toHaveLength(2);
  });

  it('sweeps the whole remaining budget under the end cadence', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'end' });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);
    const line = conceptsLine(stop().stderr);
    expect(line.match(/;/g) ?? []).toHaveLength(2);
  });

  it('caps the list at the configured questions per task', () => {
    configure({ min_minutes_between_quizzes: 0, max_questions_per_task: 1 });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);
    const res = stop();
    const line = conceptsLine(res.stderr);
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
    const res = spawnSync(process.execPath, [CHECKPOINT], {
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

// ---------------------------------------------------------------------------

describe('the UserPromptSubmit nudge', () => {
  const nudge = (extra: Record<string, unknown> = {}) =>
    runHook(NUDGE, { session_id: SESSION, cwd, hook_event_name: 'UserPromptSubmit', ...extra });

  /** The line the model receives, or null when the hook stayed quiet. */
  const context = (res: HookResult): string | null => {
    if (!res.stdout.trim()) return null;
    const parsed = JSON.parse(res.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('UserPromptSubmit');
    return parsed.hookSpecificOutput?.additionalContext ?? null;
  };

  /**
   * Move this session's first-seen stamp into the past. The grace window is a
   * constant rather than a config key, so backdating the row is the only way to
   * reach the other side of it without sleeping.
   */
  const seenMinutesAgo = (
    minutes: number,
    nudgedMinutesAgo: number | null = null,
    count = 0,
  ): void => {
    const iso = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    db.prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(
      `prompt_nudge:${SESSION}`,
      `${iso(minutes)}|${nudgedMinutesAgo === null ? '' : iso(nudgedMinutesAgo)}|${count}`,
    );
  };

  const stateValue = (): string | undefined =>
    (
      db.prepare('SELECT value FROM meta WHERE key = ?').get(`prompt_nudge:${SESSION}`) as
        | { value: string }
        | undefined
    )?.value;

  it('says nothing on the first prompt — the directive was injected seconds ago', () => {
    const res = nudge();
    expect(res.status).toBe(0);
    expect(context(res)).toBeNull();
    // But it starts the clock, or the grace window could never elapse.
    expect(stateValue()).toMatch(/^\d{4}-\d{2}-\d{2}T.*\|\|0$/);
  });

  it('stays quiet inside the grace window', () => {
    seenMinutesAgo(5);
    expect(context(nudge())).toBeNull();
  });

  it('nudges once the session has had a fair chance and still logged nothing', () => {
    seenMinutesAgo(30);
    const line = context(nudge());
    expect(line).toContain('log_session_concepts');
    // One line, not the whole session-start block: this runs on every prompt.
    expect(line!.split('\n')).toHaveLength(1);
  });

  it('does not nudge a session that is logging', () => {
    logConcepts(['csrf']);
    seenMinutesAgo(30);
    expect(context(nudge())).toBeNull();
  });

  it('does not nudge twice in a row', () => {
    seenMinutesAgo(30);
    expect(context(nudge())).not.toBeNull();
    // The hook has just recorded itself, so the very next prompt is inside the
    // cooldown even though nothing has been logged.
    expect(context(nudge())).toBeNull();
  });

  it('nudges again once the cooldown has passed', () => {
    seenMinutesAgo(90, 40);
    expect(context(nudge())).not.toBeNull();
  });

  it('is silent when Eklavya is dormant', () => {
    seenMinutesAgo(30);
    configure({ mode: 'off' });
    expect(context(nudge())).toBeNull();
  });

  it('still fires when quiet is set, because quiet is about the banner', () => {
    // This is an additionalContext line the model reads, exactly like the
    // session-start directive it restates -- not something the developer looks
    // at. Gating it on `quiet` was defended as consistency with that directive,
    // which was itself wrongly suppressed; together they made a preference
    // about greetings into a silent off switch.
    seenMinutesAgo(30);
    configure({ quiet: true });
    expect(context(nudge())).toMatch(/log_session_concepts/);
  });

  it('is silent inside a subagent — the parent thread is the one that logs', () => {
    seenMinutesAgo(30);
    expect(context(nudge({ agent_id: 'sub-1' }))).toBeNull();
  });


  it('stops after three nudges, however long the session runs', () => {
    // "logged nothing at all" is also exactly what an unreachable MCP server
    // looks like from here, and that never resolves. Without a cap a long
    // session against a dead server is nudged every 25 minutes forever, each
    // time about a tool that is not registered.
    seenMinutesAgo(600, 60, 3);
    expect(context(nudge())).toBeNull();
    // The cap is the reason, not the cooldown: no nudge was recorded, so the
    // stored count must not have moved either.
    expect(stateValue()!.endsWith('|3')).toBe(true);
  });

  it('counts each nudge it emits, so the cap can be reached', () => {
    seenMinutesAgo(600, 60, 1);
    expect(context(nudge())).not.toBeNull();
    expect(stateValue()!.endsWith('|2')).toBe(true);
  });

  it('reads a row written before the count existed as zero rather than throwing', () => {
    // The count was appended to the value, so the previous two-field shape is
    // still parseable — worth a test, because the alternative was a migration.
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      `prompt_nudge:${SESSION}`,
      `${new Date(Date.now() - 600 * 60_000).toISOString()}|`,
    );
    expect(context(nudge())).not.toBeNull();
    expect(stateValue()!.endsWith('|1')).toBe(true);
  });

  it('is re-armed by SessionStart, so a resume does not restate a fresh directive', () => {
    // SessionStart fires on resume and after a compaction as well as at startup,
    // and reprints the directive every time. The old row would have a spent
    // grace window, so the very next prompt would repeat what was just printed.
    seenMinutesAgo(600, 60, 1);
    sessionStart();
    expect(stateValue()).toBeUndefined();
    expect(context(nudge())).toBeNull();
  });
  it('never breaks a session when there is no database (PRD §9.1)', () => {
    const res = runHook(NUDGE, { session_id: SESSION, cwd }, { EKLAVYA_DB: '/nonexistent/eklavya.db' });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('prunes its own bookkeeping rather than keeping a row per session forever', () => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      'prompt_nudge:ancient',
      `${new Date(Date.now() - 40 * 24 * 3600_000).toISOString()}|`,
    );
    // The prune runs on the first sighting of a new session.
    runHook(NUDGE, { session_id: 'brand-new', cwd, hook_event_name: 'UserPromptSubmit' });
    const gone = db.prepare("SELECT count(*) AS n FROM meta WHERE key = 'prompt_nudge:ancient'").get() as {
      n: number;
    };
    expect(gone.n).toBe(0);
  });
});
