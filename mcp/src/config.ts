import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalConfigPath } from './paths.js';

export type Mode = 'ambient' | 'enforced' | 'off';

export interface EklavyaConfig {
  mode: Mode;
  pass_threshold: number;
  max_questions_per_task: number;
  min_minutes_between_quizzes: number;
  domains_enabled: string[];
  quiet: boolean;
  /** Cap on LLM-minted concepts per session, against slug sprawl (PRD §15). */
  max_new_concepts_per_session: number;
}

export const DEFAULT_CONFIG: EklavyaConfig = {
  mode: 'ambient',
  pass_threshold: 0.7,
  max_questions_per_task: 4,
  min_minutes_between_quizzes: 20,
  domains_enabled: ['*'],
  quiet: false,
  max_new_concepts_per_session: 8,
};

export const REPO_CONFIG_FILE = '.eklavya.json';

export interface ResolvedConfig {
  config: EklavyaConfig;
  /** Every key present in either file, including ones Eklavya does not know about. */
  raw: Record<string, unknown>;
  globalPath: string;
  repoPath: string | null;
  repoRoot: string | null;
}

function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // A missing or malformed config must never take a session down; defaults win.
    return null;
  }
}

/**
 * Walks up from `cwd` looking for a repo-level config, stopping at the git root
 * or the filesystem root. Returns the directory holding it, plus the git root if
 * one was passed on the way (Phase 3 stamps that onto gate rows).
 */
export function findRepoConfig(cwd: string = process.cwd()): {
  repoPath: string | null;
  repoRoot: string | null;
} {
  // Resolve symlinks: `git rev-parse --show-toplevel` reports the real path, and
  // the git pre-commit hook matches gate rows on it. On macOS /tmp is a symlink
  // to /private/tmp, so without this the two sides silently never match.
  let dir = realPath(path.resolve(cwd));
  let repoPath: string | null = null;
  let repoRoot: string | null = null;

  for (;;) {
    if (!repoPath && fs.existsSync(path.join(dir, REPO_CONFIG_FILE))) {
      repoPath = path.join(dir, REPO_CONFIG_FILE);
    }
    if (!repoRoot && fs.existsSync(path.join(dir, '.git'))) {
      repoRoot = dir;
      // The git root is the boundary: a config above it belongs to another project.
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir || dir === os.homedir()) break;
    dir = parent;
  }

  return { repoPath, repoRoot };
}

function coerce(raw: Record<string, unknown>, base: EklavyaConfig): EklavyaConfig {
  const out: EklavyaConfig = { ...base };

  if (raw.mode === 'ambient' || raw.mode === 'enforced' || raw.mode === 'off') out.mode = raw.mode;
  if (typeof raw.pass_threshold === 'number' && raw.pass_threshold >= 0 && raw.pass_threshold <= 1) {
    out.pass_threshold = raw.pass_threshold;
  }
  if (typeof raw.max_questions_per_task === 'number' && raw.max_questions_per_task > 0) {
    out.max_questions_per_task = Math.floor(raw.max_questions_per_task);
  }
  if (typeof raw.min_minutes_between_quizzes === 'number' && raw.min_minutes_between_quizzes >= 0) {
    out.min_minutes_between_quizzes = Math.floor(raw.min_minutes_between_quizzes);
  }
  if (Array.isArray(raw.domains_enabled) && raw.domains_enabled.every((d) => typeof d === 'string')) {
    out.domains_enabled = raw.domains_enabled as string[];
  }
  if (typeof raw.quiet === 'boolean') out.quiet = raw.quiet;
  if (
    typeof raw.max_new_concepts_per_session === 'number' &&
    raw.max_new_concepts_per_session >= 0
  ) {
    out.max_new_concepts_per_session = Math.floor(raw.max_new_concepts_per_session);
  }

  return out;
}

/** Global config merged with the repo's, repo winning (PRD §11). */
export function loadConfig(cwd: string = process.cwd()): ResolvedConfig {
  const globalPath = globalConfigPath();
  const { repoPath, repoRoot } = findRepoConfig(cwd);

  const globalRaw = readJson(globalPath) ?? {};
  const repoRaw = repoPath ? (readJson(repoPath) ?? {}) : {};
  const raw = { ...globalRaw, ...repoRaw };

  return {
    config: coerce(raw, DEFAULT_CONFIG),
    raw,
    globalPath,
    repoPath,
    repoRoot,
  };
}

/** Writes via temp file + rename: the git hook may be reading mid-write. */
export function writeConfigFile(file: string, patch: Record<string, unknown>): Record<string, unknown> {
  const existing = readJson(file) ?? {};
  const merged = { ...existing, ...patch };

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);

  return merged;
}

export function isDomainEnabled(config: EklavyaConfig, domain: string): boolean {
  return config.domains_enabled.includes('*') || config.domains_enabled.includes(domain);
}
