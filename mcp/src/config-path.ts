import {
  coerce,
  DEFAULT_CONFIG,
  loadConfig,
  loadGlobalConfig,
  readConfigFile,
  writeConfigFile,
  type EklavyaConfig,
} from './config.js';
import { globalConfigPath, projectConfigPath } from './paths.js';

/**
 * Dotted-path configuration keys, for `eklavya config set` and `set_config`.
 *
 * The learning dials are flat (`mode`, `cadence`) and the memory half's are
 * nested (`memory.enabled`, `retrieval.mode`). Without this the nested half was
 * unreachable from either the CLI or the tool — the only way to change it was
 * to edit the JSON by hand, which is fine for a maintainer and no good at all
 * for the developer who asks their agent to turn capture off.
 *
 * Validated against `DEFAULT_CONFIG` rather than a hand-written list, for the
 * reason `mcp/CLAUDE.md` gives: a hand-written list is a place a new key gets
 * accepted and then silently discarded.
 */

/** Every settable key, flat and dotted, in the order `DEFAULT_CONFIG` declares them. */
export function knownKeys(base: Record<string, unknown> = DEFAULT_CONFIG as unknown as Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(base)) {
    const full = prefix ? `${prefix}.${key}` : key;
    keys.push(full);
    // One level of nesting is all the schema has, and all it should have: a
    // second would be a config nobody can hold in their head.
    if (!prefix && isPlainObject(value)) {
      keys.push(...knownKeys(value, full));
    }
  }
  return keys;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isKnownKey(key: string): boolean {
  return knownKeys().includes(key);
}

/** The default sitting at a dotted path, for type-directed parsing. */
export function defaultAt(key: string): unknown {
  let cursor: unknown = DEFAULT_CONFIG;
  for (const part of key.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * Turns a command-line string into the type the schema expects at that key.
 *
 * Type-directed rather than guess-directed. `focus_topic 2` must stay the
 * string "2" and `memory.batch_max_events 40` must become the number 40, and
 * only the default at that path knows which is which — a parser that guessed
 * from the text turned a topic called "html5" into something `coerce` then
 * silently dropped.
 */
/**
 * The keys whose default is `null`, and what they are when they are not.
 *
 * `null` is the one default that cannot tell you its own type, and guessing
 * from the text is exactly the bug this function exists to avoid: a topic of
 * "2" is a topic. So the handful of nullable keys are named. **Add a key here
 * when you add a nullable setting** — a missing entry falls back to JSON
 * parsing, which is right for an object and wrong for a string.
 */
const NULLABLE: Record<string, 'string' | 'number' | 'object'> = {
  focus_topic: 'string',
  'memory.retention_days': 'number',
  'providers.observer': 'object',
  'providers.embeddings': 'object',
};

export function parseValue(key: string, raw: string): unknown {
  const target = defaultAt(key);

  if (target === null) {
    if (raw === 'null') return null;
    const kind = NULLABLE[key];
    if (kind === 'string') return raw;
    if (kind === 'number') {
      const n = Number(raw);
      return Number.isNaN(n) ? raw : n;
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  if (typeof target === 'boolean') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return raw;
  }
  if (typeof target === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeof target === 'string') return raw;
  if (Array.isArray(target)) {
    // JSON first, so `["a","b"]` works, then a comma list, which is what
    // anybody actually types.
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* not JSON; fall through to the comma list */
    }
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }
  if (isPlainObject(target)) {
    // A whole namespace, set at once. JSON or nothing: there is no sensible
    // shorthand for an object, and a wrong guess writes a setting that
    // silently never applies.
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }
  // An unknown shape: leave the text alone and let `coerce` refuse it, which
  // is the honest outcome. Inventing a type here would be inventing a value.
  return raw;
}

/**
 * Writes `value` into a patch object at a dotted path.
 *
 * The nested case has to carry its siblings: `loadConfig` merges the two files
 * with a shallow spread, so writing `{ memory: { enabled: false } }` over a
 * file that also set `memory.capture` would drop `capture`. The patch is
 * therefore built from the *existing* file's namespace, not from nothing.
 */
export function patchFor(existing: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> {
  const [head, ...rest] = key.split('.');
  if (!rest.length) return { [head!]: value };

  const current = existing[head!];
  const namespace = isPlainObject(current) ? { ...current } : {};
  namespace[rest.join('.')] = value;
  return { [head!]: namespace };
}

/** Reads the effective value at a dotted path out of a resolved config. */
export function valueAt(config: EklavyaConfig, key: string): unknown {
  let cursor: unknown = config;
  for (const part of key.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/** Key order is not meaning: `{kind, target}` and `{target, kind}` are one sink. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) =>
    isPlainObject(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x);

/**
 * What each setting accepts: the one table `eklavya config set|unset`, the
 * dashboard's Settings pages and the `set_config` tool all check against, so
 * the three refuse exactly the same values with the same words. The dashboard
 * ships it to the page for its inputs and hints; the tool builds its number
 * schemas from it.
 *
 * Keyed by leaf. `providers.*` and `notifications.sinks` are objects `coerce`
 * already checks field by field, so they have no row here.
 */
export interface SettingRule {
  type: 'bool' | 'enum' | 'number' | 'text' | 'list';
  options?: readonly string[];
  min?: number;
  max?: number;
  /** Whole numbers only. `coerce` floors the rest, which is a silent edit. */
  int?: boolean;
  /** `null` is a value: a topic cleared, evidence kept for ever. */
  nullable?: boolean;
  /** Text, or each list item, in characters. */
  maxLength?: number;
  maxItems?: number;
  /** Each list item must compile as a JavaScript regular expression. */
  regex?: boolean;
}

const bool: SettingRule = { type: 'bool' };
const whole = (min: number, max: number, nullable = false): SettingRule => ({ type: 'number', min, max, int: true, nullable });
const share: SettingRule = { type: 'number', min: 0, max: 1 };
const lines = (extra: Partial<SettingRule> = {}): SettingRule => ({ type: 'list', maxItems: 100, maxLength: 500, ...extra });
const text = (nullable: boolean, maxLength: number): SettingRule => ({ type: 'text', nullable, maxLength });

export const SETTING_RULES: Record<string, SettingRule> = {
  'quiz.enabled': bool,
  'quiz.enforced': bool,
  'quiz.only_on_changes': bool,
  focus: { type: 'enum', options: ['concept', 'project', 'learn'] },
  focus_topic: text(true, 200),
  cadence: { type: 'enum', options: ['interleaved', 'end'] },
  difficulty: { type: 'enum', options: ['auto', 'easy', 'medium', 'hard'] },
  level_up_after: whole(1, 1000),
  level_up_accuracy: share,
  pass_threshold: share,
  max_questions_per_task: whole(1, 10),
  min_minutes_between_quizzes: whole(0, 1440),
  min_minutes_between_checkpoints: whole(0, 120),
  domains_enabled: lines({ maxLength: 100 }),
  quiet: bool,
  explain_on_wrong: bool,
  auto_update: bool,
  telemetry: bool,
  max_new_concepts_per_session: whole(0, 50),
  max_stop_blocks_per_session: whole(0, 20),
  'memory.enabled': bool,
  'memory.capture': { type: 'enum', options: ['full', 'minimal', 'off'] },
  'memory.batch_max_events': whole(1, 500),
  'memory.retention_days': whole(1, 36500, true),
  'privacy.exclude_paths': lines(),
  'privacy.exclude_tools': lines({ maxLength: 200 }),
  'privacy.redact_patterns': lines({ regex: true }),
  'retrieval.mode': { type: 'enum', options: ['hybrid', 'keyword', 'semantic'] },
  'retrieval.max_items': whole(1, 50),
  'retrieval.max_tokens': whole(100, 20000),
  'retrieval.cross_project': bool,
  'notifications.enabled': bool,
  'sync.enabled': bool,
  'sync.target': text(true, 1000),
  'sync.device_id': text(true, 200),
};

/** Text trimmed, list lines trimmed and blank ones dropped: typing, not meaning. */
export function normalizeSetting(key: string, value: unknown): unknown {
  const rule = SETTING_RULES[key];
  if (rule?.type === 'text' && typeof value === 'string') return value.trim();
  if (rule?.type === 'list' && Array.isArray(value)) {
    return value.map((x) => (typeof x === 'string' ? x.trim() : x)).filter((x) => x !== '');
  }
  return value;
}

/** Why `value` is not acceptable for `key`, or null. Pure: no file is read. */
export function settingProblem(key: string, value: unknown): string | null {
  const r = SETTING_RULES[key];
  if (!r) return null;
  if (value === null) return r.nullable ? null : `${key} cannot be empty.`;
  switch (r.type) {
    case 'bool':
      return typeof value === 'boolean' ? null : `${key} is true or false.`;
    case 'enum':
      return typeof value === 'string' && r.options!.includes(value) ? null : `${key} is one of ${r.options!.join(', ')}.`;
    case 'number': {
      const range = `${r.int ? 'a whole number' : 'a number'} from ${r.min} to ${r.max}${r.nullable ? ', or empty' : ''}`;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < r.min! || value > r.max!) return `${key} is ${range}.`;
      return r.int && !Number.isInteger(value) ? `${key} is ${range}.` : null;
    }
    case 'text':
      if (typeof value !== 'string' || !value.trim()) return `${key} needs some text${r.nullable ? ', or empty to clear it' : ''}.`;
      return value.length > r.maxLength! ? `${key} is at most ${r.maxLength} characters.` : null;
    case 'list': {
      if (!Array.isArray(value)) return `${key} is a list of text lines.`;
      if (value.length > r.maxItems!) return `${key} holds at most ${r.maxItems} lines.`;
      for (const item of value) {
        if (typeof item !== 'string' || !item.trim()) return `${key} lines cannot be empty.`;
        if (item.length > r.maxLength!) return `${key} lines are at most ${r.maxLength} characters.`;
        if (r.regex) {
          try {
            new RegExp(item, 'g');
          } catch {
            // Capture skips a pattern that will not compile, so it would never redact anything.
            return `${key}: ${JSON.stringify(item)} is not a valid regular expression.`;
          }
        }
      }
      return null;
    }
  }
}

/**
 * Settings that are each valid but do nothing together, read off the config a
 * change would resolve to. Shared with `set_config` for the same reason as the
 * table: a combination one interface refuses, another must not store.
 */
export function combinationProblem(config: EklavyaConfig): string | null {
  if (config.focus === 'learn' && !config.focus_topic) {
    return 'focus "learn" needs a topic: set focus_topic too (eklavya config set focus learn --topic <topic>).';
  }
  return null;
}

/**
 * The one way a setting is written, shared by `eklavya config set|unset` and the
 * dashboard's Settings pages, so the two interfaces cannot disagree about what
 * is allowed (a global-only key at project scope is refused by `writeConfigFile`).
 * `projectRoot` null writes the user file (`~/.eklavya/config.json`); otherwise that project's file under `~/.eklavya/projects/`. `value`
 * `undefined` removes the key, so the scope inherits again -- `JSON.stringify`
 * drops it on the way through `writeConfigFile`'s merge.
 *
 * Checked three ways before anything is written: against `SETTING_RULES`;
 * against `coerce`, since it ignores what it cannot read and writing
 * `cadence bogus` used to "succeed" and silently do nothing; and against the
 * config the change would resolve to, so a value that would not take effect
 * (`quiz.enforced` with questions off, `learn` with no topic) is refused
 * rather than stored. Whole namespaces skip the coerce comparison -- coercion
 * fills their missing fields with defaults, which is not a disagreement.
 */
export function applySetting(
  key: string,
  value: unknown,
  projectRoot: string | null,
  also: Record<string, unknown> = {},
): { target: string; patch: Record<string, unknown> } {
  if (!isKnownKey(key)) throw new Error(`Unknown setting "${key}". Known: ${knownKeys().join(', ')}`);
  value = normalizeSetting(key, value);
  if (value !== undefined) {
    const problem = settingProblem(key, value);
    if (problem) throw new Error(problem);
    if (!isPlainObject(defaultAt(key))) {
      const got = valueAt(coerce(patchFor({}, key, value), DEFAULT_CONFIG), key);
      if (canonical(got) !== canonical(value)) {
        throw new Error(`${JSON.stringify(value)} is not a valid value for ${key}.`);
      }
    }
  }
  for (const [k, v] of Object.entries(also)) {
    const problem = settingProblem(k, normalizeSetting(k, v));
    if (problem) throw new Error(problem);
    also[k] = normalizeSetting(k, v);
  }
  const target = projectRoot ? projectConfigPath(projectRoot) : globalConfigPath();
  const patch = { ...patchFor(readConfigFile(target), key, value), ...also };
  // Which checkout the file is about, so a slug collision is caught (`belongsTo`).
  if (projectRoot) patch.project = projectRoot;

  const overlay = { file: target, patch };
  const next = projectRoot ? loadConfig(projectRoot, overlay).config : loadGlobalConfig(overlay);
  const combo = combinationProblem(next);
  if (combo) throw new Error(combo);
  if (key === 'quiz.enforced' && value === true && !next.quiz.enabled) {
    throw new Error('quiz.enforced has no effect while quiz.enabled is false: a gate with no questions can never be passed. Turn questions on first.');
  }

  writeConfigFile(target, patch);
  return { target, patch };
}
