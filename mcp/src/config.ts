import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eklavyaHome, ensureEklavyaHome, globalConfigPath, projectConfigPath } from './paths.js';
import { readJsonForUpdate, readJsonStrict, writeJsonWithBackup } from './safe-write.js';
import type { Level } from './srs.js';

/**
 * The quiz half of Eklavya, and nothing else.
 *
 * This replaced the `mode` dial (`ambient` | `enforced` | `off`), which read as
 * a master switch for the product and was not one. `mode: off` meant "no
 * questions"; it never meant "stop recording my work" -- but nobody could tell
 * that from the word, so a developer who wanted quiet read it as *Eklavya is
 * off* and then reasonably concluded the plugin was broken when a session went
 * silent. A dial whose name has to be corrected by a paragraph of documentation
 * is the wrong dial.
 *
 * So the two decisions `mode` was carrying now say their own names, next to the
 * `memory.enabled` that was already independent of both:
 *
 *   quiz.enabled    do questions happen at all
 *   quiz.enforced   does the commit gate hold, and is quizzing insistent
 *   memory.enabled  is the work recorded and recalled
 *
 * They are *not* fully independent, which is the one thing a flag pair hides
 * and an enum did not: `enabled: false` with `enforced: true` is a gate
 * demanding passes for questions that are never asked -- an unopenable door.
 * `coerceNamespaces` resolves it rather than letting it reach the gate; see
 * there for which way it falls and why.
 *
 * Every config already written against `mode` keeps working:
 * `normalizeLegacyKeys` rewrites it, forever.
 */
export interface QuizConfig {
  enabled: boolean;
  /**
   * The commit gate, plus the insistence that makes it passable.
   *
   * It is one flag rather than two because the gate is unshippable without the
   * rest: `get_session_quiz_plan` exempts it from the cooldown, refuses to pad
   * a plan with weaker picks, overrides an `interleaved` cadence and guarantees
   * at least one question -- all so that a commit being held is always a commit
   * the developer has been *given a way through*. A `gate.enabled` that did not
   * carry those would block commits behind questions the planner had already
   * decided not to ask.
   */
  enforced: boolean;
}

/**
 * The dial for *what* is taught, deliberately separate from whether and how
 * hard.
 *
 * `quiz.enforced` governs whether the Stop hook blocks, whether commits are
 * gated, whether the cooldown applies. `focus` answers "what does it teach?".
 * They are orthogonal: enforced+learn (an intern studies a topic they chose,
 * and passes a gate on the day's work first) and gentle+project (grounded in
 * today's diff) are both coherent.
 * Folding them into one enum would make those mutually exclusive for no reason.
 *
 * `quiz.enabled: false` is the one interaction: it wins outright and `focus` is
 * never read.
 */
export type Focus = 'project' | 'concept' | 'learn';

/**
 * The third dial: *when* the questions land.
 *
 * `quiz.enforced` is how hard Eklavya pushes, `focus` is what it teaches, and
 * this is when it asks. Kept separate for the same reason `focus` was: every
 * combination is coherent. unenforced+interleaved is the default experience --
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
 * resurface as review in a later session. Enforced quizzing is the exception, for the
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
 * config already written uses them at the top level. New settings get
 * namespaces; old ones keep their names -- `quiz` is the one exception, and it
 * carries `normalizeLegacyKeys` to pay for itself.
 *
 * `enabled` is deliberately independent of `quiz.enabled`. Someone who silenced
 * the questions asked for no quizzes, not for their project history to stop
 * being recorded -- and the reverse, a learner who wants quizzes but no
 * capture, is just as legitimate. This was always true; it used to be true of
 * the `mode` dial and invisible, which is why that dial is now `quiz`.
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
  /** Run through Claude Code on the developer's subscription, never an API key. */
  model: string;
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

/**
 * Multi-device sync (ADR-09). A shared directory, not a server.
 *
 * Off by default with no target, and both are load-bearing rather than
 * cautious: `enabled` alone does nothing, because a sync with nowhere to write
 * is a silent no-op that looks like a broken feature, and a target alone does
 * nothing, because a path left in a config file from a machine that has since
 * been wiped must not start publishing this one's memory. Turning it on is two
 * explicit decisions, and what crosses is memory only -- never attempts,
 * mastery, gates or receipts (PRD SEC-02).
 */
export interface SyncConfig {
  enabled: boolean;
  /** A folder both devices can see: Dropbox, iCloud, Syncthing, a mounted share. */
  target: string | null;
  /**
   * Normally `null`, and normally left that way.
   *
   * The real device id is generated once and kept in the `meta` table of
   * `knowledge.db`, because that file is per-install while config files travel:
   * `~/.eklavya/config.json` is exactly the sort of thing a dotfile manager
   * copies to the second machine. Two devices sharing an id would interleave one revision stream and
   * each would treat the other's writes as its own -- so the identity lives
   * where an import is already forbidden to copy it (PRD MIG-01). This key
   * exists to pin it deliberately, which is what tests and a restored backup
   * want.
   */
  device_id: string | null;
}

export interface EklavyaConfig {
  /**
   * Whether questions happen, and whether they are enforced. Replaced the
   * `mode` dial; see `QuizConfig` for why, and `coerce` for the alias that
   * keeps every config written against `mode` working.
   */
  quiz: QuizConfig;
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
  /**
   * Whether Eklavya updates itself: a background check at session start, at
   * most hourly, that installs a newer release into `~/.eklavya/runtime` and
   * re-runs `eklavya install --auto` (see `update.ts`). On by default, like
   * Claude Code's own updater — an install nobody has to remember is the point.
   * Global only: the runtime is the machine's, not one project's. Off still
   * leaves `eklavya update` working by hand.
   */
  auto_update: boolean;
  /** Cap on LLM-minted concepts per session, against slug sprawl. */
  max_new_concepts_per_session: number;
  /** Hard backstop on the Stop hook's loop guard, read by the stop-quiz-check hook. */
  max_stop_blocks_per_session: number;
  memory: MemoryConfig;
  privacy: PrivacyConfig;
  retrieval: RetrievalConfig;
  providers: ProvidersConfig;
  notifications: NotificationsConfig;
  sync: SyncConfig;
}

export const DEFAULT_CONFIG: EklavyaConfig = {
  quiz: { enabled: true, enforced: false },
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
  auto_update: true,
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
  sync: {
    enabled: false,
    target: null,
    device_id: null,
  },
};

/**
 * The file Eklavya used to keep inside the checkout, and no longer does.
 *
 * Still named here for one reason: `migrateLegacyRepoConfig` has to recognise
 * it, lift it out and delete it. Nothing reads it as configuration any more.
 */
export const LEGACY_REPO_CONFIG_FILE = '.eklavya.json';

export interface ResolvedConfig {
  config: EklavyaConfig;
  /** Every key present in either file, including ones Eklavya does not know about. */
  raw: Record<string, unknown>;
  globalPath: string;
  /** `~/.eklavya/projects/<slug>/config.json`, or null outside a checkout. */
  projectPath: string | null;
  repoRoot: string | null;
  /**
   * Keys the project config set to something the global config had set
   * differently.
   *
   * Project-wins is right -- it is how you teach yourself differently in a
   * codebase you are new to -- but silence about it is not. A project pinning
   * `focus: project` switches off a `learn` topic you set for yourself, and
   * without this there is no way to know why your own setting stopped applying.
   */
  overrides: string[];
  /**
   * Keys this project's file sets that only the global file may set, and that
   * were therefore not applied. See `GLOBAL_ONLY_KEYS`. Said out loud for the
   * same reason as `overrides`: a setting in a file you wrote that silently
   * does nothing is a bug report waiting to happen.
   */
  ignored: string[];
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
 * Walks up from `cwd` to the git root, which is the only thing a checkout still
 * tells us: settings themselves live outside it, under `~/.eklavya/projects/`.
 *
 * Keeps its name because it is on the call path of every hook, the packs loader
 * and the session pointer, and because "find the repo this config belongs to"
 * is still exactly what it does.
 */
export function findRepoConfig(cwd: string = process.cwd()): {
  repoRoot: string | null;
} {
  // Resolve symlinks: `git rev-parse --show-toplevel` reports the real path, and
  // the git pre-commit hook matches gate rows on it. On macOS /tmp is a symlink
  // to /private/tmp, so without this the two sides silently never match.
  let dir = realPath(path.resolve(cwd));

  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return { repoRoot: dir };
    const parent = path.dirname(dir);
    if (parent === dir || dir === os.homedir()) return { repoRoot: null };
    dir = parent;
  }
}

/**
 * The main checkout behind a git worktree, or the path unchanged.
 *
 * A linked worktree's `.git` is a file reading `gitdir: <main>/.git/worktrees/<name>`,
 * so `findRepoConfig` stops there and reports the worktree as the git root. That
 * is right for finding the checkout you are standing in, and wrong for
 * identity: a branch parked in a worktree is the same codebase,
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
  if (typeof raw.auto_update === 'boolean') out.auto_update = raw.auto_update;
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
  // An `api_key_env` left by an older version is ignored: the model runs on
  // the subscription, so there is no key to name.
  return { kind: 'anthropic', model: v.model.trim() };
}

/**
 * The namespaced half. Unknown keys are left alone rather than dropped: the
 * resolved `raw` still carries them, so `eklavya doctor` can report a typo
 * instead of the setting silently doing nothing.
 */
function coerceNamespaces(raw: Record<string, unknown>, out: EklavyaConfig): void {
  const quiz = raw.quiz as Record<string, unknown> | undefined;
  if (quiz && typeof quiz === 'object') {
    out.quiz = { ...out.quiz };
    if (typeof quiz.enabled === 'boolean') out.quiz.enabled = quiz.enabled;
    if (typeof quiz.enforced === 'boolean') out.quiz.enforced = quiz.enforced;
  }
  // The one combination the flag pair can express and the old enum could not:
  // a gate holding commits until questions are passed, with the questions
  // switched off. Nothing would ever ask, so nothing would ever pass, and the
  // developer would be locked out of `git commit` in their own repository with
  // no message explaining which setting did it.
  //
  // `enabled` wins. The alternative -- honouring `enforced` by turning
  // questions back on -- overrides an explicit request for silence in order to
  // start interrupting someone, which is the worse way to be wrong. It also
  // fails safe: the cost here is a gate that does not hold, and `eklavya doctor`
  // reports the contradiction rather than leaving it to be discovered at the
  // first blocked commit.
  if (!out.quiz.enabled) out.quiz.enforced = false;

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

  const sync = raw.sync as Record<string, unknown> | undefined;
  if (sync && typeof sync === 'object') {
    out.sync = { ...out.sync };
    if (typeof sync.enabled === 'boolean') out.sync.enabled = sync.enabled;
    if (typeof sync.target === 'string' && sync.target.trim()) {
      out.sync.target = sync.target.trim();
    } else if (sync.target === null) {
      out.sync.target = null;
    }
    if (typeof sync.device_id === 'string' && sync.device_id.trim()) {
      out.sync.device_id = sync.device_id.trim();
    } else if (sync.device_id === null) {
      out.sync.device_id = null;
    }
  }
}

/**
 * Keys a file that arrived by `git clone` may not set, ever.
 *
 * `REPO_FORBIDDEN_KEYS` was deleted with the committed settings file, on the
 * reasoning that nothing arrives from a stranger any more. That is true of
 * `~/.eklavya/projects/`, and **not** true of the one path that still reads a
 * checkout: a repository shipping a legacy `.eklavya.json` is still handing
 * this machine a configuration file somebody else wrote, right up until a
 * session moves it. Without this the removal reintroduced the exact RCE the old
 * list existed to stop — a `command` notification sink of `/bin/sh -c ...`,
 * fired by the Stop hook's automatic wrap-up, on `git clone` plus ten minutes —
 * and `migrateLegacyRepoConfig` then laundered it into the trusted location, so
 * it survived the file being deleted.
 *
 * Each one has an effect *outside* the session: `notifications` runs a command
 * or posts somewhere, `sync` writes files, `providers` sends this machine's
 * work to an API, and `retrieval.cross_project` widens what the model sees. A
 * dial is safe to inherit from a stranger; these are not.
 */
const CLONED_FORBIDDEN = ['notifications', 'sync', 'providers'] as const;

/**
 * Keys only `~/.eklavya/config.json` may set -- a project file that sets them
 * is read, reported in `ignored`, and not applied.
 *
 * `providers` decides whether work leaves this machine, and the work it acts on
 * is not one project's. The memory queue is machine-wide and the one worker
 * drains every project's jobs with the config it was started under, so a
 * project-level `providers.observer` would decide whether some *other*
 * project's sessions are sent to a model. That is a decision about the machine,
 * made once, in the machine's file. `auto_update` for the same reason: there
 * is one runtime per machine, and a project that turned it off would stop
 * updates for every other project too.
 */
const GLOBAL_ONLY_KEYS = ['providers', 'auto_update'] as const;

/** True for a global-only namespace or any dotted key under it (`providers.observer`). */
export function isGlobalOnlyKey(key: string): boolean {
  return GLOBAL_ONLY_KEYS.some((k) => key === k || key.startsWith(`${k}.`));
}

/**
 * The same filter, applied to anything read out of a checkout. Dropped in
 * silence rather than reported: the file is on its way to being deleted, and
 * there is no setting to explain because it never applied.
 */
function withoutUntrustedKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((CLONED_FORBIDDEN as readonly string[]).includes(key)) continue;
    if (key === 'retrieval' && value && typeof value === 'object' && !Array.isArray(value)) {
      // One key of this namespace is the dangerous one; the rest of it is an
      // ordinary preference, so the namespace is trimmed rather than dropped.
      const { cross_project: _crossProject, ...rest } = value as Record<string, unknown>;
      out[key] = rest;
      continue;
    }
    out[key] = value;
  }
  return out;
}

/**
 * A `<repo>/.eklavya.json` lifted out of the checkout, then deleted.
 *
 * Silent and automatic, by decision: a settings file in a repository was a
 * mistake to be undone, not a choice to be confirmed every session. Prompting
 * would put the mistake on screen once per project per developer for ever.
 *
 * **The two roots differ in a linked worktree**, and both matter. `.eklavya.json`
 * was a *committed* file, so a worktree has its own checked-out copy of it: the
 * file to delete is the one in the checkout you are standing in, while the
 * settings belong to the main checkout's key, since a worktree is a branch of
 * the same codebase rather than a project to configure again. Reading from the
 * main root instead left every worktree's copy sitting in its working tree for
 * ever — the file the whole change exists to remove.
 *
 * **It is never called from `loadConfig`.** That was the first shape and it was
 * wrong: `loadConfig` runs from every hook, every tool call and the statusline
 * on every prompt render, so putting a write behind it made a read function
 * mutate the filesystem from a dozen call sites that had no business doing so.
 * The test suite found it the honest way -- a run scattered thirty directories
 * through the real `~/.eklavya/projects/`, because only spawned children had
 * `EKLAVYA_HOME` pointed somewhere safe. A read that writes is a read nobody can
 * reason about.
 *
 * So it is called from the three places that are genuinely a moment of work:
 * the SessionStart hook, `eklavya doctor`, and `eklavya config`. SessionStart is
 * what makes it feel automatic -- the move happens on the next session, with
 * nothing on screen -- and `loadConfig` reads the legacy file as a fallback in
 * the meantime, so settings never stop applying in the window before it runs.
 *
 * Three properties still matter, because sessions start in parallel:
 *
 *   It never throws. A read-only checkout, a file owned by somebody else, a
 *   home directory that will not take a write -- all of them fall through to
 *   returning `false`, and the caller reads the legacy file this one time
 *   rather than losing the settings.
 *
 *   It never loses a setting. When project config already exists the legacy
 *   keys are merged *underneath* it, so the newer file still wins and nothing
 *   in the old one is dropped on the floor.
 *
 *   It is safe to lose a race. The write is temp-file-plus-rename, and the
 *   unlink tolerates a file another process already removed.
 */
export function migrateLegacyRepoConfig(
  checkoutRoot: string,
  projectRoot: string = checkoutRoot,
): boolean {
  const legacyPath = path.join(checkoutRoot, LEGACY_REPO_CONFIG_FILE);
  try {
    if (!fs.existsSync(legacyPath)) return false;
    const legacy = readJson(legacyPath);
    // Unreadable or malformed: left exactly where it is. A trailing comma in a
    // hand-edited file is still somebody's settings, and deleting it would lose
    // them for good; `loadConfig` reads it as empty, so it does no harm there.
    if (!legacy) return false;
    const target = projectConfigPath(projectRoot);
    const existing = readJson(target) ?? {};
    // Filtered on the way in. Everything under ~/.eklavya/projects/ is
    // treated as written by the developer, so copying a cloned file's keys
    // there verbatim would launder them into trust and outlive the deletion.
    // A target stamped for another checkout makes `writeConfigFile` throw, so
    // a slug collision keeps the legacy file rather than taking over the other.
    //
    // Global-only keys are left out of the patch rather than carried: a project
    // file that already holds one keeps it on disk (the write merges over what
    // is there), and `writeConfigFile` refuses a project patch that sets one.
    const patch: Record<string, unknown> = { ...withoutUntrustedKeys(legacy), ...existing, project: projectRoot };
    for (const key of GLOBAL_ONLY_KEYS) delete patch[key];
    writeConfigFile(target, patch);
    fs.rmSync(legacyPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * `mode` rewritten to the `quiz` namespace that replaced it, one file at a time.
 *
 * This stays forever. A config written against `mode` outlives the rename by
 * years, and dropping the alias would not error -- `coerce` ignores keys it does
 * not know, so the dial would silently revert to the default.
 *
 * It runs **per file, before `mergeConfigs`**, and that is the whole subtlety.
 * Resolving the alias on the merged object instead makes the two precedence
 * rules fight: within one file an explicit `quiz` should beat a `mode` left
 * lying beside it, and across files the project should beat the global whichever
 * spelling each one used. Merged first, a global `quiz` silently outranked a
 * project `mode`.
 */
function normalizeLegacyKeys(raw: Record<string, unknown>): Record<string, unknown> {
  const fromMode =
    raw.mode === 'ambient'
      ? { enabled: true, enforced: false }
      : raw.mode === 'enforced'
        ? { enabled: true, enforced: true }
        : raw.mode === 'off'
          ? { enabled: false, enforced: false }
          : null;
  if (!fromMode) return raw;

  // `mode` is dropped rather than carried along, so `overrides` compares the one
  // key that now means something and nothing downstream sees two spellings.
  const { mode: _mode, ...rest } = raw;
  const explicit = raw.quiz && typeof raw.quiz === 'object' && !Array.isArray(raw.quiz)
    ? (raw.quiz as Record<string, unknown>)
    : {};
  return { ...rest, quiz: { ...fromMode, ...explicit } };
}

/**
 * Global then repo, one level deep for the namespaces.
 *
 * A flat spread is right for the dials and wrong for the namespaces: a repo
 * setting `memory.capture` would replace the whole `memory` object and take
 * the developer's `memory.enabled` with it. One level is all the schema has,
 * so one level is all this does.
 */
function mergeConfigs(
  base: Record<string, unknown>,
  over: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = merged[key];
    const bothObjects =
      value !== null && typeof value === 'object' && !Array.isArray(value) &&
      existing !== null && typeof existing === 'object' && !Array.isArray(existing);
    merged[key] = bothObjects
      ? { ...(existing as Record<string, unknown>), ...(value as Record<string, unknown>) }
      : value;
  }
  return merged;
}

export function loadConfig(cwd: string = process.cwd()): ResolvedConfig {
  const globalPath = globalConfigPath();
  const { repoRoot } = findRepoConfig(cwd);

  // A worktree is a branch of the same codebase, not a new project to configure
  // from scratch -- the same fold `projectKey` applies to levels and mastery.
  const projectRoot = repoRoot ? mainRepoRoot(repoRoot) : null;
  const projectPath = projectRoot ? projectConfigPath(projectRoot) : null;

  // Read-only, deliberately and permanently: see `migrateLegacyRepoConfig`.
  let projectRaw: Record<string, unknown> = {};
  if (repoRoot && projectRoot && projectPath) {
    const onDisk = readJson(projectPath);
    if (onDisk && belongsTo(onDisk, projectRoot)) {
      projectRaw = onDisk;
    } else if (!onDisk) {
      // Nothing outside the checkout yet. A legacy file still sitting in the
      // repo is read until the next session moves it, so settings never stop
      // applying in the window before the migration runs. A file that *is*
      // there but belongs to another checkout falls through to global instead:
      // that is a slug collision, and the legacy file is not the answer to it.
      // From the checkout you are standing in: in a worktree that is where the
      // committed copy actually is, and the main root may already be migrated.
      //
      // Filtered, because this is the one path left that reads a file which may
      // have arrived by `git clone`. It applies for exactly as long as it takes
      // a session to move the file, and that window is long enough to run a
      // notification sink.
      projectRaw = withoutUntrustedKeys(
        readJson(path.join(repoRoot, LEGACY_REPO_CONFIG_FILE)) ?? {},
      );
    }
  }

  const globalRaw = normalizeLegacyKeys(readJson(globalPath) ?? {});
  const ignored = GLOBAL_ONLY_KEYS.filter((key) => key in projectRaw);
  const projectNormalized = normalizeLegacyKeys(withoutBookkeeping(withoutGlobalOnly(projectRaw)));
  const raw = mergeConfigs(globalRaw, projectNormalized);

  const overrides = Object.keys(projectNormalized).filter(
    (key) =>
      key in globalRaw &&
      JSON.stringify(globalRaw[key]) !== JSON.stringify(projectNormalized[key]),
  );

  return {
    config: coerce(raw, DEFAULT_CONFIG),
    raw,
    globalPath,
    projectPath,
    repoRoot,
    overrides,
    ignored,
  };
}

function withoutGlobalOnly(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  for (const key of GLOBAL_ONLY_KEYS) delete out[key];
  return out;
}

/**
 * What is wrong with the config files in force here, or null if nothing is.
 *
 * `loadConfig` reads a file it cannot parse as empty, deliberately: it runs in
 * every hook, and a trailing comma must not take a session down. But that
 * leaves the developer's settings silently not applying, so this is the other
 * half -- the question `eklavya doctor` asks so the fallback is visible. It
 * checks the global file and this checkout's project file; a missing or empty
 * file is not a problem.
 */
export function configFileProblem(cwd: string = process.cwd()): string | null {
  const files = [globalConfigPath()];
  const { repoRoot } = findRepoConfig(cwd);
  if (repoRoot) files.push(projectConfigPath(mainRepoRoot(repoRoot)));

  const problems: string[] = [];
  for (const file of files) {
    const read = readJsonStrict(file);
    if (read.kind === 'invalid') {
      problems.push(`${file} is not valid JSON (${read.error}); its settings are not being applied`);
    }
  }
  return problems.length ? `${problems.join('. ')}. Fix or remove the file.` : null;
}

/**
 * Whether a project config file is about the checkout we are asking about.
 *
 * `projectSlug` folds `/` and `-` together, so `/a/b-c` and `/a-b/c` land in
 * one directory. The slug stays readable -- that is what it is for -- and this
 * catches the collision instead: a file that names a different checkout is not
 * this project's configuration, so it is ignored rather than applied to the
 * wrong repository. A file written before `project` was recorded has nothing to
 * disagree with and is trusted, which is what makes the field safe to add.
 */
function belongsTo(raw: Record<string, unknown>, repoRoot: string): boolean {
  return typeof raw.project !== 'string' || raw.project === repoRoot;
}

/** `project` is bookkeeping for `belongsTo`, never a setting. */
function withoutBookkeeping(raw: Record<string, unknown>): Record<string, unknown> {
  if (!('project' in raw)) return raw;
  const { project: _project, ...rest } = raw;
  return rest;
}

/** The global file alone, coerced: what `eklavya install` shows and writes. */
export function loadGlobalConfig(): EklavyaConfig {
  return coerce(normalizeLegacyKeys(readJson(globalConfigPath()) ?? {}), DEFAULT_CONFIG);
}

/** One config file's raw contents, or `{}`. Exported so a caller building a
 *  patch can merge against what is actually in the file it is about to write. */
export function readConfigFile(file: string): Record<string, unknown> {
  return readJson(file) ?? {};
}

/**
 * Writes via temp file + rename (the git hook may be reading mid-write), after
 * copying the previous bytes to `<file>.eklavya-bak`. Refuses a file that exists
 * but does not parse, rather than replacing it.
 *
 * Refuses a patch stamped for one checkout onto a file stamped for another.
 * That is a slug collision (see `belongsTo`), and merging would hand the other
 * checkout's settings to this one while that checkout silently stopped reading
 * its own file. Every project write routes through here, so this is the one
 * place the collision is caught on the way in.
 */
export function writeConfigFile(file: string, patch: Record<string, unknown>): Record<string, unknown> {
  // A file that exists and does not parse is somebody's settings with a typo
  // in them. Reading it as `{}` and writing the patch over it deleted every
  // other setting; this throws `UnreadableFileError` instead, naming the file.
  const existing = readJsonForUpdate(file);
  // `project` marks a project file (see `belongsTo`); only the global file may
  // set a global-only key.
  const refused = typeof patch.project === 'string' ? Object.keys(patch).filter(isGlobalOnlyKey) : [];
  if (refused.length) {
    throw new Error(
      `${refused.join(', ')} can only be set in the global config (${globalConfigPath()}), not for one project: ` +
        'the memory queue is shared by every project, so this decides what leaves the machine for all of them.',
    );
  }
  if (typeof patch.project === 'string' && !belongsTo(existing, patch.project)) {
    throw new Error(
      `${file} already holds the settings for ${String(existing.project)}, a different checkout whose ` +
        `path folds to the same directory name. Not overwriting it.`,
    );
  }
  let merged: Record<string, unknown> = { ...existing, ...patch };

  // A `quiz` written today retires a `mode` left beside it, folded in rather
  // than dropped. Left in place, `mode: enforced` under a new `quiz.enabled:
  // false` resolves to enforced-and-silent, which `doctor` then reports as a
  // contradiction the developer never wrote. An explicit "off" also switches
  // off the enforcement that only the retired dial implied.
  if ('quiz' in patch && 'mode' in merged) {
    const explicit = (merged.quiz ?? {}) as Record<string, unknown>;
    merged = normalizeLegacyKeys(merged);
    if (explicit.enabled === false && explicit.enforced === undefined) {
      merged.quiz = { ...(merged.quiz as Record<string, unknown>), enforced: false };
    }
    delete merged.mode;
  }

  // Under ~/.eklavya, so that directory is created (or tightened to) 0700
  // first; the file itself is 0600, backup included. `writeJsonWithBackup` is
  // temp-file-plus-rename, because the git hook may be reading mid-write.
  if (path.resolve(file).startsWith(path.resolve(eklavyaHome()) + path.sep)) ensureEklavyaHome();
  writeJsonWithBackup(file, merged, { mode: 0o600 });

  return merged;
}

export function isDomainEnabled(config: EklavyaConfig, domain: string): boolean {
  return config.domains_enabled.includes('*') || config.domains_enabled.includes(domain);
}
