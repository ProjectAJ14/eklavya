import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { conceptBySlug, gradeConcept, logSessionConcept } from '../src/store.js';
import { getCurrentSession, setCurrentSession, setSessionOff } from '../src/session.js';
import { tempDbPath, cleanup } from './helpers.js';

// The built hooks, not the sources: these are what the plugin actually runs,
// and `pretest` builds them. They are Node rather than shell so that Windows,
// where `.sh` hooks are unreliable, runs the same code as everywhere else.
const hooksDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks');
const SESSION_START = path.join(hooksDir, 'session-start.js');
const STOP_CHECK = path.join(hooksDir, 'stop-quiz-check.js');
const CHECKPOINT = path.join(hooksDir, 'checkpoint-quiz.js');
const NUDGE = path.join(hooksDir, 'prompt-submit-nudge.js');
const SUBAGENT = path.join(hooksDir, 'subagent-start.js');

const SESSION = 'hook-session';

let dbFile = '';
let db: DB;
let home = '';
let cwd = '';

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
  /** `hookSpecificOutput.additionalContext`: what the model was handed, if anything. */
  context: string;
  /** Whether the hook said anything at all. Every hook here exits 0, so the exit
   *  code no longer distinguishes "stayed quiet" from "asked for a quiz". */
  spoke: boolean;
}

function runHook(script: string, input: Record<string, unknown>, env: Record<string, string> = {}): HookResult {
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, ...env },
  });
  const stdout = res.stdout ?? '';
  const context = additionalContext(stdout);
  return {
    status: res.status ?? -1,
    stdout,
    stderr: res.stderr ?? '',
    context: context ?? '',
    spoke: context !== null,
  };
}

/** The `additionalContext` a hook wrote, or null when it wrote none. */
function additionalContext(stdout: string): string | null {
  if (!stdout.trim().startsWith('{')) return null;
  try {
    const parsed = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } };
    return parsed.hookSpecificOutput?.additionalContext ?? null;
  } catch {
    return null;
  }
}

/**
 * The concepts line, not the whole message: prose elsewhere may legitimately
 * contain a semicolon, and matching on that made these asserts something they
 * did not mean.
 */
const conceptsLine = (message: string): string =>
  message.split('\n').find((l) => l.startsWith('Concepts:')) ?? '';

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
  return res.spoke ? res.context : null;
}

const sessionStart = (extra: Record<string, unknown> = {}) =>
  runHook(SESSION_START, { session_id: SESSION, cwd, hook_event_name: 'SessionStart', session_start_reason: 'startup', ...extra });

function configure(patch: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(patch));
}

/**
 * Make `cwd` a checkout. Project settings are keyed by one, so only the tests
 * that need project scope opt in -- a blanket `.git` would also re-key the
 * session pointer, which `sessionKeyFor` scopes per checkout on purpose.
 */
function checkout(): void {
  fs.mkdirSync(path.join(cwd, '.git'), { recursive: true });
}

const projectConfigDir = () => path.join(home, 'projects', cwd.replace(/[/\\:]/g, '-'));

/**
 * Settings for the checkout the hooks run in. They live **outside** it, under
 * `<home>/projects/<slug>/`, which is why this writes nothing into `cwd`.
 */
function configureProject(patch: Record<string, unknown>): void {
  checkout();
  fs.mkdirSync(projectConfigDir(), { recursive: true });
  fs.writeFileSync(
    path.join(projectConfigDir(), 'config.json'),
    JSON.stringify({ ...patch, project: cwd }),
  );
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

/**
 * Push both pacing clocks back, so a test about the loop guard or the message body
 * is not also a test of the gap. `min_minutes_between_checkpoints: 0` used to do
 * this job, but the interleaved sweep floors its gap at one minute -- there the
 * clock is the only loop guard, and without a floor a model that ignores the
 * instruction gets blocked again on the very next Stop.
 */
function ageClocks(minutes = 60, session = SESSION): void {
  db.prepare(
    `UPDATE stop_markers SET last_blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now',@off)
      WHERE session_id = @sid`,
  ).run({ sid: session, off: `-${minutes} minutes` });
  db.prepare(`UPDATE attempts SET ts = datetime('now',@off) WHERE session_id = @sid`).run({
    sid: session,
    off: `-${minutes} minutes`,
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-cwd-')));
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

describe('SessionStart never breaks a session', () => {
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

  it('greets in three lines and says nothing has been reused yet on a fresh install', () => {
    // PRD UX-01: a heading, what reuse saved, where this project stands. No
    // scoreboard, no dials, no URL -- somebody has just sat down to work.
    const res = sessionStart();
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/^Eklavya$/m);
    expect(res.stdout).toMatch(/Your savings: — no context reused yet/);
    expect(res.stdout).toMatch(/This project: Learning \d+ · Mastered \d+ · Due \d+/);
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
    expect(res.stdout).toMatch(/This project: Learning/);
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
    expect(res.stdout).not.toMatch(/This project: Learning/);
  });

  it('counts a mastered concept against this project, not against the shipped catalogue', () => {
    // Stamped with a project, as `record_attempt` writes them. The hook's cwd is
    // not a git repository, so that project is the shared `*` bucket.
    logConcepts(['csrf']);
    const csrf = conceptBySlug(db, 'csrf')!;
    db.prepare(
      `INSERT INTO attempts (concept_id, session_id, question, answer, grade, difficulty, repo, level)
       VALUES (?, ?, 'q', 'a', 5, 2, '*', 'easy')`,
    ).run(csrf.id, SESSION);
    answer('csrf', 5);
    answer('csrf', 5);

    const res = sessionStart();
    // One concept touched here; the seed's other 86 are not this project's.
    expect(res.stdout).toMatch(/This project: Learning 0 · Mastered 1 · Due \d+/);
  });

  it('keeps concept names and the dials out of the greeting', () => {
    // Both moved on purpose: the dials to the status bar, the weak list and the
    // profile to the dashboard. A greeting naming concepts is a greeting that
    // grows with the learner until it scrolls.
    logConcepts(['csrf']);
    answer('csrf', 1);
    const res = sessionStart();
    expect(res.stdout).not.toMatch(/Weak: csrf/);
    expect(res.stdout).not.toMatch(/Mode: ambient/);
  });

  it('prints no banner when quiet is set, and still stamps the session', () => {
    configure({ quiet: true });
    const res = sessionStart();
    expect(res.stdout).not.toMatch(/^Eklavya$|This project: Learning|Your savings:/m);
    expect(res.stdout).toMatch(/Standing instruction/);
    expect(db.prepare("SELECT value FROM meta WHERE key='current_session'").get()).toBeTruthy();
  });

  it('drops the banner and the directive when questions are off', () => {
    configure({ quiz: { enabled: false, enforced: false }, quiet: false });
    const out = sessionStart().stdout;
    expect(out).not.toMatch(/Standing instruction/);
    expect(out).not.toMatch(/This project: Learning/);
  });

  // The regression for the bug that retired the `mode` dial. Questions off and
  // nothing recalled yet -- a first session in a repo -- used to print nothing
  // whatsoever, so the only available reading was that the plugin was broken.
  // Memory had been recording the whole time.
  it('still says memory is running when questions are off', () => {
    configure({ quiz: { enabled: false, enforced: false } });
    const out = sessionStart().stdout;
    expect(out).toMatch(/Questions are off/);
    expect(out).toMatch(/Memory is still recording/);
  });

  it('says so plainly when both halves are off, and only then', () => {
    configure({ quiz: { enabled: false, enforced: false }, memory: { enabled: false } });
    const out = sessionStart().stdout;
    expect(out).toMatch(/Questions and memory are both off/);
    expect(out).not.toMatch(/Memory is still recording/);
  });

  it('honours quiet for that line too — it is a banner, not a warning', () => {
    configure({ quiz: { enabled: false, enforced: false }, quiet: true });
    expect(sessionStart().stdout).toBe('');
  });

  it('lets a project config override the global quiz setting', () => {
    configure({ quiz: { enabled: true, enforced: false } });
    configureProject({ quiz: { enabled: false } });
    expect(sessionStart().stdout).not.toMatch(/Standing instruction/);
  });

  // The retired spelling, still arriving from a config written years ago.
  it('reads a project `mode: off` as the same thing', () => {
    configure({ quiz: { enabled: true, enforced: false } });
    configureProject({ mode: 'off' });
    expect(sessionStart().stdout).not.toMatch(/Standing instruction/);
  });

  // The automatic, silent move. A settings file in a checkout was a mistake to
  // undo, not a choice to confirm, so nothing is printed and nothing is asked.
  it('lifts a leftover .eklavya.json out of the checkout, saying nothing', () => {
    configure({ quiz: { enabled: true, enforced: false } });
    checkout();
    const legacy = path.join(cwd, '.eklavya.json');
    fs.writeFileSync(legacy, JSON.stringify({ quiz: { enabled: false } }));

    const out = sessionStart().stdout;
    expect(fs.existsSync(legacy)).toBe(false);
    expect(out).not.toMatch(/\.eklavya\.json|migrat/i);

    // And the settings it held are in force from the very session that moved it.
    const moved = path.join(projectConfigDir(), 'config.json');
    expect(JSON.parse(fs.readFileSync(moved, 'utf8'))).toMatchObject({
      quiz: { enabled: false },
      project: cwd,
    });
    expect(out).not.toMatch(/Standing instruction/);
  });

  it('keeps the newer project config when both exist, and still removes the old file', () => {
    configureProject({ focus: 'concept' });
    const legacy = path.join(cwd, '.eklavya.json');
    fs.writeFileSync(legacy, JSON.stringify({ focus: 'project', cadence: 'end' }));

    sessionStart();
    expect(fs.existsSync(legacy)).toBe(false);
    const moved = path.join(projectConfigDir(), 'config.json');
    const merged = JSON.parse(fs.readFileSync(moved, 'utf8')) as Record<string, unknown>;
    // The file that was already outside the checkout wins...
    expect(merged.focus).toBe('concept');
    // ...and nothing the old one held is dropped on the floor.
    expect(merged.cadence).toBe('end');
  });
});

// ---------------------------------------------------------------------------

describe('Stop hook — the loop guard (P0)', () => {
  it('never blocks inside a subagent, which cannot answer and is not being read', () => {
    // Exit 2 here would tell an agent with no AskUserQuestion to run a quiz, in
    // a transcript nobody sees, up to max_stop_blocks_per_session times. Before
    // subagent-start.ts a subagent logged nothing, so the `logged > last_logged`
    // predicate could not arm; that hook is what made this path reachable.
    logConcepts(['csrf', 'jwt-structure']);
    expect(stop({ agent_id: 'sub-1' }).spoke).toBe(false);
    // And the work is still there for the parent's own Stop to pick up.
    expect(stop().spoke).toBe(true);
  });

  it('blocks exactly once for one batch of work, however many times Claude stops', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'end' });
    logConcepts(['csrf', 'jwt-structure']);

    const first = stop();
    expect(first.spoke).toBe(true);
    expect(first.context).toMatch(/csrf/);

    // Every subsequent Stop must pass. This is the difference between a quiz
    // and an infinite loop.
    for (let i = 0; i < 5; i += 1) {
      expect(stop().spoke, `stop #${i + 2} blocked again`).toBe(false);
    }
  });

  it('does not re-block after the developer skips', () => {
    logConcepts(['csrf', 'jwt-structure']);
    expect(stop().spoke).toBe(true);

    answer('csrf', 0);
    answer('jwt-structure', 0);

    expect(stop().spoke).toBe(false);
  });

  it('does not re-block after the quiz is answered well', () => {
    logConcepts(['csrf']);
    expect(stop().spoke).toBe(true);

    answer('csrf', 5);
    answer('csrf', 5);

    expect(stop().spoke).toBe(false);
  });

  it('arms again only when genuinely new work is logged', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'end' });
    logConcepts(['csrf']);
    expect(stop().spoke).toBe(true);
    expect(stop().spoke).toBe(false);

    logConcepts(['jwt-structure']);
    expect(stop().spoke).toBe(true);
    expect(stop().spoke).toBe(false);
  });

  it('re-logging the same concepts does not re-arm it', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'end' });
    logConcepts(['csrf', 'jwt-structure']);
    expect(stop().spoke).toBe(true);

    logConcepts(['csrf', 'jwt-structure']);
    expect(stop().spoke).toBe(false);
  });

  it('stops blocking entirely after the per-session cap, even with new work', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'end', max_stop_blocks_per_session: 2 });

    logConcepts(['csrf']);
    expect(stop().spoke).toBe(true);
    logConcepts(['jwt-structure']);
    expect(stop().spoke).toBe(true);
    logConcepts(['pkce']);
    expect(stop().spoke).toBe(false);
  });

  // --- interleaved: the clock is the guard ----------------------------------
  // The `logged > last_logged` rule above re-arms only on newly logged work, and
  // the model logs its whole batch in one call at the start of a task. Under
  // `interleaved` that made the sweep a once-per-session event: a session that
  // logged eight concepts was asked one question against a budget of four.

  it('re-arms on the clock under interleaved: one batch of work is more than one question', () => {
    configure({ min_minutes_between_quizzes: 0, min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf', 'jwt-structure']);

    // No new work logged between any of these, which is the point: it is time
    // that re-arms the sweep, not a fresh log_session_concepts call.
    expect(stop().spoke).toBe(true);
    ageClocks();
    expect(stop().spoke).toBe(true);
    ageClocks();
    expect(stop().spoke).toBe(true);

    // And max_stop_blocks_per_session still ends it.
    ageClocks();
    expect(stop().spoke).toBe(false);
  });

  it('floors the interleaved gap at a minute, so a gap of 0 is not a loop', () => {
    // `0` is a supported value and means "every seam" for the PostToolUse
    // checkpoint, which has a logged concept behind each firing. A Stop sweep has
    // no such event, so at 0 a model that ignores the instruction and stops again
    // immediately would be blocked again immediately, three times over.
    configure({ min_minutes_between_quizzes: 0, min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf', 'jwt-structure']);

    expect(stop().spoke).toBe(true);
    expect(stop().spoke, 'blocked twice inside the floor').toBe(false);
    expect(stop().spoke, 'blocked twice inside the floor').toBe(false);
  });

  it('does not loop under interleaved: repeat Stops inside the pacing gap pass', () => {
    // The default min_minutes_between_checkpoints of 4, left alone. This is the
    // interleaved counterpart of "blocks exactly once for one batch of work":
    // what bounds it is the clock rather than the logged count.
    configure({ min_minutes_between_quizzes: 0 });
    logConcepts(['csrf', 'jwt-structure']);

    expect(stop().spoke).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      expect(stop().spoke, `stop #${i + 2} blocked inside the gap`).toBe(false);
    }
  });

  it('paces interleaved on the checkpoint clock, never the quiz clock', () => {
    // A whole-quiz cooldown gating a one-question sweep was the bug: the
    // checkpoint question the learner had just answered silenced the sweep for
    // the rest of a normal-length task.
    configure({ min_minutes_between_quizzes: 600, min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf', 'jwt-structure']);

    expect(stop().spoke).toBe(true);
    // Two minutes on: past the checkpoint clock (floored at one), nowhere near the
    // 600-minute quiz clock. Blocking here is the whole claim.
    ageClocks(2);
    expect(stop().spoke).toBe(true);
  });

  it('an answered question paces the next block, not just the block itself', () => {
    configure({ min_minutes_between_quizzes: 0 });
    logConcepts(['csrf', 'jwt-structure']);
    expect(stop().spoke).toBe(true);

    // Age the block out, so the block clock alone would let the next one through.
    db.prepare(
      `UPDATE stop_markers SET last_blocked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now','-60 minutes')
        WHERE session_id = ?`,
    ).run(SESSION);

    // Now only the answer is recent. Answering is what the block asked for, and
    // the gap has to run from it too, or the developer is asked again the moment
    // they finish typing.
    answer('csrf', 3);
    expect(stop().spoke).toBe(false);

    // And once that ages out too, it comes back -- the concept is still unasked.
    db.prepare(`UPDATE attempts SET ts = datetime('now','-60 minutes') WHERE session_id = ?`).run(SESSION);
    expect(stop().spoke).toBe(true);
  });

  it('stops at the session budget, with blocks still to spare', () => {
    configure({
      min_minutes_between_quizzes: 0,
      min_minutes_between_checkpoints: 0,
      max_questions_per_task: 1,
    });
    logConcepts(['csrf', 'jwt-structure']);

    // One question is the whole budget and it is already spent -- by a checkpoint,
    // a manual quiz, an earlier sweep, it does not matter which. Every attempts
    // row counts against the same allowance.
    answer('csrf', 3);
    expect(stop().spoke).toBe(false);
  });

  it('leaves enforced quizzing on the original rule, clock and all', () => {
    // Enforced is exempt from the pacing clock (decision G5), so the clock cannot
    // be its guard -- it keeps `logged > last_logged` or it would block on every
    // single Stop until the cap.
    configure({ quiz: { enabled: true, enforced: true }, cadence: 'interleaved', min_minutes_between_quizzes: 0 });
    logConcepts(['csrf']);

    expect(stop().spoke).toBe(true);
    expect(stop().spoke).toBe(false);
  });

  it('honors stop_hook_active if the harness still sends it', () => {
    logConcepts(['csrf']);
    expect(stop({ stop_hook_active: true }).spoke).toBe(false);
  });
});

describe('Stop hook — when not to fire', () => {
  it('passes when the session touched nothing', () => {
    expect(stop().spoke).toBe(false);
  });

  it('passes when every touched concept is already mastered', () => {
    logConcepts(['csrf']);
    answer('csrf', 5);
    answer('csrf', 5);
    expect(stop().spoke).toBe(false);
  });

  it('passes when questions are off', () => {
    configure({ quiz: { enabled: false, enforced: false } });
    logConcepts(['csrf']);
    expect(stop().spoke).toBe(false);
  });

  it('respects the unenforced cooldown', () => {
    configure({ quiz: { enabled: true, enforced: false }, cadence: 'end', min_minutes_between_quizzes: 60 });
    logConcepts(['csrf']);
    expect(stop().spoke).toBe(true);

    logConcepts(['jwt-structure']);
    expect(stop().spoke).toBe(false);
  });

  it('ignores the cooldown in enforced mode, or the gate could never be passed', () => {
    configure({ mode: 'enforced', min_minutes_between_quizzes: 60 });
    logConcepts(['csrf']);
    expect(stop().spoke).toBe(true);

    logConcepts(['jwt-structure']);
    expect(stop().spoke).toBe(true);
  });

  it('passes when every touched concept has already been asked about', () => {
    logConcepts(['csrf']);
    // Grade 3 leaves it unmastered, so only the already-asked filter stops this.
    answer('csrf', 3);
    logConcepts(['csrf']);
    expect(stop().spoke).toBe(false);
  });

  it('still fires for concepts logged after the quiz', () => {
    configure({ min_minutes_between_quizzes: 0, min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);
    answer('csrf', 3);
    logConcepts(['jwt-structure']);
    ageClocks(2);
    const res = stop();
    expect(res.spoke).toBe(true);
    expect(res.context).toMatch(/jwt-structure/);
    expect(res.context).not.toMatch(/csrf/);
  });

  it('does not block a turn the quiz plan would then refuse as too soon', () => {
    // A manual /eklavya:quiz just happened; the cooldown is measured from the
    // answer, not only from the last block, or Claude is told to teach and then
    // handed questions_needed: 0.
    configure({ mode: 'ambient', cadence: 'end', min_minutes_between_quizzes: 60 });
    logConcepts(['csrf']);
    answer('csrf', 3);
    logConcepts(['jwt-structure']);
    expect(stop().spoke).toBe(false);
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
    expect(res.spoke).toBe(true);
    expect(res.context).toMatch(/csrf/);
  });

  it('falls back to the stamped session when the input has no session_id', () => {
    logConcepts(['csrf'], 'stamped-session');
    db.prepare("INSERT INTO meta (key, value) VALUES ('current_session', 'stamped-session')").run();

    const res = runHook(STOP_CHECK, { cwd, hook_event_name: 'Stop' });
    expect(res.spoke).toBe(true);
  });
});

describe('Stop hook — what it tells Claude', () => {
  it('names the concepts and the code context behind them', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'end' });
    logConcepts(['csrf', 'jwt-structure']);
    const res = stop();
    expect(res.context).toMatch(/csrf \(touched csrf in auth\.ts\)/);
    expect(res.context).toMatch(/get_session_quiz_plan/);
    expect(res.context).toMatch(/ONE question at a time/);
  });

  // The cadence decides the size of the sweep, and this is the failure it was
  // written for: three questions in a row at the exact moment the developer
  // wanted to be finished, under the setting that promises the opposite.
  it('sweeps one concept only under the interleaved cadence', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'interleaved' });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);
    const res = stop();
    const line = conceptsLine(res.context);
    expect(line).toMatch(/csrf/);
    expect(line.match(/;/g) ?? []).toHaveLength(0);
    expect(res.context).toMatch(/One question, then let them finish/);
    expect(res.context).not.toMatch(/ONE question at a time/);
  });

  it('sweeps the whole remaining budget in enforced mode, cadence notwithstanding', () => {
    // Decision G5 again: the gate has to stay passable inside the session.
    configure({ quiz: { enabled: true, enforced: true }, cadence: 'interleaved', min_minutes_between_quizzes: 0 });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);
    expect(conceptsLine(stop().context).match(/;/g) ?? []).toHaveLength(2);
  });

  it('sweeps the whole remaining budget under the end cadence', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'end' });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);
    const line = conceptsLine(stop().context);
    expect(line.match(/;/g) ?? []).toHaveLength(2);
  });

  it('caps the list at the configured questions per task', () => {
    configure({ min_minutes_between_quizzes: 0, max_questions_per_task: 1 });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);
    const res = stop();
    const line = conceptsLine(res.context);
    expect(line).toMatch(/csrf/);
    expect(line.match(/;/g) ?? []).toHaveLength(0);
  });

  it('says the gate needs it when enforced, and offers the skip when not', () => {
    configure({ quiz: { enabled: true, enforced: true }, min_minutes_between_quizzes: 0 });
    logConcepts(['csrf']);
    expect(stop().context).toMatch(/Quizzing is enforced/);

    configure({ quiz: { enabled: true, enforced: false }, min_minutes_between_quizzes: 0, min_minutes_between_checkpoints: 0 });
    logConcepts(['jwt-structure']);
    ageClocks();
    expect(stop().context).toMatch(/say skip/);
  });
});

// ---------------------------------------------------------------------------

/**
 * Both hooks spell out how to sign a question, and the answer depends on a host
 * only the hook process can see. These run the real scripts with the entrypoint
 * Claude Desktop stamps, because a unit test of `attributionRule` proves the
 * sentence is composed and not that either hook reached for it.
 */
describe('Both hooks sign the question for the host they are running on', () => {
  const desktop = { CLAUDE_CODE_ENTRYPOINT: 'claude-desktop' };
  const terminal = { CLAUDE_CODE_ENTRYPOINT: 'cli' };

  const stopOn = (env: Record<string, string>) =>
    runHook(STOP_CHECK, { session_id: SESSION, cwd, hook_event_name: 'Stop', stop_reason: 'end_turn' }, env);

  const checkpointOn = (env: Record<string, string>) =>
    checkpointContext(
      runHook(
        CHECKPOINT,
        {
          session_id: SESSION,
          cwd,
          hook_event_name: 'PostToolUse',
          tool_name: 'mcp__eklavya__log_session_concepts',
          tool_input: { concepts: [{ slug: 'csrf' }] },
        },
        env,
      ),
    );

  it('asks the Stop sweep for a stem prefix on Desktop and for the chip alone in a terminal', () => {
    configure({ min_minutes_between_quizzes: 0, cadence: 'end' });
    logConcepts(['csrf']);
    expect(stopOn(desktop).context).toMatch(/\[Eklavya\]/);

    configure({ min_minutes_between_quizzes: 0, cadence: 'end' });
    logConcepts(['jwt-structure']);
    const plain = stopOn(terminal).context;
    expect(plain).toMatch(/Header "Eklavya"/);
    expect(plain).not.toMatch(/\[Eklavya\]/);
  });

  it('does the same at the mid-work checkpoint', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);
    expect(checkpointOn(desktop)).toMatch(/\[Eklavya\]/);

    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['jwt-structure']);
    const plain = checkpointOn(terminal)!;
    expect(plain).toMatch(/Header "Eklavya"/);
    expect(plain).not.toMatch(/\[Eklavya\]/);
  });

  // The status bar is the terminal's half of the same job. Telling a Desktop
  // learner the dials are in a bar they do not have is how the first version of
  // this went wrong.
  it('never points a Desktop session at a status bar it does not have', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);
    expect(checkpointOn(desktop)).not.toMatch(/status bar/);
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
    configureProject({ cadence: 'end' });
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
    expect(stop().spoke).toBe(false);
  });

  it('sweeps up only the remainder', () => {
    configure({
      min_minutes_between_quizzes: 0,
      min_minutes_between_checkpoints: 0,
      max_questions_per_task: 2,
    });
    logConcepts(['csrf', 'jwt-structure', 'pkce']);

    answer('csrf', 3);
    ageClocks(2);

    const res = stop();
    expect(res.spoke).toBe(true);
    // One left in the budget, so one concept named -- not the other two.
    const named = ['jwt-structure', 'pkce'].filter((slug) => res.context.includes(slug));
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
    expect(res.stdout).toContain('Level easy (2/100)');
  });

  it('starts at easy with nothing answered', () => {
    expect(sessionStart().stdout).toContain('Level easy (0/100)');
  });

  it('follows a shortened runway', () => {
    configure({ min_minutes_between_quizzes: 0, level_up_after: 20 });
    answerIn('*', 'csrf', 5);
    expect(sessionStart().stdout).toContain('Level easy (1/20)');
  });

  it('says so when the level is pinned, rather than showing a runway nobody is on', () => {
    configure({ min_minutes_between_quizzes: 0, difficulty: 'hard' });
    expect(sessionStart().stdout).toContain('Level hard (pinned)');
  });

  it('reads the level a promotion wrote', () => {
    db.prepare(
      `INSERT INTO project_levels (repo, level, promoted_at) VALUES ('*', 'medium', datetime('now','-1 day'))`,
    ).run();
    answerIn('*', 'csrf', 4); // easy-band evidence, spent with the old level
    expect(sessionStart().stdout).toContain('Level medium (0/100)');
  });

  it('names difficulty when this project pins it over the learner’s own setting', () => {
    configure({ difficulty: 'auto' });
    configureProject({ difficulty: 'easy' });
    expect(sessionStart().stdout).toContain('override your global ones for: difficulty');
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
  it('never breaks a session when there is no database', () => {
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

describe('the SubagentStart directive', () => {
  const subagent = (extra: Record<string, unknown> = {}) =>
    runHook(SUBAGENT, {
      session_id: SESSION,
      cwd,
      hook_event_name: 'SubagentStart',
      agent_id: 'sub-1',
      agent_type: 'general-purpose',
      ...extra,
    });

  /**
   * Raw stdout is context on SessionStart and is dropped on SubagentStart, so
   * "it printed something" is not the assertion that matters -- parsing the
   * documented envelope is.
   */
  const additionalContext = (res: HookResult): string | null => {
    // Exit 2 is a *blocking* error. On this event that kills the delegated task
    // before it starts, and every assertion below passed while it did.
    expect(res.status).toBe(0);
    if (!res.stdout.trim()) return null;
    const parsed = JSON.parse(res.stdout) as {
      hookSpecificOutput?: { hookEventName?: string; additionalContext?: string };
    };
    expect(parsed.hookSpecificOutput?.hookEventName).toBe('SubagentStart');
    return parsed.hookSpecificOutput?.additionalContext ?? null;
  };

  /** Silent AND non-blocking: a hook that exits 2 without output still kills the task. */
  const silent = (res: HookResult): boolean => {
    expect(res.status).toBe(0);
    return res.stdout === '';
  };

  it('tells an implementer subagent to log, in the hookSpecificOutput form', () => {
    const ctx = additionalContext(subagent());
    expect(ctx).toContain('log_session_concepts');
  });

  it('tells it not to ask a question, because nobody is watching the transcript', () => {
    // checkpoint-quiz.ts returns on agent_id for the same reason. A directive
    // that invited a question here would undo that guard in prose.
    expect(additionalContext(subagent())).toMatch(/do not ask/i);
  });

  it('stays silent for eklavya-tutor, whose whole job is to quiz', () => {
    // The directive orders a subagent not to ask the developer anything, which
    // is the one thing agents/tutor.md exists to do (docs/parallel-tutoring.md,
    // Option A). Delivering it there disables parallel tutoring in silence.
    expect(silent(subagent({ agent_type: 'eklavya-tutor' }))).toBe(true);
  });

  it('recognises the tutor however it was installed', () => {
    // Bare as a user-level agent, `<plugin>:<name>` through /plugin.
    expect(silent(subagent({ agent_type: 'eklavya:eklavya-tutor' }))).toBe(true);
  });

  it('does not swallow a different Eklavya agent on a loose match', () => {
    // `includes('eklavya')` or `includes('tutor')` would pass every other test
    // in this block, because general-purpose was the only non-tutor fixture.
    expect(additionalContext(subagent({ agent_type: 'eklavya-explorer' }))).toContain(
      'log_session_concepts',
    );
  });

  it('speaks when agent_type is absent: it fails open, on purpose', () => {
    // A host that does not send the field is a host where failing closed would
    // kill the feature silently. The cost of this direction is a tutor that
    // logs instead of quizzing, which the developer is watching for.
    const res = runHook(SUBAGENT, { session_id: SESSION, cwd, hook_event_name: 'SubagentStart' });
    expect(additionalContext(res)).toContain('log_session_concepts');
  });

  it('says nothing at all when mode is off', () => {
    configure({ mode: 'off' });
    expect(silent(subagent())).toBe(true);
  });

  it('still speaks when quiet is set: quiet hides output, not context', () => {
    // hooks/CLAUDE.md, "`quiet` is not an off switch". session-start.ts once
    // returned early here and silently turned the whole product off.
    configure({ quiet: true });
    expect(additionalContext(subagent())).toContain('log_session_concepts');
  });

  it('speaks on a fresh install with no database yet', () => {
    // A delegated task may be the first thing in a session to touch Eklavya.
    const res = runHook(
      SUBAGENT,
      { session_id: SESSION, cwd, agent_type: 'general-purpose' },
      { EKLAVYA_DB: '/nonexistent/eklavya.db' },
    );
    expect(res.status).toBe(0);
    expect(additionalContext(res)).toContain('log_session_concepts');
  });

  it('never breaks a session on unparseable input', () => {
    const res = spawnSync(process.execPath, [SUBAGENT], {
      input: 'not json at all',
      encoding: 'utf8',
      env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home },
    });
    expect(res.status).toBe(0);
  });
});

// ---------------------------------------------------------------------------

/**
 * "Turn Eklavya off, just for this session."
 *
 * The switch exists because the alternative people reach for — `mode: off` in
 * the global config — is silence that outlives the urgent afternoon that
 * wanted it. Every hook has to honour it or it is not an off switch, so every
 * hook is asserted here rather than the one that happened to be interesting.
 */
describe('the per-session off switch', () => {
  const nudge = () =>
    runHook(NUDGE, { session_id: SESSION, cwd, hook_event_name: 'UserPromptSubmit' });
  const subagent = () =>
    runHook(SUBAGENT, {
      session_id: SESSION,
      cwd,
      hook_event_name: 'SubagentStart',
      agent_type: 'general-purpose',
    });

  beforeEach(() => setSessionOff(db, SESSION, true));

  it('does not block the Stop hook, even in enforced mode', () => {
    // Enforced mode is the interesting case: this silences the interruption,
    // and the commit gate — which reads the project config, not this — still holds.
    configure({ mode: 'enforced' });
    logConcepts(['csrf']);
    expect(stop().spoke).toBe(false);
  });

  it('asks no mid-work checkpoint question', () => {
    configure({ min_minutes_between_checkpoints: 0 });
    logConcepts(['csrf']);
    expect(checkpointContext(checkpoint())).toBeNull();
  });

  it('prints no banner on a resume', () => {
    expect(sessionStart({ session_start_reason: 'resume' }).stdout).toBe('');
  });

  it('sends no logging nudge', () => {
    // Past the grace window with nothing logged: the one state in which this
    // hook does speak, so silence here is the switch and not the clock.
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(
      `prompt_nudge:${SESSION}`,
      `${new Date(Date.now() - 30 * 60_000).toISOString()}||0`,
    );
    expect(nudge().stdout).toBe('');
  });

  it('sends no directive to a delegated subagent', () => {
    const res = subagent();
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('leaves the session pointer naming this session, so it can be turned back on', () => {
    // The model cannot see its own session id, so set_config resolves it from
    // the session pointer. session-start stamps that once — whichever session
    // started last in this checkout wins — and with two open sessions the model
    // would silence the wrong one. Every prompt re-stamps it.
    setSessionOff(db, SESSION, false);
    setCurrentSession(db, 'some-other-session', cwd);
    runHook(NUDGE, { session_id: SESSION, cwd, hook_event_name: 'UserPromptSubmit' });
    expect(getCurrentSession(db, cwd)).toBe(SESSION);
  });

  it('does not bind a checkout to a session id it only read from elsewhere', () => {
    // `sessionId()` falls through to the pointer when the harness sends no
    // `session_id`, and the hook then stamps what it read. If that read could
    // reach another checkout's row, the hook would write a foreign session id
    // into its own pointer — where it wins from then on, outliving the session
    // it names, so this repo's work would file under a dead id for good.
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-c-'));
    fs.mkdirSync(path.join(mine, '.git'));
    try {
      setCurrentSession(db, 'a-live-session-in-another-repo', cwd);

      runHook(SESSION_START, {
        cwd: mine,
        hook_event_name: 'SessionStart',
        session_start_reason: 'startup',
      });

      expect(getCurrentSession(db, mine)).toBe(null);
    } finally {
      fs.rmSync(mine, { recursive: true, force: true });
    }
  });

  it('re-stamps only its own checkout, so a prompt here cannot hijack another repo', () => {
    // The bug this prevents: two sessions, two repos, one database. A model that
    // churns for ten minutes calls its tools long after the developer typed in
    // the other window, and with a single global pointer every one of those
    // calls — log_session_concepts included — lands in the other session. A
    // talea session asked about D-Pilot's `app.use('/d-pilot', router)` this way.
    // Two checkouts, because the pointer is keyed on the git root: `cwd` itself
    // has no `.git` and would share the unkeyed row with everything else.
    const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-a-'));
    const theirs = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-b-'));
    fs.mkdirSync(path.join(mine, '.git'));
    fs.mkdirSync(path.join(theirs, '.git'));
    try {
      setCurrentSession(db, 'other-repo-session', theirs);
      setCurrentSession(db, 'this-repo-session', mine);

      runHook(NUDGE, { session_id: SESSION, cwd: mine, hook_event_name: 'UserPromptSubmit' });

      expect(getCurrentSession(db, mine)).toBe(SESSION);
      expect(getCurrentSession(db, theirs)).toBe('other-repo-session');
    } finally {
      fs.rmSync(mine, { recursive: true, force: true });
      fs.rmSync(theirs, { recursive: true, force: true });
    }
  });

  it('silences that session only', () => {
    logConcepts(['csrf'], 'other-session');
    const res = runHook(STOP_CHECK, {
      session_id: 'other-session',
      cwd,
      hook_event_name: 'Stop',
      stop_reason: 'end_turn',
    });
    expect(res.spoke).toBe(true);
  });

  it('comes back when the switch is cleared', () => {
    setSessionOff(db, SESSION, false);
    logConcepts(['csrf']);
    expect(stop().spoke).toBe(true);
  });
});
