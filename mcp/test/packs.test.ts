import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, type DB } from '../src/db.js';
import {
  applyPacks,
  applyPacksIfNeeded,
  loadPacks,
  packDirs,
  packFingerprint,
  packFingerprintKey,
} from '../src/packs.js';
import { SEED_VERSION } from '../src/seed.js';
import { tempDbPath, cleanup } from './helpers.js';

let dbFile = '';
let db: DB;
let home = '';
let repo = '';

/** A pack on disk, in whichever scope. `packs/` under both, by design. */
function writePack(scope: 'global' | 'repo', name: string, body: unknown): string {
  const dir =
    scope === 'global' ? path.join(home, 'packs') : path.join(repo, '.eklavya', 'packs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
  return file;
}

const RUST = {
  pack: 'eklavya-pack-rust',
  version: '1.0.0',
  domain: 'rust',
  concepts: [
    { slug: 'rust-ownership', name: 'Ownership', tier: 1 },
    { slug: 'rust-borrow-checker', name: 'The borrow checker', tier: 2 },
  ],
  edges: [{ from: 'rust-ownership', to: 'rust-borrow-checker', relation: 'prerequisite_of' }],
};

const conceptRow = (slug: string) =>
  db.prepare('SELECT slug, name, domain, tier, source FROM concepts WHERE slug = ?').get(slug) as
    | { slug: string; name: string; domain: string; tier: number; source: string }
    | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-home-'));
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-repo-'));
  // findRepoConfig walks up looking for .git, so the repo scope needs one.
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  process.env.EKLAVYA_HOME = home;
  dbFile = tempDbPath('packs');
  db = openDb(dbFile);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  delete process.env.EKLAVYA_HOME;
});

describe('where packs come from', () => {
  it('reads the global directory and the repository, global first', () => {
    // Order is the merge order: later wins, so the repo's pack is applied last.
    const dirs = packDirs(repo);
    expect(dirs.map((d) => d.scope)).toEqual(['global', 'repo']);
    expect(dirs[0].dir).toBe(path.join(home, 'packs'));
    // findRepoConfig resolves symlinks, and /var is one on macOS.
    expect(dirs[1].dir).toBe(path.join(fs.realpathSync(repo), '.eklavya', 'packs'));
  });

  it('has no repo scope outside a repository', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-bare-'));
    expect(packDirs(outside).map((d) => d.scope)).toEqual(['global']);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('treats a missing packs directory as no packs, not as an error', () => {
    expect(loadPacks(repo)).toEqual([]);
  });
});

describe('applying a pack', () => {
  it('adds its concepts and its edges', () => {
    writePack('global', 'rust', RUST);
    const summary = applyPacks(db, repo);

    expect(summary.applied).toBe(1);
    expect(summary.concepts).toBe(2);
    expect(summary.edges).toBe(1);
    expect(conceptRow('rust-ownership')).toMatchObject({ domain: 'rust', tier: 1, source: 'pack' });
  });

  it('merges over the seed rather than replacing it', () => {
    // The whole promise of the format: a team retiers a shipped concept for its
    // own codebase, and everything else Eklavya ships is still there.
    const before = conceptRow('jwt-structure');
    expect(before).toBeTruthy();

    writePack('global', 'over', {
      pack: 'retier',
      domain: 'web-auth',
      concepts: [{ slug: 'jwt-structure', name: 'JWT structure', tier: 5 }],
    });
    applyPacks(db, repo);

    expect(conceptRow('jwt-structure')).toMatchObject({ tier: 5, source: 'pack' });
    const total = db.prepare('SELECT count(*) AS n FROM concepts').get() as { n: number };
    expect(total.n).toBeGreaterThan(80);
  });

  it('lets the repository win over the global pack', () => {
    writePack('global', 'a', {
      pack: 'global-one',
      domain: 'rust',
      concepts: [{ slug: 'rust-ownership', name: 'Global name', tier: 1 }],
    });
    writePack('repo', 'b', {
      pack: 'repo-one',
      domain: 'rust',
      concepts: [{ slug: 'rust-ownership', name: 'Repo name', tier: 3 }],
    });
    applyPacks(db, repo);

    expect(conceptRow('rust-ownership')).toMatchObject({ name: 'Repo name', tier: 3 });
  });

  it('never touches mastery, so a learner keeps their history', () => {
    writePack('global', 'rust', RUST);
    applyPacks(db, repo);
    const id = (db.prepare('SELECT id FROM concepts WHERE slug = ?').get('rust-ownership') as {
      id: number;
    }).id;
    db.prepare('INSERT INTO mastery (concept_id, score, reps) VALUES (?, 0.9, 3)').run(id);

    writePack('global', 'rust', { ...RUST, concepts: [{ ...RUST.concepts[0], tier: 4 }] });
    applyPacks(db, repo);

    const m = db.prepare('SELECT score, reps FROM mastery WHERE concept_id = ?').get(id) as {
      score: number;
      reps: number;
    };
    expect(m).toMatchObject({ score: 0.9, reps: 3 });
  });
});

describe('a pack that is wrong', () => {
  it('does not take the rest of Eklavya down with it', () => {
    // openDb() is on the path of every CLI command and the server's own start.
    // One bad file must cost one pack, not the tool.
    writePack('global', 'broken', '{ not json');
    writePack('global', 'good', RUST);

    const summary = applyPacks(db, repo);
    expect(summary.applied).toBe(1);
    expect(summary.errors).toHaveLength(1);
    expect(conceptRow('rust-ownership')).toBeTruthy();
  });

  it('is rejected when it does not say who it is', () => {
    writePack('global', 'anon', { domain: 'rust', concepts: RUST.concepts });
    expect(loadPacks(repo)[0].error).toMatch(/pack/);
  });

  it('is rejected on an invalid slug or an impossible tier, like a seed file', () => {
    writePack('global', 'bad-slug', {
      pack: 'p',
      domain: 'rust',
      concepts: [{ slug: 'Rust Ownership', name: 'x', tier: 1 }],
    });
    expect(loadPacks(repo)[0].error).toMatch(/slug/);
  });
});

describe('edges that leave the pack', () => {
  it('may point at a concept the pack did not declare', () => {
    // A pack extending a shipped domain has to be able to say "this comes
    // before that one" about something Eklavya already seeded.
    writePack('global', 'bridge', {
      pack: 'bridge',
      domain: 'web-auth',
      concepts: [{ slug: 'passkey-attestation', name: 'Passkey attestation', tier: 3 }],
      edges: [
        { from: 'jwt-structure', to: 'passkey-attestation', relation: 'prerequisite_of' },
      ],
    });
    const summary = applyPacks(db, repo);
    expect(summary.edges).toBe(1);
    expect(summary.edgesDropped).toBe(0);
  });

  it('counts an endpoint that names nothing instead of failing the pack', () => {
    writePack('global', 'typo', {
      pack: 'typo',
      domain: 'rust',
      concepts: [{ slug: 'rust-ownership', name: 'Ownership', tier: 1 }],
      edges: [{ from: 'rust-ownershp', to: 'rust-ownership', relation: 'prerequisite_of' }],
    });
    const summary = applyPacks(db, repo);
    expect(summary.applied).toBe(1);
    expect(summary.edgesDropped).toBe(1);
  });
});

describe('when packs are re-applied', () => {
  const storedFor = (cwd: string) =>
    (
      db
        .prepare('SELECT value FROM meta WHERE key = ?')
        .get(packFingerprintKey(packDirs(cwd).map((d) => d.dir))) as { value: string } | undefined
    )?.value;

  it('applies once, then not again while nothing on disk changed', () => {
    writePack('global', 'rust', RUST);
    expect(applyPacksIfNeeded(db, repo)?.applied).toBe(1);
    expect(applyPacksIfNeeded(db, repo)).toBeNull();
  });

  it('applies again when a pack file changes', () => {
    const file = writePack('global', 'rust', RUST);
    applyPacksIfNeeded(db, repo);

    fs.writeFileSync(
      file,
      JSON.stringify({ ...RUST, concepts: [{ ...RUST.concepts[0], name: 'Ownership, revised' }] }),
    );
    expect(applyPacksIfNeeded(db, repo)?.applied).toBe(1);
    expect(conceptRow('rust-ownership')?.name).toBe('Ownership, revised');
  });

  it('settles in a repository with no packs at all, rather than writing every open', () => {
    // The empty set still records "this scope has seen this state". Skipping
    // that write does not save anything -- it just means the next open finds no
    // row and applies again, for ever.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-bare-'));
    expect(applyPacksIfNeeded(db, bare)?.applied).toBe(0);
    expect(applyPacksIfNeeded(db, bare)).toBeNull();
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it('keeps one record per scope, so two repositories do not thrash', () => {
    // A single global row meant every open in repo A saw repo B's hash, applied,
    // and stored its own: a write on every CLI invocation for anyone with a repo
    // pack and more than one project.
    writePack('repo', 'here', {
      pack: 'here',
      domain: 'rust',
      concepts: [{ slug: 'rust-ownership', name: 'Ownership', tier: 1 }],
    });
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-other-'));
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });

    applyPacksIfNeeded(db, repo);
    applyPacksIfNeeded(db, other);
    expect(applyPacksIfNeeded(db, repo)).toBeNull();
    expect(applyPacksIfNeeded(db, other)).toBeNull();
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('folds the seed version in, so a re-seed marks every scope stale at once', () => {
    // seedIfNeeded upserts every shipped concept back to its shipped tier, which
    // undoes what a pack merged over it. The pack has to land again -- and in
    // EVERY repository, not just the one the learner happened to be in when the
    // re-seed ran, which is what a per-scope record on its own would give.
    const file = writePack('global', 'over', {
      pack: 'retier',
      domain: 'web-auth',
      concepts: [{ slug: 'jwt-structure', name: 'JWT structure', tier: 5 }],
    });
    applyPacksIfNeeded(db, repo);
    expect(applyPacksIfNeeded(db, repo)).toBeNull();

    // As if the row had been written by the previous seed version.
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
      packFingerprint([file], SEED_VERSION - 1),
      packFingerprintKey(packDirs(repo).map((d) => d.dir)),
    );
    db.prepare("UPDATE concepts SET tier = 1, source = 'seed' WHERE slug = 'jwt-structure'").run();

    expect(applyPacksIfNeeded(db, repo)?.applied).toBe(1);
    expect(conceptRow('jwt-structure')).toMatchObject({ tier: 5, source: 'pack' });
    expect(storedFor(repo)).toBe(packFingerprint([file]));
  });
});

describe('opening the database', () => {
  it('applies packs, which is what makes this a feature rather than a library', () => {
    // The whole wiring is one line in db.ts, and nothing else here goes through
    // it: every other test calls the loader directly with an explicit cwd.
    writePack('global', 'rust', RUST);
    const cwd = process.cwd();
    const file = tempDbPath('packs-open');
    try {
      process.chdir(repo);
      const fresh = openDb(file);
      const row = fresh
        .prepare('SELECT slug, source FROM concepts WHERE slug = ?')
        .get('rust-ownership');
      fresh.close();
      expect(row).toMatchObject({ source: 'pack' });
    } finally {
      process.chdir(cwd);
      cleanup(file);
    }
  });
});
