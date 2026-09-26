import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { addCandidate, insertEntry, pendingCandidates } from '../src/memory/store.js';
import { fillOmissions, proposeFor, proposeForProject } from '../src/memory/learning.js';
import { conceptBySlug, gradeConcept, logSessionConcept, syncGate } from '../src/store.js';
import { entryById } from '../src/memory/store.js';

const PROJECT = '/tmp/learning-repo';
const SESSION = 'sess-learning';

let dbFile: string;
let db: DB;
let config: EklavyaConfig;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-learning');
  db = openDb(dbFile);
  config = { ...DEFAULT_CONFIG };
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
});

/** An observation whose language names a concept the seed already carries. */
function seedEntry(title: string, narrative = ''): number {
  return insertEntry(db, { project: PROJECT, sessionId: SESSION, title, narrative });
}

describe('proposing concept candidates from evidence', () => {
  it('matches the language of an observation against concepts the graph already knows', () => {
    const id = seedEntry('Set httponly cookies on the refresh path');
    expect(proposeFor(db, entryById(db, id)!, config)).toBeGreaterThan(0);
    const candidates = pendingCandidates(db, PROJECT);
    expect(candidates.map((c) => c.slug)).toContain('httponly-cookies');
  });

  it('never mints a concept of its own, however confident the wording', () => {
    // An extractive guess has no business naming a new idea: that is how a
    // graph fills with `edited-auth`. Only the existing graph can be matched.
    const before = (db.prepare('SELECT COUNT(*) AS n FROM concepts').get() as { n: number }).n;
    const id = seedEntry('Rewrote the frobnicator gizmo pipeline end to end');
    proposeFor(db, entryById(db, id)!, config);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM concepts').get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it('records a candidate without touching mastery, attempts or a gate', () => {
    const id = seedEntry('Set httponly cookies on the refresh path');
    proposeFor(db, entryById(db, id)!, config);
    for (const table of ['mastery', 'attempts', 'gates', 'session_concepts']) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      expect(row.n, `${table} must not move`).toBe(0);
    }
  });

  it('respects the enabled-domain filter, so a disabled domain is never proposed', () => {
    const narrowed: EklavyaConfig = { ...config, domains_enabled: ['react'] };
    const id = seedEntry('Set httponly cookies on the refresh path');
    proposeFor(db, entryById(db, id)!, narrowed);
    expect(pendingCandidates(db, PROJECT).some((c) => c.domain === 'web-auth')).toBe(false);
  });

  it('mines each entry once, so a second sweep does not double the queue', () => {
    seedEntry('Set httponly cookies on the refresh path');
    const first = proposeForProject(db, config, PROJECT);
    expect(first).toBeGreaterThan(0);
    expect(proposeForProject(db, config, PROJECT)).toBe(0);
  });
});

describe('filling in for a session that logged nothing', () => {
  it('logs evidence-derived concepts when the agent logged none of its own', () => {
    seedEntry('Set httponly cookies on the refresh path');
    const result = fillOmissions(db, config, SESSION, PROJECT);
    expect(result.accepted).toBeGreaterThan(0);
    const logged = db
      .prepare('SELECT concept_id, origin, context FROM session_concepts WHERE session_id = ?')
      .all(SESSION) as { concept_id: number; origin: string; context: string }[];
    expect(logged.length).toBe(result.accepted);
    expect(logged[0]!.origin).toBe('work');
    expect(logged[0]!.context).toMatch(/from memory/);
  });

  it('leaves a session that logged properly completely alone', () => {
    // The model's own account of what it wrote beats anything derived from tool
    // arguments, and adding to it would inflate the gate with guesses.
    seedEntry('Set httponly cookies on the refresh path');
    logSessionConcept(db, SESSION, conceptBySlug(db, 'csrf')!.id, 'explicitly logged', 'work');
    const result = fillOmissions(db, config, SESSION, PROJECT);
    expect(result).toEqual({ accepted: 0, skipped: 0, reason: 'already_logged' });
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM session_concepts WHERE session_id = ?').get(SESSION) as {
        n: number;
      }).n,
    ).toBe(1);
  });

  it('fills only from this session\'s own entries, never another session\'s', () => {
    // One "design system audit" entry turned up as `design-tokens` in four
    // unrelated sessions: mined project-wide, the latest entry belongs to
    // whoever wrote it, not to the session that looked empty.
    insertEntry(db, { project: PROJECT, sessionId: 'an-earlier-session', title: 'Set httponly cookies on the refresh path' });
    expect(fillOmissions(db, config, SESSION, PROJECT).reason).toBe('no_candidates');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM session_concepts WHERE session_id = ?').get(SESSION) as { n: number }).n,
    ).toBe(0);
    // The earlier session's own fill still finds it.
    expect(fillOmissions(db, config, 'an-earlier-session', PROJECT).accepted).toBeGreaterThan(0);
  });

  it('still finds this session\'s candidates behind a pile of other sessions\' ones', () => {
    // Other sessions' candidates are never resolved by this session's fill, so
    // they accumulate; a capped project-wide list would crowd this one out.
    const other = insertEntry(db, { project: PROJECT, sessionId: 'someone-else', title: 'unrelated' });
    const insert = db.prepare(
      `INSERT INTO learning_sources (entry_id, slug, name, domain, confidence, status, project)
       VALUES (?, 'csrf', 'CSRF', 'web-auth', 0.95, 'candidate', ?)`,
    );
    for (let i = 0; i < 250; i++) insert.run(other, PROJECT);
    seedEntry('Set httponly cookies on the refresh path');
    expect(fillOmissions(db, config, SESSION, PROJECT).accepted).toBeGreaterThan(0);
  });

  it('says so rather than guessing when there is nothing to go on', () => {
    seedEntry('Rewrote the frobnicator gizmo pipeline end to end');
    expect(fillOmissions(db, config, SESSION, PROJECT).reason).toBe('no_candidates');
  });

  it('still records no attempt and no mastery for what it filled in', () => {
    seedEntry('Set httponly cookies on the refresh path');
    fillOmissions(db, config, SESSION, PROJECT);
    expect((db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM mastery').get() as { n: number }).n).toBe(0);
  });

  it('marks what it used as accepted, so the same candidate is not offered twice', () => {
    seedEntry('Set httponly cookies on the refresh path');
    fillOmissions(db, config, SESSION, PROJECT);
    const accepted = db
      .prepare("SELECT COUNT(*) AS n FROM learning_sources WHERE status = 'accepted'")
      .get() as { n: number };
    expect(accepted.n).toBeGreaterThan(0);
  });

  it('late candidate evidence must not reopen a passed gate or re-arm a completed task', () => {
    // PRD LRN-04 / quality scenario Q14. The protection is structural rather
    // than a guard, and this test is what says so if someone removes a link:
    // the `already_logged` check is a check on the *whole* of `session_concepts`,
    // and the only other two writers are `log_session_concepts` (which is what
    // sets a gate's bar) and `record_attempt` (which writes a row before it
    // grades). A session with a gate worth reopening therefore always has rows,
    // and `fillOmissions` never reaches its write.
    const csrf = conceptBySlug(db, 'csrf')!;
    logSessionConcept(db, SESSION, csrf.id, 'the task actually touched this', 'work');
    gradeConcept(db, {
      conceptId: csrf.id,
      sessionId: SESSION,
      question: 'what is csrf?',
      answer: 'a forged cross-site request',
      grade: 5,
      difficulty: 3,
      feedback: null,
      outcome: 'answered',
      format: 'mcq',
      options: null,
      repo: PROJECT,
      level: null,
      now: new Date(),
    });
    const before = syncGate(db, SESSION, config, { requiredHint: 1, repo: PROJECT });
    expect(before.passed).toBe(true);

    // Evidence lands after the gate has already been cleared.
    seedEntry('Set httponly cookies on the refresh path');
    expect(fillOmissions(db, config, SESSION, PROJECT).reason).toBe('already_logged');

    // Nothing new to raise the bar with, and nothing new for the Stop hook's
    // `logged > last_logged` guard to read as fresh work.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM session_concepts WHERE session_id = ?').get(SESSION) as {
        n: number;
      }).n,
    ).toBe(1);
    const after = syncGate(db, SESSION, config, { repo: PROJECT });
    expect(after).toEqual(before);
  });
});

describe('resolving what the memory observer proposed', () => {
  /** An observer proposal, as the worker writes it: free-form slug, 0.8 confidence. */
  function propose(entryId: number, slug: string, name: string, domain: string): void {
    addCandidate(db, { entryId, slug, name, domain, confidence: 0.8, project: PROJECT });
  }
  const rows = () =>
    db
      .prepare(
        `SELECT c.slug, c.domain, c.source FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id
          WHERE sc.session_id = ? ORDER BY c.slug`,
      )
      .all(SESSION) as { slug: string; domain: string; source: string }[];

  it('creates the concepts an observer named, instead of rejecting every one it has not seen', () => {
    // A real d-pilot session: the model never logged, the observer proposed
    // these, and exact-slug matching rejected all five -- so nothing was asked.
    const entry = seedEntry('Fixed truncated badge text in table status columns');
    propose(entry, 'badge_component', 'Mantine Badge component', 'ui_library');
    propose(entry, 'text_truncation', 'Text truncation with ellipsis', 'ui');
    const result = fillOmissions(db, config, SESSION, PROJECT);
    expect(result.accepted).toBe(2);
    expect(rows()).toEqual([
      { slug: 'badge-component', domain: 'ui-library', source: 'llm' },
      { slug: 'text-truncation', domain: 'ui', source: 'llm' },
    ]);
  });

  it('prefers a concept the graph already has over minting a near-duplicate', () => {
    const entry = seedEntry('Scoped a cookie');
    propose(entry, 'CSRF', 'Cross-site request forgery', 'security');
    fillOmissions(db, config, SESSION, PROJECT);
    expect(rows()).toEqual([{ slug: 'csrf', domain: 'web-auth', source: expect.any(String) }]);
    expect(conceptBySlug(db, 'csrf')!.domain).toBe('web-auth');
  });

  it('counts a concept once when two proposals land on it', () => {
    const entry = seedEntry('Laid out a table');
    propose(entry, 'table_layout', 'Table layout', 'css');
    propose(entry, 'table-layout', 'Table layout', 'css');
    const result = fillOmissions(db, config, SESSION, PROJECT);
    expect(result.accepted).toBe(1);
    expect(rows()).toHaveLength(1);
  });

  it('creates no more than the session budget, and leaves the rest as candidates', () => {
    const entry = seedEntry('Restyled a button');
    config = { ...config, max_new_concepts_per_session: 1 };
    propose(entry, 'button_variant', 'Button variants', 'ui');
    propose(entry, 'destructive_action', 'Destructive action styling', 'ui');
    expect(fillOmissions(db, config, SESSION, PROJECT).accepted).toBe(1);
    expect(rows()).toHaveLength(1);
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM learning_sources WHERE status = 'candidate' AND entry_id = ?")
      .get(entry) as { n: number };
    expect(pending.n).toBe(1);
  });

  it('never creates a concept in a disabled domain', () => {
    const entry = seedEntry('Restyled a button');
    config = { ...config, domains_enabled: ['web-auth'] };
    propose(entry, 'button_variant', 'Button variants', 'ui');
    expect(fillOmissions(db, config, SESSION, PROJECT).accepted).toBe(0);
    expect(conceptBySlug(db, 'button-variant')).toBeUndefined();
  });
});
