/**
 * Concept packs: the graph as data someone else can write.
 *
 * The shipped catalogue in `src/seed/` is already JSON rather than code, but it
 * is *ours*: four graphs — git, node-backend, react, web-auth — and the only way
 * to add a fifth was a pull request to this repository. Everything else a
 * developer actually works in arrives only as whatever `upsert_concepts` minted
 * mid-session. A pack is the same file shape, loaded from two places Eklavya
 * does not own:
 *
 *   ~/.eklavya/packs/*.json        the learner's own, and anything installed
 *   <repo>/.eklavya/packs/*.json   a team's, versioned with the codebase
 *
 * The second is the interesting one. A repository that ships its own concepts
 * and prerequisites is describing itself to a new joiner, which is onboarding
 * rather than quizzing.
 *
 * Packs are applied AFTER the seed and merged over it, so a pack may retier or
 * rename a shipped concept, and a repo pack wins over a global one. Nothing
 * here touches `mastery`: the seed's rule is the pack's rule, and a learner's
 * history survives any pack being installed, edited or deleted.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { eklavyaHome } from './paths.js';
import { findRepoConfig } from './config.js';
import { applySeedGraph, validateSeedGraph, SEED_VERSION, type SeedGraph } from './seed.js';

/** A pack is a seed graph that says who it is. */
export interface Pack extends SeedGraph {
  pack: string;
  version?: string;
}

export interface LoadedPack {
  file: string;
  scope: 'global' | 'repo';
  pack?: Pack;
  error?: string;
}

/**
 * One row per set of pack directories, not one row for the install.
 *
 * The pack set depends on the working directory, so a single global row made
 * two repositories fight over it: every `openDb()` in repo A saw repo B's hash,
 * re-applied, and stored its own — a write on every CLI invocation for anyone
 * with a repo pack and more than one project.
 */
export function packFingerprintKey(dirs: string[]): string {
  return `packs_fingerprint:${crypto.createHash('sha256').update(dirs.join('\n')).digest('hex').slice(0, 16)}`;
}

/**
 * Global first, repo second, because later wins. `packs/` under both, so the
 * rule is one sentence: packs live in a `packs/` directory next to Eklavya's
 * state, whether that state is yours or the repository's.
 */
export function packDirs(cwd: string = process.cwd()): Array<{ dir: string; scope: 'global' | 'repo' }> {
  const dirs: Array<{ dir: string; scope: 'global' | 'repo' }> = [
    { dir: path.join(eklavyaHome(), 'packs'), scope: 'global' },
  ];
  const { repoRoot } = findRepoConfig(cwd);
  if (repoRoot) dirs.push({ dir: path.join(repoRoot, '.eklavya', 'packs'), scope: 'repo' });
  return dirs;
}

function listPackFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    // A missing packs directory is the normal case, not an error.
    return [];
  }
}

/**
 * Reads every pack, and never throws.
 *
 * A malformed pack must not take the database down with it: `openDb()` is on
 * the path of every CLI command and the server's own start, so one bad file in
 * `~/.eklavya/packs/` would otherwise make Eklavya unusable rather than making
 * one pack unavailable. The error is carried on the result instead, and
 * `eklavya doctor` is where a learner reads it.
 */
export function loadPacks(cwd: string = process.cwd()): LoadedPack[] {
  const out: LoadedPack[] = [];
  for (const { dir, scope } of packDirs(cwd)) {
    for (const file of listPackFiles(dir)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Pack;
        if (typeof parsed.pack !== 'string' || !parsed.pack) {
          throw new Error('missing "pack" — a pack has to say who it is, as a string');
        }
        // Edges may leave the file, unlike a seed graph's: a pack extending a
        // shipped domain wants `prerequisite_of` pointing at a seeded concept.
        // An endpoint naming nothing is dropped at apply time and counted, so a
        // typo is visible in `doctor` rather than failing the whole pack.
        validateSeedGraph(parsed, path.basename(file), { allowExternalEdges: true });
        out.push({ file, scope, pack: parsed });
      } catch (err) {
        out.push({ file, scope, error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  return out;
}

/**
 * Identity of the pack set as it is on disk right now.
 *
 * Path, size and mtime rather than content: applying packs is a write, and
 * doing it on every `openDb()` would churn the WAL on every CLI invocation for
 * a set of files that changes about never. Editing a pack changes its mtime and
 * its size in almost every real case, and the one that slips through is fixed
 * by the next edit or by `eklavya doctor`, which applies unconditionally.
 */
export function packFingerprint(files: string[], seedVersion: number = SEED_VERSION): string {
  const h = crypto.createHash('sha256');
  // The seed version is part of a pack's identity, because a re-seed upserts
  // every shipped concept back to its shipped tier and undoes whatever a pack
  // had merged over it. Folding it in here means a bumped SEED_VERSION marks
  // EVERY scope stale, so each repository re-applies its own packs the next
  // time it is opened — not only the one the learner happened to be in when
  // the re-seed ran.
  h.update(`seed:${seedVersion}\n`);
  for (const file of files) {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(file);
    } catch {
      /* raced with a delete; the path alone still changes the hash */
    }
    h.update(`${file}:${stat?.size ?? -1}:${stat?.mtimeMs ?? -1}\n`);
  }
  return h.digest('hex');
}

export interface PackSummary {
  applied: number;
  concepts: number;
  edges: number;
  edgesDropped: number;
  errors: Array<{ file: string; error: string }>;
}

/** Applies every readable pack, global then repo, so the repo's wins. */
export function applyPacks(db: Database, cwd: string = process.cwd()): PackSummary {
  return applyLoaded(db, loadPacks(cwd), packDirs(cwd).map((d) => d.dir));
}

function applyLoaded(db: Database, loaded: LoadedPack[], dirs: string[]): PackSummary {
  const summary: PackSummary = { applied: 0, concepts: 0, edges: 0, edgesDropped: 0, errors: [] };

  for (const entry of loaded) {
    if (!entry.pack) {
      summary.errors.push({ file: entry.file, error: entry.error ?? 'unreadable' });
      continue;
    }
    const s = applySeedGraph(db, entry.pack, 'pack');
    summary.applied += 1;
    summary.concepts += s.concepts;
    summary.edges += s.edges;
    summary.edgesDropped += (entry.pack.edges?.length ?? 0) - s.edges;
  }

  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(packFingerprintKey(dirs), packFingerprint(loaded.map((l) => l.file)));

  return summary;
}

/**
 * Applies packs when the set on disk has changed since this scope last saw it.
 *
 * "Changed" includes a bumped `SEED_VERSION`, which is folded into the hash:
 * seeding upserts every shipped concept back to its shipped name and tier, so a
 * pack that had merged over one is undone by a re-seed and has to land again.
 * That is why there is no separate `force` — the seed version *is* part of what
 * the fingerprint is fingerprinting.
 *
 * The write on the way out matters even when nothing was applied. It is what
 * records "this scope has seen this state", and dropping it for the empty set
 * loses a pack's override for good: a re-seed that happens while the learner is
 * in some other repository would otherwise never be noticed by the repository
 * whose pack it undid.
 *
 * Removing a pack does NOT remove its concepts. `mastery` and `attempts`
 * reference them, so deleting the rows would delete the learner's history along
 * with them — the same rule that keeps seeding away from `mastery`.
 */
export function applyPacksIfNeeded(db: Database, cwd: string = process.cwd()): PackSummary | null {
  const dirs = packDirs(cwd).map((d) => d.dir);
  const loaded = loadPacks(cwd);
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(packFingerprintKey(dirs)) as
    | { value: string }
    | undefined;
  if (row?.value === packFingerprint(loaded.map((l) => l.file))) return null;
  return applyLoaded(db, loaded, dirs);
}
