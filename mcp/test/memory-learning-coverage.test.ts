import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { addCandidate, appendEvent, entryById, insertEntry, pendingCandidates } from '../src/memory/store.js';
import { fillOmissions, proposeFor } from '../src/memory/learning.js';
import { conceptBySlug, logSessionConcept } from '../src/store.js';

const PROJECT = '/tmp/learning-cov';
const SESSION = 'sess-learning-cov';

let dbFile: string;
let db: DB;
let config: EklavyaConfig;

beforeEach(() => {
  dbFile = tempDbPath('eklavya-learning-cov');
  db = openDb(dbFile);
  config = structuredClone(DEFAULT_CONFIG);
});
afterEach(() => {
  db.close();
  cleanup(dbFile);
});

const entry = (title: string, narrative = '') =>
  entryById(db, insertEntry(db, { project: PROJECT, sessionId: SESSION, title, narrative }))!;
const propose = (entryId: number | null, slug: string, name: string, domain: string, eventId: number | null = null) =>
  addCandidate(db, { entryId, eventId, slug, name, domain, confidence: 0.8, project: PROJECT });
const logged = () =>
  db
    .prepare(
      `SELECT c.slug, c.name, c.domain, sc.context FROM session_concepts sc JOIN concepts c ON c.id = sc.concept_id
        WHERE sc.session_id = ? ORDER BY c.slug`,
    )
    .all(SESSION) as { slug: string; name: string; domain: string; context: string }[];

describe('proposeFor edges', () => {
  it('proposes nothing when the graph has no concepts', () => {
    const e = entry('csrf protection');
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM concepts').run();
    expect(proposeFor(db, e, config)).toBe(0);
  });

  it('skips phrases that normalize to nothing and weights a fuzzy match below an exact one', () => {
    // `____` survives tokenizing but normalizes to an empty slug; `csrfs` is a
    // plural that fuzzy-matches the seeded `csrf` concept.
    const e = entry('____ csrfs');
    expect(proposeFor(db, e, config)).toBe(1);
    expect(pendingCandidates(db, PROJECT).map((c) => [c.slug, c.confidence])).toEqual([['csrf', 0.4]]);
  });

  it('ignores a matched concept whose domain is disabled', () => {
    config.domains_enabled = ['nothing-here'];
    expect(proposeFor(db, entry('csrf'), config)).toBe(0);
  });
});

describe('fillOmissions edges', () => {
  it('spends nothing once the session budget is gone', () => {
    const e = entry('Worked on things');
    propose(e.id, 'brand-new-idea', 'Brand new idea', 'ui');
    config.max_new_concepts_per_session = 0;
    expect(fillOmissions(db, config, SESSION, PROJECT)).toEqual({ accepted: 0, skipped: 1, reason: 'budget' });
  });

  it('accepts at most five concepts', () => {
    const e = entry('Worked on things');
    for (const s of ['alpha-one', 'beta-two', 'gamma-three', 'delta-four', 'epsilon-five', 'zeta-six']) {
      propose(e.id, s, s, 'ui');
    }
    expect(fillOmissions(db, config, SESSION, PROJECT)).toEqual({ accepted: 5, skipped: 1 });
    expect(pendingCandidates(db, PROJECT).map((c) => c.slug)).toEqual(['zeta-six']);
  });

  it('rejects invalid slugs and disabled domains, names bare concepts from the slug, and credits event-only evidence', () => {
    const { id: eventId } = appendEvent(db, {
      eventUid: 'ev-1',
      project: PROJECT,
      sessionId: SESSION,
      kind: 'note',
      body: 'something',
    });
    propose(null, '!!!', 'nothing valid', 'ui', eventId);
    propose(null, 'csrf', 'CSRF', 'security', eventId);
    propose(null, 'fresh-topic', '   ', '', eventId);
    propose(null, 'blocked-topic', 'Blocked', 'blocked', eventId);
    config.domains_enabled = ['general'];

    expect(fillOmissions(db, config, SESSION, PROJECT)).toEqual({ accepted: 1, skipped: 3 });
    expect(logged()).toEqual([
      { slug: 'fresh-topic', name: 'fresh topic', domain: 'general', context: "derived from this session's evidence" },
    ]);
    const statuses = db.prepare('SELECT slug, status FROM learning_sources ORDER BY id').all();
    expect(statuses).toEqual([
      { slug: '!!!', status: 'rejected' },
      { slug: 'csrf', status: 'rejected' },
      { slug: 'fresh-topic', status: 'accepted' },
      { slug: 'blocked-topic', status: 'rejected' },
    ]);
    expect(conceptBySlug(db, 'blocked-topic')).toBeUndefined();
  });

  it('still counts an already-logged check before anything else', () => {
    logSessionConcept(db, SESSION, conceptBySlug(db, 'csrf')!.id, 'explicit', 'work');
    expect(fillOmissions(db, config, SESSION, PROJECT).reason).toBe('already_logged');
  });
});
