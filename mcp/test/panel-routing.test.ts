import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../src/db.js';
import { conceptBySlug, logSessionConcept } from '../src/store.js';
import { attributionRule } from '../src/surface.js';
import { framingFor } from '../src/hooks/lib.js';
import { nudge, promptLine, sessionBlock } from '../src/hooks/delegation-lib.js';
import {
  hasOpenPanelQuestion,
  panelPresentation,
  PANEL_HEARTBEAT_TTL_MS,
  PANEL_SURFACES,
  recordHeartbeat,
} from '../src/panel-state.js';
import { panelSync, presentQuestion } from '../src/panel.js';
import { answerPosition } from '../src/mcq.js';
import { getSessionQuizPlan } from '../src/tools/get_session_quiz_plan.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { tempDbPath, cleanup } from './helpers.js';

const hooksDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'dist', 'hooks');
const STOP_CHECK = path.join(hooksDir, 'stop-quiz-check.js');
const CHECKPOINT = path.join(hooksDir, 'checkpoint-quiz.js');
const SESSION_START = path.join(hooksDir, 'session-start.js');
const NUDGE = path.join(hooksDir, 'prompt-submit-nudge.js');

const SESSION = 'route-session';

let dbFile = '';
let db: DB;
let home = '';
let cwd = '';
const envBackup = { ...process.env };

function configure(panel: boolean | undefined, extra: Record<string, unknown> = {}): void {
  const quiz = { only_on_changes: false, ...(panel === undefined ? {} : { panel }) };
  fs.writeFileSync(
    path.join(home, 'config.json'),
    JSON.stringify({ focus: 'project', cadence: 'as-you-go', min_minutes_between_checkpoints: 0, min_minutes_between_quizzes: 0, ...extra, quiz }),
  );
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-route-home-'));
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-route-cwd-')));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
  delete process.env.EKLAVYA_SURFACE;
  dbFile = tempDbPath('route');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  process.env = { ...envBackup };
});

const beat = (session = SESSION, surface = 'terminal', placed?: boolean, at = new Date()) =>
  recordHeartbeat(db, session, { surface }, placed, at);

function logConcepts(slugs: string[], session = SESSION): void {
  for (const slug of slugs) logSessionConcept(db, session, conceptBySlug(db, slug)!.id, `touched ${slug} in auth.ts`);
}

/** A question waiting in the panel for the session, as `present_question` would leave it. */
function openQuestion(session = SESSION, phase = 'pending', ageHours = 0): void {
  db.prepare('INSERT OR IGNORE INTO concepts (id, slug, name, domain) VALUES (900, ?, ?, ?)').run('panel-fixture', 'Panel fixture', 'test');
  db.prepare(
    `INSERT INTO panel_questions (id, session_id, repo, concept_id, tier, stem, options, key, explanation, phase, created_at)
     VALUES (?, ?, ?, 900, 1, 'q', '[]', '{}', 'e', ?, datetime('now', ?))`,
  ).run(`q-${session}-${phase}-${ageHours}`, session, '*', phase, `-${ageHours} hours`);
}

interface HookResult {
  status: number;
  stdout: string;
  context: string;
  spoke: boolean;
}

function runHook(script: string, input: Record<string, unknown>, env: Record<string, string> = {}): HookResult {
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, EKLAVYA_DB: dbFile, EKLAVYA_HOME: home, ...env },
  });
  const stdout = res.stdout ?? '';
  let context: string | null = null;
  if (stdout.trim().startsWith('{')) context = (JSON.parse(stdout) as any).hookSpecificOutput?.additionalContext ?? null;
  return { status: res.status ?? -1, stdout, context: context ?? '', spoke: context !== null };
}

const checkpoint = () =>
  runHook(CHECKPOINT, {
    session_id: SESSION,
    cwd,
    hook_event_name: 'PostToolUse',
    tool_name: 'mcp__eklavya__log_session_concepts',
    tool_input: { concepts: [{ slug: 'csrf' }] },
  });
const stop = () => runHook(STOP_CHECK, { session_id: SESSION, cwd, hook_event_name: 'Stop', stop_reason: 'end_turn' });

describe('the panel heartbeat and where the next question goes', () => {
  it('is the card while the setting is off, however fresh the heartbeat', () => {
    beat();
    expect(panelPresentation(db, { quiz: { panel: false } }, SESSION)).toBe('tool');
  });

  it('is the panel only for a fresh heartbeat from a surface that takes answers', () => {
    const on = { quiz: { panel: true } };
    expect(panelPresentation(db, on, SESSION)).toBe('tool'); // no heartbeat yet
    beat();
    expect(panelPresentation(db, on, SESSION)).toBe('panel');
    expect(PANEL_SURFACES).toEqual(['terminal', 'desktop']);
    // The boundary is inclusive; one millisecond past it the mod is gone.
    const at = new Date();
    beat(SESSION, 'terminal', undefined, at);
    expect(panelPresentation(db, on, SESSION, new Date(at.getTime() + PANEL_HEARTBEAT_TTL_MS))).toBe('panel');
    expect(panelPresentation(db, on, SESSION, new Date(at.getTime() + PANEL_HEARTBEAT_TTL_MS + 1))).toBe('tool');
    // A surface nobody has tried is a surface that keeps the card.
    beat(SESSION, 'vscode');
    expect(panelPresentation(db, on, SESSION)).toBe('tool');
    // The Desktop Code tab is enabled, but a host that could not seat the pane keeps the card.
    beat(SESSION, 'desktop');
    expect(panelPresentation(db, on, SESSION)).toBe('panel');
    beat(SESSION, 'desktop', false);
    expect(panelPresentation(db, on, SESSION)).toBe('tool');
    beat(SESSION, 'terminal', true);
    expect(panelPresentation(db, on, SESSION)).toBe('panel');
  });

  it('keeps the card for another session\'s heartbeat, and on Cowork', () => {
    const on = { quiz: { panel: true } };
    beat('someone-else');
    expect(panelPresentation(db, on, SESSION)).toBe('tool');
    beat();
    process.env.EKLAVYA_SURFACE = 'cowork';
    expect(panelPresentation(db, on, SESSION)).toBe('tool');
  });

  it('keeps the card after the host failed to seat a pane, until one is seated', () => {
    const on = { quiz: { panel: true } };
    beat(SESSION, 'terminal', false);
    expect(panelPresentation(db, on, SESSION)).toBe('tool');
    // A sync that says nothing about placement keeps the last word.
    beat(SESSION, 'terminal', undefined);
    expect(panelPresentation(db, on, SESSION)).toBe('tool');
    beat(SESSION, 'terminal', true);
    expect(panelPresentation(db, on, SESSION)).toBe('panel');
  });

  it('keeps the card when the stored heartbeat cannot be read, or the database has no meta', () => {
    const on = { quiz: { panel: true } };
    db.prepare("INSERT INTO meta (key, value) VALUES (?, 'not json')").run(`panel_hb:${SESSION}`);
    expect(panelPresentation(db, on, SESSION)).toBe('tool');
    db.exec('DROP TABLE meta');
    expect(panelPresentation(db, on, SESSION)).toBe('tool');
  });

  it('drops heartbeats a day old as new ones are written', () => {
    const now = new Date();
    beat('old-session', 'terminal', undefined, new Date(now.getTime() - 25 * 3600_000));
    beat('recent-session', 'terminal', undefined, new Date(now.getTime() - 23 * 3600_000));
    beat(SESSION, 'terminal', undefined, now);
    const keys = (db.prepare("SELECT key FROM meta WHERE key LIKE 'panel_hb:%' ORDER BY key").all() as { key: string }[]).map((r) => r.key);
    expect(keys).toEqual(['panel_hb:recent-session', `panel_hb:${SESSION}`]);
  });
});

describe('an open question', () => {
  it('is waiting while pending, unplaced or grading, and not once closed or a day old', () => {
    expect(hasOpenPanelQuestion(db, SESSION)).toBe(false);
    for (const phase of ['pending', 'unplaced', 'grading']) {
      db.prepare('DELETE FROM panel_questions').run();
      openQuestion(SESSION, phase);
      expect(hasOpenPanelQuestion(db, SESSION), phase).toBe(true);
    }
    expect(hasOpenPanelQuestion(db, 'another-session')).toBe(false);
    db.prepare('DELETE FROM panel_questions').run();
    openQuestion(SESSION, 'answered');
    openQuestion(SESSION, 'pending', 25);
    expect(hasOpenPanelQuestion(db, SESSION)).toBe(false);
  });

  it('is never open in a database that has no panel table yet', () => {
    db.exec('DROP TABLE panel_questions');
    expect(hasOpenPanelQuestion(db, SESSION)).toBe(false);
  });
});

const LABELS = ['Tokens are checked by the server', 'Cookies are signed', 'The origin is compared', 'The body is hashed'];
function options(slug: string) {
  const at = answerPosition(slug, 0) - 1;
  let d = 0;
  return LABELS.map((label, i) => ({ label, description: `note ${i}`, grade: i === at ? 4 : [2, 1, 2][d++]!, ...(i === at ? { correct: true } : {}) }));
}

describe('off is inert', () => {
  it('registers nothing, keeps no heartbeat and shows no row', () => {
    configure(false);
    openQuestion();
    expect(panelSync(db, { session_id: SESSION, cwd, host: { surface: 'terminal' } })).toEqual({ disabled: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'panel_hb:%'").get()).toEqual({ n: 0 });
  });

  it('plans with the card, attribution included, whatever the heartbeat says', () => {
    configure(false);
    beat();
    logConcepts(['csrf']);
    const plan = getSessionQuizPlan.handler({ cwd, session_id: SESSION }, { db }) as any;
    expect(plan.presentation).toBe('tool');
    expect(plan.ask_attribution).toBe(attributionRule());
    expect(plan.on_finish).toMatch(/record_attempt/);
  });

  it('leaves the checkpoint text exactly as it was before the panel existed', () => {
    configure(false);
    logConcepts(['csrf']);
    // The text as shipped on main, kept here as the thing "off" must reproduce.
    const expected = `[Eklavya checkpoint] You just logged a concept. Before writing another line, ask the developer ONE question about it -- this is the whole point of the tool: they learn while you work, not in a pile at the end.

Concept: csrf (touched csrf in auth.ts)

Do exactly this, then get straight back to the task:
  1. get_session_quiz_plan with max: 1 and ignore_cooldown: true (the pacing is already decided -- this hook is the cooldown).
  2. Ask that ONE question with AskUserQuestion: four options, exactly one correct, three plausible but wrong for this stem, and put the correct one in the slot answer_position names.
     ${attributionRule()}
  3. Grade it with record_attempt: format "mcq", the labels in "options", the stem alone in "question".
  4. Tell them the verdict: right, or wrong and what the right answer is, with one line of why. Never skip this -- an answer with no verdict teaches nothing.
  5. Resume the task exactly where you left off. Do not summarise, do not re-plan, do not ask a second question.

ONE question. Not two, not the whole plan. 4 left in this session's budget, and the Stop hook spends whatever you do not.
${framingFor('project', null, 'checkpoint')}
If they pick Other or say skip, record it as grade 0, teach the answer in two lines, and carry on. Do not ask again.`;
    expect(checkpoint().context).toBe(expected);
  });

  it('leaves the delegation lines exactly as they were', () => {
    const was =
      'While it builds: get_session_quiz_plan with while_waiting: true, then AskUserQuestion, record_attempt and the verdict, one at a time, until it reports or questions_needed is 0.';
    for (const text of [sessionBlock('as-you-go'), promptLine('as-you-go'), nudge('as-you-go')]) expect(text).toContain(was);
    for (const text of [sessionBlock('end'), promptLine('end'), nudge('end')]) {
      expect(text).toContain('Questions wait for the end of the task (cadence: end).');
      expect(text).not.toMatch(/present_question/);
    }
  });
});

describe('the plan\'s presentation', () => {
  const plan = (extra: Record<string, unknown> = {}) => getSessionQuizPlan.handler({ cwd, session_id: SESSION, ...extra }, { db }) as any;

  it('is panel with the setting on and a fresh heartbeat, and then drops the card\'s attribution', () => {
    configure(true);
    beat();
    logConcepts(['csrf']);
    const p = plan();
    expect(p.presentation).toBe('panel');
    expect(p.ask_attribution).toBeUndefined();
    expect(p.on_finish).toMatch(/do not call record_attempt/);
    expect(p.on_finish).toMatch(/present_question/);
    expect(p.on_finish).not.toMatch(/Present only the first/);
    expect(p.on_skip).toMatch(/Skip button/);
  });

  it('is the card on every other state, with its attribution', () => {
    logConcepts(['csrf']);
    configure(true); // no heartbeat
    expect(plan().presentation).toBe('tool');
    beat(SESSION, 'terminal', false);
    expect(plan().presentation).toBe('tool');
    beat(SESSION, 'vscode');
    const p = plan();
    expect(p.presentation).toBe('tool');
    expect(p.ask_attribution).toBe(attributionRule());
    expect(p.on_skip).toMatch(/record grade 0/);
  });

  it('tells a round to present one question and wait for the panel to ask for the next', () => {
    configure(true, { cadence: 'end' });
    beat();
    logConcepts(['csrf', 'jwt-structure']);
    const p = plan();
    expect(p.questions_needed).toBeGreaterThan(1);
    expect(p.on_finish).toMatch(/Present only the first question now/);
  });

  it('Next resumes the round a topic quiz started: same topic, same total, last one known', () => {
    configure(true);
    beat();
    const first = plan({ slugs: ['csrf', 'jwt-structure'] });
    expect(first.presentation).toBe('panel');
    expect(first.questions_needed).toBe(2);
    const order = first.concepts.map((c: any) => c.slug) as string[];
    // Nothing was logged in this session: a fresh plan from its work would be empty.
    expect(plan({ ignore_cooldown: true }).questions_needed).toBe(0);
    const present = (slug: string) =>
      presentQuestion(db, {
        slug,
        question: `About ${slug}?`,
        options: options(slug),
        explanation: 'because',
        difficulty: 2,
        session_id: SESSION,
        cwd,
        more: false,
      }) as any;
    expect(present(order[0]!).status).toBe('presented');
    expect(panelSync(db, { session_id: SESSION, cwd, host: { surface: 'terminal' } }) as any).toMatchObject({ more: true });
    db.prepare("UPDATE panel_questions SET phase = 'answered'").run();
    const next = plan({ resume_round: true });
    expect(next.concepts.map((c: any) => c.slug)).toEqual([order[1]]);
    expect(present(order[1]!).status).toBe('presented');
    expect(panelSync(db, { session_id: SESSION, cwd, host: { surface: 'terminal' } }) as any).toMatchObject({ more: false });
    db.prepare("UPDATE panel_questions SET phase = 'answered'").run();
    expect(plan({ resume_round: true }).reason).toBe('round_over');
  });

  it('keeps an enforced gate\'s skip rule whichever way it is shown', () => {
    configure(true, {});
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ focus: 'project', cadence: 'end', quiz: { enabled: true, enforced: true, panel: true, only_on_changes: false } }));
    beat();
    logConcepts(['csrf']);
    expect(plan().on_skip).toMatch(/commit gate needs this quiz/);
  });

  it('plans nothing while a question is already waiting in the panel, and says so', () => {
    configure(true);
    beat();
    logConcepts(['csrf']);
    openQuestion();
    const p = plan();
    expect(p).toMatchObject({ questions_needed: 0, reason: 'panel_question_open' });
    expect(p.detail).toMatch(/already waiting in the side panel/);
    // With the setting off the same row is not read.
    configure(false);
    expect(plan().questions_needed).toBeGreaterThan(0);
  });
});

describe('checkpoint hook', () => {
  it('asks with present_question and no record_attempt when the plan would say panel', () => {
    configure(true);
    beat();
    logConcepts(['csrf']);
    const ctx = checkpoint().context;
    expect(ctx).toMatch(/\[Eklavya checkpoint\]/);
    expect(ctx).toMatch(/present_question/);
    expect(ctx).toMatch(/answer_position/);
    expect(ctx).toMatch(/Do not call record_attempt/);
    expect(ctx).toMatch(/Resume the task exactly where you left off/);
    expect(ctx).not.toMatch(/AskUserQuestion|Header "Eklavya"|Tell them the verdict|If they pick Other/);
  });

  it('still asks the card way with the setting on but no panel showing', () => {
    configure(true);
    logConcepts(['csrf']);
    const ctx = checkpoint().context;
    expect(ctx).toMatch(/AskUserQuestion/);
    expect(ctx).not.toMatch(/present_question/);
  });

  it('stays silent while a question is waiting in the panel', () => {
    configure(true);
    beat();
    logConcepts(['csrf']);
    openQuestion();
    const res = checkpoint();
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('');
  });

  it('does not read the panel when the setting is off, even with a row open', () => {
    configure(false);
    logConcepts(['csrf']);
    openQuestion();
    expect(checkpoint().spoke).toBe(true);
  });
});

describe('Stop sweep', () => {
  it('does not hold the turn open for a second question while one waits in the panel', () => {
    configure(true, { cadence: 'end' });
    beat();
    logConcepts(['csrf', 'jwt-structure']);
    openQuestion();
    expect(stop().stdout).toBe('');
  });

  it('sweeps as before without one, and when the setting is off', () => {
    configure(true, { cadence: 'end' });
    beat();
    logConcepts(['csrf']);
    expect(stop().context).toMatch(/^Eklavya: up to 1 questions?|^Eklavya: one question on csrf/);
    db.prepare('DELETE FROM stop_markers').run();
    configure(false, { cadence: 'end' });
    openQuestion();
    expect(stop().spoke).toBe(true);
  });
});

describe('the delegation lines agree with the plan', () => {
  const both = /present_question for "panel"[\s\S]*else AskUserQuestion, record_attempt and the verdict/;

  it('name both tools and say the plan\'s presentation picks, only with the panel on', () => {
    for (const text of [sessionBlock('as-you-go', true), promptLine('as-you-go', true), nudge('as-you-go', true)]) {
      expect(text).toMatch(both);
      expect(text).toMatch(/as its presentation says/);
    }
    for (const text of [sessionBlock('end', true), promptLine('end', true), nudge('end', true)]) {
      expect(text).toContain('Questions wait for the end of the task (cadence: end).');
    }
  });

  it('reach the model through the hooks, only with the panel on', () => {
    configure(true);
    const start = runHook(SESSION_START, { session_id: SESSION, cwd, hook_event_name: 'SessionStart', session_start_reason: 'startup' });
    expect(start.context).toMatch(both);
    const prompt = runHook(NUDGE, { session_id: SESSION, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'please add a retrying cache layer across the whole data module and its tests' });
    expect(prompt.context).toMatch(both);
    configure(false);
    expect(runHook(SESSION_START, { session_id: SESSION, cwd, hook_event_name: 'SessionStart', session_start_reason: 'startup' }).context).not.toMatch(/present_question/);
  });
});
