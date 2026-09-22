import { DEFAULT_CONFIG, type EklavyaConfig } from './config.js';

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
