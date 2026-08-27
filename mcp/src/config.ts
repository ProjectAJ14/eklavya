import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { globalConfigPath } from './paths.js';
import type { Level } from './srs.js';

export type Mode = 'ambient' | 'enforced' | 'off';

/**
 * The second dial, and deliberately not part of `Mode`.
 *
 * `mode` answers "how hard does Eklavya push?" -- it governs whether the Stop
 * hook blocks, whether commits are gated, whether the cooldown applies. `focus`
 * answers "what does it teach?". They are orthogonal: enforced+learn (an intern
 * must pass, on a topic they chose) and ambient+project (gentle, grounded in
 * today's diff) are both coherent. Folding them into one enum would make those
 * mutually exclusive for no reason, and would break every `.eklavya.json`
 * already written against 1.0.
 *
 * `off` is the one interaction: it wins outright and `focus` is never read.
 */
export type Focus = 'project' | 'concept' | 'learn';

/**
 * The third dial: *when* the questions land.
 *
 * `mode` is how hard Eklavya pushes, `focus` is what it teaches, and this is
 * when it asks. Kept separate for the same reason `focus` was: every
 * combination is coherent. ambient+interleaved is the default experience --
 * one question at the seam where a concept was logged, while the agent works --
 * and enforced+end is a team lead who wants the gate but not the interruption.
 *
 * `interleaved` does not mean "more questions". `max_questions_per_task` becomes
 * a session budget: questions answered mid-work are questions the Stop hook no
 * longer asks. A session that answered its whole budget while the agent worked
 * finishes in silence, which is the entire point -- the old behaviour spent that
 * time at the end, when the developer wanted to be done.
 *
 * `end` is the pre-1.4 behaviour, unchanged: nothing until Stop.
 */
export type Cadence = 'interleaved' | 'end';

/**
 * The fourth dial, and the only one that is normally *earned* rather than set.
 *
 * `auto` (the default) means the project's level comes from `project_levels`:
 * everyone starts at `easy` and climbs on evidence. A literal level pins it and
 * stops progression, which is a hard set rather than a floor because both real
 * uses want exactly that -- a repo pinning `easy` is an onboarding codebase that
 * should stay gentle for every contributor, and a senior pinning `hard` globally
 * has said they do not want the runway.
 *
 * Pinned or not, `attempts.level` still records the band each question was asked
 * at, so removing a pin later leaves a readable history rather than a hole.
 */
export type Difficulty = Level | 'auto';

export interface EklavyaConfig {
  mode: Mode;
  /**
   * What to teach. Defaults to `concept`: the point of Eklavya is understanding
   * that survives the current task, and a question answerable only against this
   * diff teaches the diff. `project` still exists and is the better setting when
   * onboarding someone onto a specific codebase.
   */
  focus: Focus;
  /** Required by `learn` focus; ignored by the others. */
  focus_topic: string | null;
  /**
   * When to ask. Defaults to `interleaved`: the promise is learning while your
   * coding agent works, and a question that only ever arrives after the work is
   * finished is not that.
   */
  cadence: Cadence;
  /**
   * How hard questions on a project are allowed to get. Defaults to `auto`: the
   * level is earned per project, starting at `easy`, because the first fortnight
   * has to be answerable by someone who was only *watching* the agent work.
   */
  difficulty: Difficulty;
  /** Passing answers needed at a level, in one project, before it promotes. */
  level_up_after: number;
  /**
   * Minimum accuracy over those answers. Endurance alone is not readiness: a
   * hundred answers of which sixty were wrong says the level is already too hard.
   */
  level_up_accuracy: number;
  pass_threshold: number;
  max_questions_per_task: number;
  min_minutes_between_quizzes: number;
  /**
   * Floor on the gap between mid-work checkpoint questions, in minutes. Read by
   * `checkpoint-quiz.sh`, not by the planner.
   *
   * Much shorter than `min_minutes_between_quizzes` on purpose: that one paces
   * whole quizzes and exists so Eklavya does not nag, this one paces single
   * questions and exists so a batch of eight logged concepts does not become
   * eight questions back to back. Set it to 0 to ask at every seam.
   */
  min_minutes_between_checkpoints: number;
  domains_enabled: string[];
  quiet: boolean;
  /** Cap on LLM-minted concepts per session, against slug sprawl (PRD §15). */
  max_new_concepts_per_session: number;
  /** Hard backstop on the Stop hook's loop guard, read by stop-quiz-check.sh. */
  max_stop_blocks_per_session: number;
}

export const DEFAULT_CONFIG: EklavyaConfig = {
  mode: 'ambient',
  focus: 'concept',
  focus_topic: null,
  cadence: 'interleaved',
  difficulty: 'auto',
  level_up_after: 100,
  level_up_accuracy: 0.7,
  pass_threshold: 0.7,
  max_questions_per_task: 4,
  min_minutes_between_quizzes: 20,
  min_minutes_between_checkpoints: 4,
  domains_enabled: ['*'],
  quiet: false,
  max_new_concepts_per_session: 8,
  max_stop_blocks_per_session: 3,
};

export const REPO_CONFIG_FILE = '.eklavya.json';

export interface ResolvedConfig {
  config: EklavyaConfig;
  /** Every key present in either file, including ones Eklavya does not know about. */
  raw: Record<string, unknown>;
  globalPath: string;
  repoPath: string | null;
  repoRoot: string | null;
  /**
   * Keys the repo config set to something the global config had set differently.
   *
   * Repo-wins is right -- it is how a lead pins enforced mode on one codebase --
   * but silence about it is not. A repo pinning `focus: project` switches off a
   * `learn` topic someone set for themselves, and without this they have no way
   * to know why their own setting stopped applying.
   */
  overrides: string[];
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
  if (raw.focus === 'project' || raw.focus === 'concept' || raw.focus === 'learn') out.focus = raw.focus;
  if (raw.cadence === 'interleaved' || raw.cadence === 'end') out.cadence = raw.cadence;
  if (
    raw.difficulty === 'auto' ||
    raw.difficulty === 'easy' ||
    raw.difficulty === 'medium' ||
    raw.difficulty === 'hard'
  ) {
    out.difficulty = raw.difficulty;
  }
  if (typeof raw.level_up_after === 'number' && raw.level_up_after > 0) {
    out.level_up_after = Math.floor(raw.level_up_after);
  }
  if (
    typeof raw.level_up_accuracy === 'number' &&
    raw.level_up_accuracy >= 0 &&
    raw.level_up_accuracy <= 1
  ) {
    out.level_up_accuracy = raw.level_up_accuracy;
  }
  if (typeof raw.focus_topic === 'string' && raw.focus_topic.trim()) {
    out.focus_topic = raw.focus_topic.trim();
  } else if (raw.focus_topic === null) {
    out.focus_topic = null;
  }
  if (typeof raw.pass_threshold === 'number' && raw.pass_threshold >= 0 && raw.pass_threshold <= 1) {
    out.pass_threshold = raw.pass_threshold;
  }
  if (typeof raw.max_questions_per_task === 'number' && raw.max_questions_per_task > 0) {
    out.max_questions_per_task = Math.floor(raw.max_questions_per_task);
  }
  if (typeof raw.min_minutes_between_quizzes === 'number' && raw.min_minutes_between_quizzes >= 0) {
    out.min_minutes_between_quizzes = Math.floor(raw.min_minutes_between_quizzes);
  }
  if (
    typeof raw.min_minutes_between_checkpoints === 'number' &&
    raw.min_minutes_between_checkpoints >= 0
  ) {
    out.min_minutes_between_checkpoints = Math.floor(raw.min_minutes_between_checkpoints);
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
  if (
    typeof raw.max_stop_blocks_per_session === 'number' &&
    raw.max_stop_blocks_per_session >= 0
  ) {
    out.max_stop_blocks_per_session = Math.floor(raw.max_stop_blocks_per_session);
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

  const overrides = Object.keys(repoRaw).filter(
    (key) =>
      key in globalRaw && JSON.stringify(globalRaw[key]) !== JSON.stringify(repoRaw[key]),
  );

  return {
    config: coerce(raw, DEFAULT_CONFIG),
    raw,
    globalPath,
    repoPath,
    repoRoot,
    overrides,
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
