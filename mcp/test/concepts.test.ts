import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db.js';
import { logSessionConcepts } from '../src/tools/log_session_concepts.js';
import { upsertConcepts } from '../src/tools/upsert_concepts.js';
import { cleanTags, findCandidates, growConcept, parseTags, tokens } from '../src/concepts.js';
import { conceptBySlug, insertConcept } from '../src/store.js';
import { tempDbPath, cleanup } from './helpers.js';
import { z } from 'zod';

let dbFile = '';
let db: DB;
let home = '';
const envBackup = { ...process.env };

const call = <T>(tool: { handler: (a: any, c: any) => unknown }, args: Record<string, unknown>): T =>
  tool.handler({ cwd: home, session_id: 'sess', ...args }, { db }) as T;

/** The args as the MCP layer validates them, so a schema refusal shows up here too. */
const accepts = (tool: { inputSchema: z.ZodRawShape }, args: Record<string, unknown>) =>
  z.object(tool.inputSchema).safeParse({ session_id: 'sess', ...args }).success;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  process.env.EKLAVYA_HOME = home;
  delete process.env.EKLAVYA_SESSION_ID;
  dbFile = tempDbPath('concepts');
  db = openDb(dbFile);
  insertConcept(db, {
    slug: 'flutter-animation',
    name: 'Flutter animation',
    domain: 'flutter',
    tier: 2,
    description: 'Driving widget changes over time with AnimationController, Tween and implicit animations.',
    tags: ['flutter', 'animation'],
    source: 'llm',
  });
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  process.env = { ...envBackup };
});

describe('tokens', () => {
  it('splits camelCase, folds plurals and drops filler', () => {
    expect(tokens('AnimationController of the Worktrees')).toEqual(['animation', 'controller', 'worktree']);
  });
});

describe('cleanTags', () => {
  it('lowercases, hyphenates, dedupes and caps', () => {
    expect(cleanTags(['Flutter', 'flutter', 'Rate Limiting', '', 'a', 'b', 'c', 'd'], 4)).toEqual(['flutter', 'rate-limiting', 'a', 'b']);
  });
  it('reads a stored value that is not an array as no tags', () => {
    expect(parseTags('nonsense')).toEqual([]);
    expect(parseTags('{"a":1}')).toEqual([]);
  });
});

describe('findCandidates', () => {
  it('finds the concept a differently named one belongs to', () => {
    const got = findCandidates(db, { slug: 'animation-controller-dispose', name: 'Dispose animation controller' });
    expect(got[0]?.slug).toBe('flutter-animation');
    expect(got[0]?.description).toContain('AnimationController');
  });

  it('finds a concept whose whole name sits inside a longer one', () => {
    insertConcept(db, { slug: 'idempotency', name: 'Idempotency', domain: 'api', tier: 2, description: 'Repeating an operation without changing the result.', tags: ['api'], source: 'llm' });
    expect(findCandidates(db, { slug: 'idempotency-keys', name: 'Idempotency key' })[0]?.slug).toBe('idempotency');
  });

  it('finds nothing for an unrelated concept', () => {
    expect(findCandidates(db, { slug: 'bloom-filter', name: 'Bloom filter' })).toEqual([]);
  });
});

describe('growConcept', () => {
  it('adds tags and never removes any', () => {
    const c = conceptBySlug(db, 'flutter-animation')!;
    expect(growConcept(db, c, { tags: ['ui'] })).toBe(true);
    expect(parseTags(conceptBySlug(db, 'flutter-animation')!.tags)).toEqual(['flutter', 'animation', 'ui']);
  });

  it('refines a model-minted description that keeps the old meaning', () => {
    const c = conceptBySlug(db, 'flutter-animation')!;
    growConcept(db, c, { description: 'Driving widget changes over time with AnimationController and Tween, and disposing the ticker.' });
    expect(conceptBySlug(db, 'flutter-animation')!.description).toContain('disposing the ticker');
  });

  it('refuses a replacement that drops what the old description said', () => {
    const c = conceptBySlug(db, 'flutter-animation')!;
    growConcept(db, c, { description: 'Something else entirely about sockets.' });
    expect(conceptBySlug(db, 'flutter-animation')!.description).toContain('AnimationController');
  });

  it('leaves the catalogue description alone', () => {
    const seeded = insertConcept(db, { slug: 'seeded-one', name: 'Seeded one', domain: 'x', tier: 1, description: 'The curated text.', source: 'seed' });
    expect(growConcept(db, seeded, { description: 'The curated text, rewritten by a model.' })).toBe(false);
    expect(conceptBySlug(db, 'seeded-one')!.description).toBe('The curated text.');
  });
});

describe('log_session_concepts', () => {
  it('holds a new concept that resembles an existing one and offers it', () => {
    const r = call<any>(logSessionConcepts, { concepts: [{ slug: 'animation-controller-dispose', name: 'Dispose controller', context: 'pulse.dart' }] });
    expect(r.created).toEqual([]);
    expect(r.logged).toEqual([]);
    expect(r.needs_decision[0].requested).toBe('animation-controller-dispose');
    expect(r.needs_decision[0].candidates[0].slug).toBe('flutter-animation');
    expect(r.next_action).toContain('new: true');
    expect(conceptBySlug(db, 'animation-controller-dispose')).toBeUndefined();
  });

  it('logs the candidate when the model picks it, and deepens its description and tags', () => {
    const r = call<any>(logSessionConcepts, {
      concepts: [{ slug: 'flutter-animation', description: 'Driving widget changes over time with AnimationController, Tween and implicit animations, and disposing the controller.', tags: ['ui'], context: 'pulse.dart' }],
    });
    expect(r.logged).toEqual(['flutter-animation']);
    const c = conceptBySlug(db, 'flutter-animation')!;
    expect(c.description).toContain('disposing the controller');
    expect(parseTags(c.tags)).toContain('ui');
  });

  it('creates the concept when the model says it is new, with its description and tags', () => {
    const r = call<any>(logSessionConcepts, {
      concepts: [{ slug: 'animation-controller-dispose', name: 'Controller disposal', description: 'Releasing the ticker.', tags: ['flutter', 'lifecycle'], new: true, context: 'pulse.dart' }],
    });
    expect(r.created).toEqual(['animation-controller-dispose']);
    expect(r.needs_decision).toEqual([]);
    const c = conceptBySlug(db, 'animation-controller-dispose')!;
    expect(c.description).toBe('Releasing the ticker.');
    expect(parseTags(c.tags)).toEqual(['flutter', 'lifecycle']);
    expect(c.domain).toBe('flutter');
  });

  it('creates an unrelated concept straight away', () => {
    const r = call<any>(logSessionConcepts, { concepts: [{ slug: 'bloom-filter', name: 'Bloom filter', context: 'bloom.dart' }] });
    expect(r.created).toEqual(['bloom-filter']);
    expect(r.needs_decision).toEqual([]);
  });

  it('rejects a name longer than three words', () => {
    expect(accepts(logSessionConcepts, { concepts: [{ slug: 'x', name: 'one two three' }] })).toBe(true);
    expect(accepts(logSessionConcepts, { concepts: [{ slug: 'x', name: 'one two three four' }] })).toBe(false);
  });

  it('bounds the description and the tags', () => {
    expect(accepts(logSessionConcepts, { concepts: [{ slug: 'x', description: 'a'.repeat(401) }] })).toBe(false);
    expect(accepts(logSessionConcepts, { concepts: [{ slug: 'x', tags: ['a', 'b', 'c', 'd', 'e', 'f'] }] })).toBe(false);
  });
});

describe('log_session_concepts prerequisites', () => {
  const edge = (from: string, to: string) =>
    db
      .prepare(
        `SELECT 1 FROM edges e JOIN concepts f ON f.id = e.from_concept JOIN concepts t ON t.id = e.to_concept
          WHERE f.slug = ? AND t.slug = ? AND e.relation = 'prerequisite_of'`,
      )
      .get(from, to);

  it('links a new concept to an existing one and to another in the same call', () => {
    const r = call<any>(logSessionConcepts, {
      concepts: [
        { slug: 'bloom-filter', name: 'Bloom filter', prerequisites: ['hash-maps', 'flutter-animation'], context: 'bloom.dart' },
        { slug: 'hash-maps', name: 'Hash maps', new: true, context: 'bloom.dart' },
      ],
    });
    expect(r.created.sort()).toEqual(['bloom-filter', 'hash-maps']);
    expect(edge('flutter-animation', 'bloom-filter')).toBeTruthy();
    expect(edge('hash-maps', 'bloom-filter')).toBeTruthy();
    expect(r.edges_added).toBe(2);
  });

  it('asks for a follow-up only for created concepts that still have no edge', () => {
    const r = call<any>(logSessionConcepts, {
      concepts: [
        { slug: 'bloom-filter', name: 'Bloom filter', prerequisites: ['flutter-animation'], context: 'a.dart' },
        { slug: 'quadtree', name: 'Quadtree', context: 'b.dart' },
      ],
    });
    expect(r.unlinked).toEqual(['quadtree']);
    expect(r.next_action).toContain('quadtree');
    expect(r.next_action).not.toContain('bloom-filter');
  });

  it('says nothing when every created concept has its prerequisites', () => {
    const r = call<any>(logSessionConcepts, {
      concepts: [{ slug: 'bloom-filter', name: 'Bloom filter', prerequisites: ['flutter-animation'], context: 'a.dart' }],
    });
    expect(r.unlinked).toEqual([]);
    expect(r.next_action).toBeUndefined();
  });

  it('finds a prerequisite the way the slug matcher does, and reports one it cannot find', () => {
    const r = call<any>(logSessionConcepts, {
      concepts: [{ slug: 'bloom-filter', name: 'Bloom filter', prerequisites: ['flutter-animations', 'no-such-thing'], context: 'a.dart' }],
    });
    expect(edge('flutter-animation', 'bloom-filter')).toBeTruthy();
    expect(r.edges_added).toBe(1);
    expect(r.prerequisites_not_found).toEqual([{ concept: 'bloom-filter', requested: 'no-such-thing' }]);
  });

  it('ignores a prerequisite that does not exist and a concept naming itself', () => {
    const r = call<any>(logSessionConcepts, {
      concepts: [{ slug: 'bloom-filter', name: 'Bloom filter', prerequisites: ['nonexistent-thing', 'bloom-filter'], context: 'a.dart' }],
    });
    expect(r.edges_added).toBe(0);
    expect(r.unlinked).toEqual(['bloom-filter']);
  });
});

describe('upsert_concepts', () => {
  it('holds a lookalike and lets new: true through', () => {
    const held = call<any>(upsertConcepts, { concepts: [{ slug: 'animation-controller-dispose', name: 'Dispose controller' }] });
    expect(held.created).toEqual([]);
    expect(held.needs_decision[0].candidates[0].slug).toBe('flutter-animation');

    const made = call<any>(upsertConcepts, { concepts: [{ slug: 'animation-controller-dispose', name: 'Dispose controller', new: true, tags: ['flutter'] }] });
    expect(made.created).toEqual(['animation-controller-dispose']);
  });

  it('places a model-made concept again, even when its tag gave it a domain, until it is asked about', () => {
    call<any>(logSessionConcepts, { concepts: [{ slug: 'bloom-filter', name: 'Bloom filter', tags: ['flutter'], context: 'a.dart' }] });
    expect(conceptBySlug(db, 'bloom-filter')!.domain).toBe('flutter');

    const r = call<any>(upsertConcepts, { concepts: [{ slug: 'bloom-filter', domain: 'data-structures', tier: 4 }] });
    expect(r.updated).toEqual(['bloom-filter']);
    expect(conceptBySlug(db, 'bloom-filter')).toMatchObject({ domain: 'data-structures', tier: 4 });
  });

  it('leaves a concept alone once a question has been asked about it', () => {
    call<any>(logSessionConcepts, { concepts: [{ slug: 'bloom-filter', name: 'Bloom filter', tags: ['flutter'], context: 'a.dart' }] });
    const c = conceptBySlug(db, 'bloom-filter')!;
    db.prepare("INSERT INTO attempts (concept_id, question, grade, difficulty) VALUES (?, 'q', 4, 2)").run(c.id);

    const r = call<any>(upsertConcepts, { concepts: [{ slug: 'bloom-filter', domain: 'data-structures', tier: 4 }] });
    expect(r.updated).toEqual([]);
    expect(conceptBySlug(db, 'bloom-filter')).toMatchObject({ domain: 'flutter', tier: 2 });
  });

  it('adds tags to a concept it met again', () => {
    const r = call<any>(upsertConcepts, { concepts: [{ slug: 'flutter-animation', tags: ['motion'] }] });
    expect(r.updated).toEqual(['flutter-animation']);
    expect(parseTags(conceptBySlug(db, 'flutter-animation')!.tags)).toContain('motion');
  });
});
