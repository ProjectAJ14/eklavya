import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { loadSeedGraphs, seedAll, seedIfNeeded } from '../src/seed.js';
import { seedDir } from '../src/paths.js';
import { isValidSlug } from '../src/slug.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
afterEach(() => {
  if (dbFile) cleanup(dbFile);
  dbFile = '';
});

function count(db: import('better-sqlite3').Database, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...(args as [])) as { n: number }).n;
}

describe('seed graphs on disk', () => {
  const graphs = loadSeedGraphs();

  it('all parse and validate', () => {
    expect(graphs.length).toBeGreaterThanOrEqual(4);
  });

  it('meets the phase-0 size floors', () => {
    const webAuth = graphs.find((g) => g.domain === 'web-auth');
    const git = graphs.find((g) => g.domain === 'git');
    expect(webAuth!.concepts.length).toBeGreaterThanOrEqual(20);
    expect(webAuth!.edges!.some((e) => e.relation === 'prerequisite_of')).toBe(true);
    expect(git!.concepts.length).toBeGreaterThanOrEqual(10);
  });

  it('uses only normalized slugs, unique across every domain', () => {
    const seen = new Set<string>();
    for (const g of graphs) {
      for (const c of g.concepts) {
        expect(isValidSlug(c.slug)).toBe(true);
        expect(seen.has(c.slug), `duplicate slug ${c.slug}`).toBe(false);
        seen.add(c.slug);
      }
    }
  });

  it('spans a range of tiers so the tutor can escalate difficulty', () => {
    for (const g of graphs) {
      const tiers = new Set(g.concepts.map((c) => c.tier));
      expect(tiers.size, `${g.domain} has only one tier`).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('seeding into the database', () => {
  it('loads every graph on first open', () => {
    dbFile = tempDbPath('seed');
    const db = openDb(dbFile);
    const expected = loadSeedGraphs().reduce((n, g) => n + g.concepts.length, 0);
    expect(count(db, 'SELECT count(*) n FROM concepts')).toBe(expected);
    expect(count(db, 'SELECT count(*) n FROM edges')).toBeGreaterThan(0);
    expect(count(db, "SELECT count(*) n FROM concepts WHERE source = 'seed'")).toBe(expected);
    db.close();
  });

  it('is idempotent — reseeding does not duplicate concepts or edges', () => {
    dbFile = tempDbPath('seed-idem');
    const db = openDb(dbFile);
    const concepts = count(db, 'SELECT count(*) n FROM concepts');
    const edges = count(db, 'SELECT count(*) n FROM edges');

    seedAll(db);
    seedAll(db);

    expect(count(db, 'SELECT count(*) n FROM concepts')).toBe(concepts);
    expect(count(db, 'SELECT count(*) n FROM edges')).toBe(edges);
    db.close();
  });

  it('skips work when the seed version is already current', () => {
    dbFile = tempDbPath('seed-version');
    const db = openDb(dbFile);
    expect(seedIfNeeded(db)).toBeNull();
    db.close();
  });

  it('never clobbers a learner\'s mastery when seeds are updated', () => {
    dbFile = tempDbPath('seed-mastery');
    const db = openDb(dbFile);
    const id = (db.prepare('SELECT id FROM concepts WHERE slug = ?').get('jwt-structure') as { id: number }).id;
    db.prepare(
      'INSERT INTO mastery (concept_id, score, ease, interval_d, reps) VALUES (?, 0.83, 2.7, 6, 3)',
    ).run(id);

    seedAll(db);

    const m = db.prepare('SELECT score, ease, interval_d, reps FROM mastery WHERE concept_id = ?').get(id);
    expect(m).toEqual({ score: 0.83, ease: 2.7, interval_d: 6, reps: 3 });
    db.close();
  });

  it('reopening the database does not re-run seeding', () => {
    dbFile = tempDbPath('seed-reopen');
    openDb(dbFile).close();
    const db = openDb(dbFile);
    const expected = loadSeedGraphs().reduce((n, g) => n + g.concepts.length, 0);
    expect(count(db, 'SELECT count(*) n FROM concepts')).toBe(expected);
    db.close();
  });
});

describe('seed validation', () => {
  function withTempSeed(graph: unknown, fn: (dir: string) => void): void {
    const dir = fs.mkdtempSync(path.join(seedDir(), '..', 'tmp-seed-'));
    try {
      fs.writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(graph));
      fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('rejects an invalid slug', () => {
    withTempSeed({ domain: 'x', concepts: [{ slug: 'Not A Slug', name: 'n', tier: 1 }] }, (dir) => {
      expect(() => loadSeedGraphs(dir)).toThrow(/invalid slug/);
    });
  });

  it('rejects an out-of-range tier', () => {
    withTempSeed({ domain: 'x', concepts: [{ slug: 'ok', name: 'n', tier: 9 }] }, (dir) => {
      expect(() => loadSeedGraphs(dir)).toThrow(/tier/);
    });
  });

  it('rejects an edge pointing at an unknown slug', () => {
    withTempSeed(
      {
        domain: 'x',
        concepts: [{ slug: 'ok', name: 'n', tier: 1 }],
        edges: [{ from: 'ok', to: 'ghost', relation: 'prerequisite_of' }],
      },
      (dir) => {
        expect(() => loadSeedGraphs(dir)).toThrow(/unknown slug/);
      },
    );
  });

  it('rejects an unknown relation', () => {
    withTempSeed(
      {
        domain: 'x',
        concepts: [
          { slug: 'a', name: 'n', tier: 1 },
          { slug: 'b', name: 'n', tier: 1 },
        ],
        edges: [{ from: 'a', to: 'b', relation: 'causes' }],
      },
      (dir) => {
        expect(() => loadSeedGraphs(dir)).toThrow(/relation/);
      },
    );
  });
});
