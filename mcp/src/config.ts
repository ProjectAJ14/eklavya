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
 * It is also the batch size. Under `interleaved` a plan is one question -- the
 * planner caps it, so "one at a time" is a property of the data rather than an
 * instruction the tutor has to remember -- and the Stop sweep asks one too.
 * Concepts the budget never reaches are not lost: they stay unmastered and
 * resurface as review in a later session. Enforced mode is the exception, for the
 * reason it is exempt from the cooldown: the gate has to stay passable.
 *
 * `end` is the pre-1.4 behaviour, unchanged: nothing until Stop, then a batch of
 * whatever the budget has left.
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

/**
 * The memory namespace (PRD CFG-01).
 *
 * Nested, unlike the learning dials, which stay flat because every
 * `.eklavya.json` already written uses them at the top level. New settings get
 * namespaces; old ones keep their names. The compatibility adapter is simply
 * that `coerce` reads both shapes.
 *
 * `enabled` is deliberately independent of `mode`. Someone who set
 * `mode: "off"` asked for no quizzes, not for their project history to stop
 * being recorded -- and the reverse, a learner who wants quizzes but no
 * capture, is just as legitimate.
 */
export interface MemoryConfig {
  enabled: boolean;
  /**
   * What the capture path accepts. `minimal` keeps prompts and session seams --
   * enough for "what was I doing last week" -- without recording every read.
   */
  capture: 'full' | 'minimal' | 'off';
  /** Events per observation batch; the seam flushes whatever is left. */
  batch_max_events: number;
  /** Days of raw evidence to keep. `null` keeps it until deleted by hand. */
  retention_days: number | null;
}

/** What never reaches storage, a log, a provider, an embedding or an export. */
export interface PrivacyConfig {
  exclude_paths: string[];
  exclude_tools: string[];
  /** Extra regex sources, applied on top of the built-in secret shapes. */
  redact_patterns: string[];
}

export interface RetrievalConfig {
  mode: 'keyword' | 'semantic' | 'hybrid';
  /** Entries offered at a session seam before any detail fetch. */
  max_items: number;
  /** Budget for the whole injected block, estimated tokens. */
  max_tokens: number;
  /** Off by default: another repository's work is noise, not context. */
  cross_project: boolean;
}

/**
 * Outbound model access, and the reason it is its own namespace: every key here
 * is a decision to send this machine's work somewhere else. Both default to
 * `null`, so an upgrade cannot turn a local install into a networked one
 * (PRD CFG-02) -- the local summariser and the local embedder handle both jobs
 * until someone configures otherwise.
 */
export interface ProviderConfig {
  kind: 'anthropic';
  model: string;
  /** Environment variable holding the key. Never the key itself. */
  api_key_env: string;
}

export interface ProvidersConfig {
  observer: ProviderConfig | null;
  embeddings: ProviderConfig | null;
}

/**
 * Outbound wrap-ups and alerts (PRD EXT-01, CFG-02).
 *
 * Off by default and separately from everything else, because every sink here
 * sends this machine's work somewhere it cannot be recalled from. A session
 * summary posted to a team channel is a session summary that team has, whatever
 * the developer does with their database afterwards -- so enabling one is an
 * explicit decision, and the manual says what leaves.
 *
 * `command` exists because the interesting integrations are all somebody's
 * script: a desktop notification, a note in a journal, a message posted by a
 * CLI that already holds the credentials. A webhook URL in a config file does
 * not hold credentials, which is the other half of why this shape was chosen.
 */
export interface NotificationSink {
  kind: 'webhook' | 'command' | 'file';
  /** `webhook`: the URL. `command`: the executable. `file`: the path. */
  target: string;
  /** `command` only. The event JSON arrives on stdin regardless. */
  args?: string[];
  /** Which events this sink wants. Empty means all of them. */
  events?: string[];
}

export interface NotificationsConfig {
  enabled: boolean;
  sinks: NotificationSink[];
}

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
   * the checkpoint-quiz hook, not by the planner.
   *
   * Much shorter than `min_minutes_between_quizzes` on purpose: that one paces
   * whole quizzes and exists so Eklavya does not nag, this one paces single
   * questions and exists so a batch of eight logged concepts does not become
   * eight questions back to back. Set it to 0 to ask at every seam.
   */
  min_minutes_between_checkpoints: number;
  domains_enabled: string[];
  quiet: boolean;
  /** Cap on LLM-minted concepts per session, against slug sprawl. */
  max_new_concepts_per_session: number;
  /** Hard backstop on the Stop hook's loop guard, read by the stop-quiz-check hook. */
  max_stop_blocks_per_session: number;
  memory: MemoryConfig;
  privacy: PrivacyConfig;
  retrieval: RetrievalConfig;
  providers: ProvidersConfig;
  notifications: NotificationsConfig;
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
  memory: {
    enabled: true,
    capture: 'full',
    batch_max_events: 40,
    retention_days: null,
  },
  privacy: {
    exclude_paths: [],
    exclude_tools: [],
    redact_patterns: [],
  },
  retrieval: {
    mode: 'hybrid',
    max_items: 6,
    max_tokens: 1200,
    cross_project: false,
  },
  providers: {
    observer: null,
    embeddings: null,
  },
  notifications: {
    enabled: false,
    sinks: [],
  },
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

/**
 * The main checkout behind a git worktree, or the path unchanged.
 *
 * A linked worktree's `.git` is a file reading `gitdir: <main>/.git/worktrees/<name>`,
 * so `findRepoConfig` stops there and reports the worktree as the git root. That
 * is right for finding `.eklavya.json` -- the worktree has its own checkout of it
 * -- and wrong for identity: a branch parked in a worktree is the same codebase,
 * and keying a project on the worktree path mints a fresh project, at `easy`,
 * every time someone starts a branch.
 */
export function mainRepoRoot(repoRoot: string): string {
  try {
    const dotGit = path.join(repoRoot, '.git');
    if (!fs.statSync(dotGit).isFile()) return repoRoot;
    const gitdir = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!gitdir) return repoRoot;
    // Git writes this absolute by default and relative under `--relative-paths`.
    const resolved = path.resolve(repoRoot, gitdir[1]!.trim());
    const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
    const cut = resolved.indexOf(marker);
    // Only the ordinary `<root>/.git/worktrees/<name>` layout resolves by path.
    // A bare repo has no main checkout to fold into, and a `--separate-git-dir`
    // or submodule git dir does not say where its main checkout is -- those keep
    // their own key, which is what they had before any of this existed. Asking
    // `git rev-parse --git-common-dir` would cover them, at a process spawn per
    // call on the SessionStart path and per project row on the dashboard.
    return cut === -1 ? repoRoot : realPath(resolved.slice(0, cut));
  } catch {
    // A deleted or unreadable worktree keeps whatever key it already had.
    return repoRoot;
  }
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

  coerceNamespaces(raw, out);

  return out;
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null;
}

function sinkOf(value: unknown): NotificationSink | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'webhook' && v.kind !== 'command' && v.kind !== 'file') return null;
  if (typeof v.target !== 'string' || !v.target.trim()) return null;
  return {
    kind: v.kind,
    target: v.target.trim(),
    args: stringArray(v.args) ?? undefined,
    events: stringArray(v.events) ?? undefined,
  };
}

function provider(value: unknown): ProviderConfig | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.kind !== 'anthropic') return null;
  if (typeof v.model !== 'string' || !v.model.trim()) return null;
  // A key in the config file would end up in every export, log and dashboard
  // payload that ever prints configuration (PRD SEC-01). Only the name of the
  // variable holding it lives here.
  const keyEnv = typeof v.api_key_env === 'string' && v.api_key_env.trim() ? v.api_key_env.trim() : 'ANTHROPIC_API_KEY';
  return { kind: 'anthropic', model: v.model.trim(), api_key_env: keyEnv };
}

/**
 * The namespaced half. Unknown keys are left alone rather than dropped: the
 * resolved `raw` still carries them, so `eklavya doctor` can report a typo
 * instead of the setting silently doing nothing.
 */
function coerceNamespaces(raw: Record<string, unknown>, out: EklavyaConfig): void {
  const memory = raw.memory as Record<string, unknown> | undefined;
  if (memory && typeof memory === 'object') {
    out.memory = { ...out.memory };
    if (typeof memory.enabled === 'boolean') out.memory.enabled = memory.enabled;
    if (memory.capture === 'full' || memory.capture === 'minimal' || memory.capture === 'off') {
      out.memory.capture = memory.capture;
    }
    if (typeof memory.batch_max_events === 'number' && memory.batch_max_events > 0) {
      out.memory.batch_max_events = Math.floor(memory.batch_max_events);
    }
    if (typeof memory.retention_days === 'number' && memory.retention_days > 0) {
      out.memory.retention_days = Math.floor(memory.retention_days);
    } else if (memory.retention_days === null) {
      out.memory.retention_days = null;
    }
  }

  const privacy = raw.privacy as Record<string, unknown> | undefined;
  if (privacy && typeof privacy === 'object') {
    out.privacy = { ...out.privacy };
    const paths = stringArray(privacy.exclude_paths);
    if (paths) out.privacy.exclude_paths = paths;
    const tools = stringArray(privacy.exclude_tools);
    if (tools) out.privacy.exclude_tools = tools;
    const patterns = stringArray(privacy.redact_patterns);
    if (patterns) out.privacy.redact_patterns = patterns;
  }

  const retrieval = raw.retrieval as Record<string, unknown> | undefined;
  if (retrieval && typeof retrieval === 'object') {
    out.retrieval = { ...out.retrieval };
    if (retrieval.mode === 'keyword' || retrieval.mode === 'semantic' || retrieval.mode === 'hybrid') {
      out.retrieval.mode = retrieval.mode;
    }
    if (typeof retrieval.max_items === 'number' && retrieval.max_items > 0) {
      out.retrieval.max_items = Math.floor(retrieval.max_items);
    }
    if (typeof retrieval.max_tokens === 'number' && retrieval.max_tokens > 0) {
      out.retrieval.max_tokens = Math.floor(retrieval.max_tokens);
    }
    if (typeof retrieval.cross_project === 'boolean') out.retrieval.cross_project = retrieval.cross_project;
  }

  const notifications = raw.notifications as Record<string, unknown> | undefined;
  if (notifications && typeof notifications === 'object') {
    out.notifications = { ...out.notifications };
    if (typeof notifications.enabled === 'boolean') out.notifications.enabled = notifications.enabled;
    if (Array.isArray(notifications.sinks)) {
      out.notifications.sinks = notifications.sinks.flatMap((entry) => {
        const sink = sinkOf(entry);
        return sink ? [sink] : [];
      });
    }
  }

  const providers = raw.providers as Record<string, unknown> | undefined;
  if (providers && typeof providers === 'object') {
    out.providers = {
      observer: provider(providers.observer),
      embeddings: provider(providers.embeddings),
    };
  }
}

/** Global config merged with the repo's, repo winning. */
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
