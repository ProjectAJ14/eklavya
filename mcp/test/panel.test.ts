import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { answerPosition } from '../src/mcq.js';
import { retryOnBusy } from '../src/concurrency.js';
import { hasAskedQuestion, masteryFor, conceptBySlug } from '../src/store.js';
import { panelAnswer, panelSync, presentQuestion, type AnswerInput, type PresentInput } from '../src/panel.js';
import { loadRound, panelPresentation, recordHeartbeat, saveRound } from '../src/panel-state.js';
import { TOOLS } from '../src/tools/index.js';
import { recordAttempt } from '../src/tools/record_attempt.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let home = '';
let root = '';
const envBackup = { ...process.env };

const SESSION = 'sess-panel';
const SLUG = 'csrf';
const HOST = { surface: 'terminal', version: '2.1.292', columns: 160 };

/** A checkout: `.git` is all the config reader needs to see a project. */
function checkout(name: string): string {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

let cwd = '';

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-panel-home-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-panel-root-'));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
  // Pinned: `loadConfig` reads the real config otherwise.
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ focus: 'project', cadence: 'end', quiz: { panel: true } }));
  dbFile = tempDbPath('panel');
  db = openDb(dbFile);
  cwd = checkout('proj');
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
  process.env = { ...envBackup };
});

const LABELS = ['Tokens are checked by the server', 'Cookies are signed', 'The origin is compared', 'The body is hashed'];

/** Four options with the right one where the planner would put it. */
function options(slug = SLUG, askedCount = 0, labels = LABELS) {
  const at = answerPosition(slug, askedCount) - 1;
  const distractor = [2, 1, 2];
  let d = 0;
  return labels.map((label, i) => ({
    label,
    description: `note for ${label}`,
    grade: i === at ? 4 : distractor[d++]!,
    ...(i === at ? { correct: true } : {}),
  }));
}

function present(over: Partial<PresentInput> = {}) {
  // The mod reports in before anything is presented, or the planner would not
  // have chosen the panel and `present_question` refuses.
  recordHeartbeat(db, over.session_id ?? SESSION, { surface: 'terminal' }, undefined);
  return presentQuestion(db, {
    slug: SLUG,
    question: 'Why does the server compare the Origin header?',
    options: options(),
    explanation: 'The Origin cannot be forged by a page the user visits.',
    difficulty: 2,
    session_id: SESSION,
    cwd,
    ...over,
  }) as any;
}

/** The synced question, as the mod would see it. */
function sync(over: Record<string, unknown> = {}) {
  return panelSync(db, { session_id: SESSION, cwd, host: HOST, ...over } as any) as any;
}

function answer(over: Partial<AnswerInput> & { question_id: string }) {
  return panelAnswer(db, {
    session_id: SESSION,
    repo: rowOf(over.question_id).repo,
    cwd,
    kind: 'choice',
    ...over,
  } as AnswerInput) as any;
}

const attempts = () => db.prepare('SELECT * FROM attempts ORDER BY id').all() as any[];
const rowOf = (id: string) => db.prepare('SELECT * FROM panel_questions WHERE id = ?').get(id) as any;
const correctId = () => `o${answerPosition(SLUG, 0)}`;
const wrongId = (n: number) => {
  const ids = ['o1', 'o2', 'o3', 'o4'].filter((i) => i !== correctId());
  return ids[n]!;
};

describe('present_question', () => {
  it('stores a pending row and returns at once without writing any learning', () => {
    const before = masteryFor(db, conceptBySlug(db, SLUG)!.id);
    const out = present();
    expect(out.status).toBe('presented');
    expect(out.question_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.next).toMatch(/Do not wait/);
    expect(rowOf(out.question_id)).toMatchObject({ phase: 'pending', session_id: SESSION, attempt_id: null, result: null });
    // Memory evidence cannot change mastery, and neither can an unanswered question.
    expect(attempts()).toHaveLength(0);
    expect(masteryFor(db, conceptBySlug(db, SLUG)!.id)).toEqual(before);
  });

  it('keeps the model\'s key server-side and numbers the options o1 to o4', () => {
    const out = present();
    const row = rowOf(out.question_id);
    expect(JSON.parse(row.options).map((o: any) => o.id)).toEqual(['o1', 'o2', 'o3', 'o4']);
    expect(JSON.parse(row.key)).toMatchObject({ correct_id: correctId() });
    expect(JSON.parse(row.key).grades[correctId()]).toBe(4);
  });

  it('stores the stem stripped of attribution, so the repeat check still sees it', () => {
    const stem = 'Why does the server compare the Origin header?';
    const out = present({ question: `[Eklavya]\n${stem}` });
    expect(rowOf(out.question_id).stem).toBe(stem);
    answer({ question_id: out.question_id, kind: 'choice', option_id: correctId() });
    expect(hasAskedQuestion(db, conceptBySlug(db, SLUG)!.id, stem)).toBe(true);
  });

  it('tells the model when the same question was asked before, and still presents it', () => {
    const first = present();
    answer({ question_id: first.question_id, option_id: correctId() });
    const again = present({ options: options(SLUG, 1) });
    expect(again.repeat_question).toBe(true);
    expect(again.status).toBe('presented');
  });

  it('rejects an answer in the wrong slot and stores nothing', () => {
    const at = answerPosition(SLUG, 0) - 1;
    const shifted = options();
    // Swap the right option into the next slot.
    const other = (at + 1) % 4;
    [shifted[at], shifted[other]] = [shifted[other]!, shifted[at]!];
    const out = present({ options: shifted });
    expect(out.error).toBe('wrong_answer_position');
    expect(out.expected).toBe(answerPosition(SLUG, 0));
    expect(db.prepare('SELECT COUNT(*) AS n FROM panel_questions').get()).toEqual({ n: 0 });
  });

  it('rejects repeated labels, a wrong option count, no right option, two, and a bad grade', () => {
    const dup = options();
    dup[0]!.label = `  ${dup[1]!.label.toUpperCase()} `;
    expect(present({ options: dup }).error).toBe('invalid_options');
    expect(present({ options: options().slice(0, 3) }).error).toBe('invalid_options');
    expect(present({ options: options().map((o) => ({ ...o, correct: undefined })) }).error).toBe('invalid_options');
    expect(present({ options: options().map((o) => ({ ...o, correct: true })) }).error).toBe('invalid_options');
    // A letter or number is not an option.
    for (const marker of ['A', ' b ', '1', '(C)', 'D.', 'a)']) {
      const lettered = options();
      lettered[1]!.label = marker;
      expect(present({ options: lettered }).error, marker).toBe('invalid_options');
    }
    const grades = options();
    const wrong = grades.find((o) => !o.correct)!;
    wrong.grade = 3;
    expect(present({ options: grades }).error).toBe('invalid_options');
    const right = options();
    right.find((o) => o.correct)!.grade = 2;
    expect(present({ options: right }).error).toBe('invalid_options');
    expect(db.prepare('SELECT COUNT(*) AS n FROM panel_questions').get()).toEqual({ n: 0 });
  });

  it('rejects a second question while one is open, naming the open one', () => {
    const first = present();
    const second = present();
    expect(second.error).toBe('question_open');
    expect(second.question_id).toBe(first.question_id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM panel_questions').get()).toEqual({ n: 1 });
  });

  it('rejects a concept that does not exist', () => {
    expect(present({ slug: 'no-such-concept' }).error).toBe('unknown_concept');
  });
});

describe('present_question refuses when the panel is not the way to ask', () => {
  const direct = () =>
    presentQuestion(db, {
      slug: SLUG,
      question: 'Why does the server compare the Origin header?',
      options: options(),
      explanation: 'Because.',
      difficulty: 2,
      session_id: SESSION,
      cwd,
    }) as any;
  const stored = () => db.prepare('SELECT COUNT(*) AS n FROM panel_questions').get();

  it('says panel_disabled while the setting is off, and stores nothing', () => {
    recordHeartbeat(db, SESSION, { surface: 'terminal' }, undefined);
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ quiz: { panel: false } }));
    expect(direct().error).toBe('panel_disabled');
    expect(stored()).toEqual({ n: 0 });
  });

  it('says panel_unavailable with no heartbeat, a stale one, or a surface that takes no answers', () => {
    expect(direct().error).toBe('panel_unavailable');
    recordHeartbeat(db, SESSION, { surface: 'terminal' }, undefined, new Date(Date.now() - 120_000));
    expect(direct().error).toBe('panel_unavailable');
    recordHeartbeat(db, SESSION, { surface: 'vscode' }, undefined);
    expect(direct().error).toBe('panel_unavailable');
    expect(stored()).toEqual({ n: 0 });
    recordHeartbeat(db, SESSION, { surface: 'desktop' }, undefined);
    expect(direct().status).toBe('presented');
  });
});

describe('switching the panel off', () => {
  const attempts = () => db.prepare('SELECT COUNT(*) AS n FROM attempts').get();

  it('expires the open question without an attempt, so turning it back on revives nothing', () => {
    present();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ quiz: { panel: false } }));
    expect(sync()).toEqual({ disabled: true });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ quiz: { panel: true } }));
    expect(sync()).toEqual({ none: true });
    expect(db.prepare('SELECT phase FROM panel_questions').get()).toEqual({ phase: 'expired' });
    expect(attempts()).toEqual({ n: 0 });
  });

  it('also drops a question the card answered while no sync ran', () => {
    const q = present();
    const concept = conceptBySlug(db, SLUG)!;
    db.prepare("INSERT INTO attempts (concept_id, session_id, question, grade, difficulty, ts) VALUES (?, ?, 'q', 4, 2, datetime('now', '+1 second'))").run(concept.id, SESSION);
    expect(sync()).toEqual({ none: true });
    expect(db.prepare('SELECT phase FROM panel_questions WHERE id = ?').get(q.question_id)).toEqual({ phase: 'expired' });
  });
});

describe('a remembered round', () => {
  it('is forgotten after a day, like the question it belonged to', () => {
    saveRound(db, SESSION, ['csrf'], new Date(Date.now() - 25 * 3600_000));
    expect(loadRound(db, SESSION)).toBeNull();
    saveRound(db, SESSION, ['csrf']);
    expect(loadRound(db, SESSION)).toEqual(['csrf']);
  });
});

describe('panel_sync', () => {
  it('says none when nothing waits', () => {
    expect(sync()).toEqual({ none: true });
  });

  it('treats an empty cwd as a session with no folder and still stamps the heartbeat', () => {
    expect(sync({ cwd: '' })).toEqual({ none: true });
    expect(panelPresentation(db, { quiz: { panel: true } }, SESSION)).toBe('panel');
  });

  it('never carries the key, the grades or the explanation', () => {
    present();
    const text = JSON.stringify(sync());
    for (const secret of ['correct_id', 'grades', 'key', 'The Origin cannot be forged']) {
      expect(text).not.toContain(secret);
    }
    expect(sync()).toMatchObject({
      phase: 'pending',
      concept_name: expect.any(String),
      tier: 2,
      stem: 'Why does the server compare the Origin header?',
    });
    expect(sync().options).toHaveLength(4);
    expect(sync().options[0]).toEqual({ id: 'o1', label: LABELS[0], note: `note for ${LABELS[0]}` });
  });

  it('says whether more questions of the round follow, so the pane offers Next only then', () => {
    present();
    expect(sync().more).toBe(false);
    const q = sync();
    answer({ question_id: q.question_id, kind: 'skip' });
    present({ more: true, options: options(SLUG, 1), question: 'What does SameSite=Lax stop?' });
    expect(sync().more).toBe(true);
  });

  it('marks a question unplaced when the host could not seat it, and back once it can', () => {
    const q = present();
    expect(sync({ placed: { question_id: q.question_id, ok: true } }).phase).toBe('pending');
    expect(sync({ placed: { question_id: q.question_id, ok: false, reason: 'width' } }).phase).toBe('unplaced');
    expect(rowOf(q.question_id).phase).toBe('unplaced');
    // Reporting the same failure again changes nothing.
    expect(sync({ placed: { question_id: q.question_id, ok: false } }).phase).toBe('unplaced');
    expect(sync({ placed: { question_id: q.question_id, ok: true } }).phase).toBe('pending');
    // A report about some other question is ignored.
    expect(sync({ placed: { question_id: 'other', ok: false } }).phase).toBe('pending');
  });

  it('still blocks a second question while the first is unplaced', () => {
    const q = present();
    sync({ placed: { question_id: q.question_id, ok: false } });
    expect(present().error).toBe('question_open');
  });
});

describe('panel_answer: the grade table', () => {
  it('records a right pick as grade 4, mcq, answered, with the picked label', () => {
    const q = present();
    const out = answer({ question_id: q.question_id, option_id: correctId() });
    expect(out).toMatchObject({ phase: 'answered', correct: true, explanation: 'The Origin cannot be forged by a page the user visits.' });
    expect(out.correct_label).toBeUndefined();
    const [a] = attempts();
    expect(attempts()).toHaveLength(1);
    expect(a).toMatchObject({
      grade: 4,
      format: 'mcq',
      outcome: 'answered',
      difficulty: 2,
      session_id: SESSION,
      question: 'Why does the server compare the Origin header?',
      answer: LABELS[answerPosition(SLUG, 0) - 1],
      feedback: 'The Origin cannot be forged by a page the user visits.',
    });
    expect(JSON.parse(a.options)).toEqual(LABELS);
    expect(a.correct).toBe(LABELS[answerPosition(SLUG, 0) - 1]);
    expect(JSON.parse(a.option_notes)).toEqual(LABELS.map((l) => `note for ${l}`));
    expect(rowOf(q.question_id)).toMatchObject({ phase: 'answered', attempt_id: out.attempt_id });
    expect(sync()).toEqual({ none: true });
  });

  it('records a near miss as 2 and a misconception as 1, and names the right option', () => {
    const grades: number[] = [];
    // Each answered question moves the planner's slot for the next, so count along.
    for (const asked of [0, 1, 2]) {
      const q = present({ options: options(SLUG, asked), question: `Why does the server compare Origin, take ${asked}?` });
      const key = JSON.parse(rowOf(q.question_id).key);
      const picked = ['o1', 'o2', 'o3', 'o4'].filter((i) => i !== key.correct_id)[asked]!;
      const out = answer({ question_id: q.question_id, option_id: picked });
      expect(out).toMatchObject({ phase: 'answered', correct: false, correct_label: LABELS[answerPosition(SLUG, asked) - 1] });
      expect(attempts().at(-1)!.grade).toBe(key.grades[picked]);
      grades.push(attempts().at(-1)!.grade);
    }
    expect(grades).toEqual([2, 1, 2]);
  });

  it('never exceeds 4 for a pick, and a typed answer is not capped', () => {
    const q = present();
    const out = answer({ question_id: q.question_id, kind: 'text', text: 'It proves the request came from our own page.', grade: 5, outcome: 'answered', feedback: 'Right, and you said why.' });
    expect(out).toMatchObject({ phase: 'answered', correct: true, explanation: 'Right, and you said why.' });
    const a = attempts().at(-1)!;
    expect(a.grade).toBe(5);
    expect(a.format).toBeNull();
    expect(a.outcome).toBe('answered');
    expect(a.answer).toBe('It proves the request came from our own page.');
    expect(out.grade_capped).toBeUndefined();
  });

  it('records a typed miss with the grader\'s grade and the right option', () => {
    const q = present();
    const out = answer({ question_id: q.question_id, kind: 'text', text: 'no idea really', grade: 1, outcome: 'answered' });
    expect(out).toMatchObject({ correct: false, correct_label: LABELS[answerPosition(SLUG, 0) - 1] });
    // No grader feedback: the question's own explanation is shown.
    expect(out.explanation).toBe('The Origin cannot be forged by a page the user visits.');
  });

  it('records a typed "I don\'t know" as dont_know with grade 0', () => {
    const q = present();
    const out = answer({ question_id: q.question_id, kind: 'text', text: "I don't know", grade: 0, outcome: 'dont_know', feedback: 'It proves the origin.' });
    expect(out.correct).toBe(false);
    expect(attempts().at(-1)).toMatchObject({ grade: 0, outcome: 'dont_know', format: null });
  });

  it('records a skip as a decline with no answer and no feedback', () => {
    const q = present();
    const out = answer({ question_id: q.question_id, kind: 'skip' });
    expect(out).toMatchObject({ phase: 'skipped' });
    expect(out.correct).toBeUndefined();
    expect(out.explanation).toBeUndefined();
    expect(attempts().at(-1)).toMatchObject({ grade: 0, outcome: 'declined', answer: null, feedback: null, format: 'mcq' });
    expect(rowOf(q.question_id).phase).toBe('skipped');
  });

  it('rejects answers that cannot be graded and writes nothing', () => {
    const q = present();
    const bad: Partial<AnswerInput>[] = [
      { kind: 'choice', option_id: 'o9' },
      { kind: 'choice' },
      { kind: 'text', text: '   ', grade: 4, outcome: 'answered' },
      { kind: 'text', text: 'x', grade: 6, outcome: 'answered' },
      { kind: 'text', text: 'x', grade: -1, outcome: 'answered' },
      { kind: 'text', text: 'x', grade: 2.5, outcome: 'answered' },
      { kind: 'text', text: 'x', outcome: 'answered' },
      { kind: 'text', text: 'x', grade: 4 },
      { kind: 'text', text: 'x', grade: 4, outcome: 'declined' as any },
      // A "don't know" that scored anything is a contradiction, whatever the grade.
      { kind: 'text', text: 'x', grade: 3, outcome: 'dont_know' },
      { kind: 'text', text: 'x', grade: 1, outcome: 'dont_know' },
    ];
    for (const b of bad) expect(answer({ question_id: q.question_id, ...b }).error).toBe('invalid_answer');
    expect(attempts()).toHaveLength(0);
    expect(rowOf(q.question_id).phase).toBe('pending');
  });

  it('passes a miss\'s explain block through, and the level-up when one is earned', () => {
    const q = present();
    const miss = answer({ question_id: q.question_id, option_id: wrongId(0) });
    expect(miss.explain).toMatchObject({ concept: SLUG, attempt_id: miss.attempt_id });
    expect(miss.explain.instruction).toMatch(/eklavya-explainer/);
    // The model never saw the pick, so the instruction has to carry it.
    expect(miss.explain.instruction).toContain(`The learner answered: ${miss.explain.answer}.`);
    expect(miss.explain.instruction).toContain(`The right answer is: ${miss.explain.correct}.`);
    expect(miss.explain.answer).toBeTruthy();
    expect(miss.explain.correct).toBeTruthy();
    expect(miss.level_up).toBeUndefined();

    // One passing answer is enough to promote when the bar is one answer.
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ focus: 'project', cadence: 'end', level_up_after: 1, level_up_accuracy: 0.1, quiz: { panel: true } }));
    const next = present({ options: options(SLUG, 1) });
    const hit = answer({ question_id: next.question_id, option_id: `o${answerPosition(SLUG, 1)}` });
    expect(hit.level_up).toEqual({ from: 'easy', to: 'medium' });
    expect(hit.explain).toBeUndefined();
  });
});

describe('panel_answer: a typed answer in two steps', () => {
  it('hands the right option to the grader only once words are typed, and holds the question as grading', () => {
    const q = present();
    expect(answer({ question_id: q.question_id, kind: 'text', text: '   ' }).error).toBe('invalid_answer');
    const first = answer({ question_id: q.question_id, kind: 'text', text: 'it checks where the request came from' });
    expect(first).toEqual({ phase: 'grading', correct_label: LABELS[answerPosition(SLUG, 0) - 1] });
    expect(attempts()).toHaveLength(0);
    expect(rowOf(q.question_id)).toMatchObject({ phase: 'grading', attempt_id: null, result: null });
    // Still open: nothing else is asked, a placement report leaves it alone, and asking again is harmless.
    expect(present().error).toBe('question_open');
    expect(sync({ placed: { question_id: q.question_id, ok: false } }).phase).toBe('grading');
    expect(answer({ question_id: q.question_id, kind: 'text', text: 'it checks where the request came from' })).toEqual(first);
    // The verdict then records it once, from the grading phase.
    const done = answer({ question_id: q.question_id, kind: 'text', text: 'it checks where the request came from', grade: 4, outcome: 'answered', feedback: 'Right.' });
    expect(done).toMatchObject({ phase: 'answered', correct: true });
    expect(attempts()).toHaveLength(1);
    expect(answer({ question_id: q.question_id, kind: 'text', text: 'x', grade: 0, outcome: 'dont_know' })).toEqual(done);
  });

  it('lets a question held as grading be skipped', () => {
    const q = present();
    answer({ question_id: q.question_id, kind: 'text', text: 'hmm' });
    expect(answer({ question_id: q.question_id, kind: 'skip' }).phase).toBe('skipped');
    expect(attempts().at(-1)).toMatchObject({ outcome: 'declined' });
  });
});

describe('panel_answer: once only', () => {
  it('returns the stored reply the second time and writes nothing', () => {
    const q = present();
    const first = answer({ question_id: q.question_id, option_id: correctId() });
    const stateAfterFirst = masteryFor(db, conceptBySlug(db, SLUG)!.id);
    const second = answer({ question_id: q.question_id, option_id: wrongId(0) });
    expect(second).toEqual(first);
    expect(attempts()).toHaveLength(1);
    // SM-2 moved once.
    expect(masteryFor(db, conceptBySlug(db, SLUG)!.id)).toEqual(stateAfterFirst);
    expect(stateAfterFirst.reps).toBe(1);
  });

  it('also holds when the reply is lost and the call is retried after a lock', () => {
    const q = present();
    const sent = sync();
    let first = true;
    const out = retryOnBusy(() =>
      db.transaction(() => {
        const r = panelAnswer(db, { question_id: q.question_id, session_id: SESSION, repo: sent.repo, cwd, kind: 'choice', option_id: correctId() }) as any;
        if (first) {
          first = false;
          // The lock hits after the write: everything rolls back together.
          throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
        }
        return r;
      })(),
    );
    expect(out.phase).toBe('answered');
    expect(attempts()).toHaveLength(1);
    expect(masteryFor(db, conceptBySlug(db, SLUG)!.id).reps).toBe(1);
    // And a client retry after the reply is lost still finds one attempt.
    const again = panelAnswer(db, { question_id: q.question_id, session_id: SESSION, repo: sent.repo, cwd, kind: 'choice', option_id: correctId() }) as any;
    expect(again).toEqual(out);
    expect(attempts()).toHaveLength(1);
  });

  it('writes no attempt and leaves the question pending when the row cannot be updated', () => {
    const q = present();
    const sent = sync();
    db.exec("CREATE TRIGGER boom BEFORE UPDATE OF phase ON panel_questions WHEN NEW.phase = 'answered' BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => panelAnswer(db, { question_id: q.question_id, session_id: SESSION, repo: sent.repo, cwd, kind: 'choice', option_id: correctId() })).toThrow(/boom/);
    expect(attempts()).toHaveLength(0);
    expect(masteryFor(db, conceptBySlug(db, SLUG)!.id).reps).toBe(0);
    expect(rowOf(q.question_id)).toMatchObject({ phase: 'pending', attempt_id: null, result: null });
    db.exec('DROP TRIGGER boom');
    expect(answer({ question_id: q.question_id, option_id: correctId() }).phase).toBe('answered');
    expect(attempts()).toHaveLength(1);
  });

  it('surfaces the shared recorder\'s refusal and leaves the question pending', () => {
    const q = present();
    // A stored slug the recorder cannot normalise back to itself.
    db.prepare('UPDATE concepts SET slug = ? WHERE slug = ?').run('Not Normal!', SLUG);
    const out = answer({ question_id: q.question_id, option_id: correctId() });
    expect(out.error).toBe('unknown_concept');
    expect(attempts()).toHaveLength(0);
    expect(rowOf(q.question_id).phase).toBe('pending');
  });
});

describe('stale and expired questions', () => {
  it('refuses another session, another project and an unknown question', () => {
    const q = present();
    const sent = sync();
    const base = { question_id: q.question_id, session_id: SESSION, repo: sent.repo, cwd, kind: 'choice', option_id: correctId() } as AnswerInput;
    expect((panelAnswer(db, { ...base, session_id: 'other-session' }) as any).error).toBe('stale_question');
    expect((panelAnswer(db, { ...base, repo: '/some/other/repo' }) as any).error).toBe('stale_question');
    // A cwd in another project cannot answer this project's question either.
    expect((panelAnswer(db, { ...base, cwd: checkout('elsewhere') }) as any).error).toBe('stale_question');
    expect((panelAnswer(db, { ...base, question_id: 'nope' }) as any).error).toBe('unknown_question');
    expect(attempts()).toHaveLength(0);
    expect(rowOf(q.question_id).phase).toBe('pending');
  });

  it('expires a question nobody answered in 24 hours, without recording a decline', () => {
    const q = present();
    const sent = sync();
    db.prepare("UPDATE panel_questions SET created_at = datetime('now', '-25 hours') WHERE id = ?").run(q.question_id);
    expect(sync()).toEqual({ none: true });
    expect(rowOf(q.question_id).phase).toBe('expired');
    expect((panelAnswer(db, { question_id: q.question_id, session_id: SESSION, repo: sent.repo, cwd, kind: 'skip' }) as any).error).toBe('stale_question');
    expect(attempts()).toHaveLength(0);
    // The session is free to be asked again.
    expect(present().status).toBe('presented');
  });

  it('keeps a question that is just inside the window', () => {
    const q = present();
    db.prepare("UPDATE panel_questions SET created_at = datetime('now', '-23 hours') WHERE id = ?").run(q.question_id);
    expect(sync().question_id).toBe(q.question_id);
  });
});

describe('isolation', () => {
  it('gives each session its own question, in one project and across a linked worktree', () => {
    const a = present({ session_id: 'sess-a' });
    // A linked worktree folds into its main checkout's project.
    const wt = path.join(root, 'wt');
    fs.mkdirSync(path.join(cwd, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.rmSync(path.join(cwd, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(cwd, '.git', 'worktrees', 'wt')}\n`);
    const b = present({ session_id: 'sess-b', cwd: wt, options: options() });
    expect(b.status).toBe('presented');
    expect(panelSync(db, { session_id: 'sess-a', cwd, host: HOST }) as any).toMatchObject({ question_id: a.question_id });
    expect(panelSync(db, { session_id: 'sess-b', cwd: wt, host: HOST }) as any).toMatchObject({ question_id: b.question_id });
    expect(panelSync(db, { session_id: 'sess-c', cwd, host: HOST }) as any).toEqual({ none: true });
    expect((panelSync(db, { session_id: 'sess-a', cwd: wt, host: HOST }) as any).question_id).toBe(a.question_id);
  });

  it('does not show a session a question that belongs to another project', () => {
    present();
    expect(panelSync(db, { session_id: SESSION, cwd: checkout('other'), host: HOST })).toEqual({ none: true });
  });

  it('works outside any git project, scoped to the global project', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-plain-'));
    try {
      const q = present({ cwd: plain });
      const sent = panelSync(db, { session_id: SESSION, cwd: plain, host: HOST }) as any;
      expect(sent.repo).toBe('*');
      const out = panelAnswer(db, { question_id: q.question_id, session_id: SESSION, repo: sent.repo, cwd: plain, kind: 'choice', option_id: correctId() }) as any;
      expect(out.phase).toBe('answered');
      expect(attempts().at(-1)!.repo).toBe('*');
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('the tools', () => {
  const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

  it('are registered, and the mod-only ones say so', () => {
    expect(tool('present_question')).toBeDefined();
    for (const name of ['panel_sync', 'panel_answer']) {
      expect(tool(name).description).toMatch(/^Called only by the Eklavya panel, never by the model\./);
    }
    expect(tool('present_question').description).toMatch(/instead of AskUserQuestion/);
  });

  it('round-trip through their handlers', () => {
    recordHeartbeat(db, SESSION, { surface: 'terminal' }, undefined);
    const q = tool('present_question').handler(
      { slug: SLUG, question: 'Why compare Origin?', options: options(), explanation: 'Because.', difficulty: 2, session_id: SESSION, cwd },
      { db },
    ) as any;
    const synced = tool('panel_sync').handler({ session_id: SESSION, cwd, host: HOST }, { db }) as any;
    expect(synced.question_id).toBe(q.question_id);
    const done = tool('panel_answer').handler(
      { question_id: q.question_id, session_id: SESSION, repo: synced.repo, cwd, kind: 'choice', option_id: correctId() },
      { db },
    ) as any;
    expect(done.phase).toBe('answered');
  });

  it('keep record_attempt working as before', () => {
    const out = recordAttempt.handler({ cwd, session_id: SESSION, slug: SLUG, question: 'q', grade: 5, difficulty: 2, format: 'mcq' }, { db }) as any;
    expect(out).toMatchObject({ recorded_grade: 4, grade_capped: true });
  });
});
