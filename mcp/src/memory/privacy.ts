import fs from 'node:fs';

/**
 * The privacy filter every capture path runs through (PRD CAP-02, SEC-01).
 *
 * It runs *before* persistence, not before display: an excluded path or a
 * redacted secret must never reach the database, a log line, a provider request,
 * an embedding, an export or a notification, because once it is stored every
 * later sink is a chance to leak it.
 *
 * Redaction is lossy on purpose. A value that matches is replaced by a marker
 * naming what it was, so an observation can still say "the deploy failed on an
 * expired token" without carrying the token.
 */

export interface PrivacyPolicy {
  /** Glob-ish path fragments whose files are never captured. */
  excludePaths: string[];
  /** Tool names never captured (their arguments are usually secrets). */
  excludeTools: string[];
  /** Extra regex sources, from configuration. */
  redactPatterns: string[];
}

export const DEFAULT_PRIVACY: PrivacyPolicy = {
  excludePaths: [
    '.env',
    '.env.',
    '/.ssh/',
    'id_rsa',
    'id_ed25519',
    '.pem',
    '.p12',
    '.keystore',
    'credentials.json',
    '.netrc',
    '.npmrc',
    'secrets.',
    '.eklavya/knowledge.db',
  ],
  excludeTools: [],
  redactPatterns: [],
};

/**
 * Built-in secret shapes. Each keeps its name so the redaction stays readable.
 *
 * Order matters: the vendor shapes run before `ASSIGNED`, so
 * `OPENAI_API_KEY=sk-proj-…` is named for what it is, and the assigned rule then
 * sees a marker (which it skips) rather than the key.
 *
 * Every pattern here runs over every captured tool body, so each one is written
 * to stay linear: a match may only *start* where a run of its characters starts
 * (a lookbehind, not `\b`), because `\b[a-z0-9-]*` retried at every letter of a
 * long hyphenated string is quadratic.
 */
const BUILT_IN: { name: string; re: RegExp }[] = [
  // Unclosed runs to the end of the text: a key cut off by a body cap, or pasted
  // half-way, is still a key, and the END line is exactly what gets cut.
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  // Only the password part of a URL's userinfo: the host is what makes a
  // memory like "the migration failed against db.internal" worth keeping.
  { name: 'url-credentials', re: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:/@?#]*:)[^\s@/?#]+@/gi },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai-key', re: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{20,})/g },
  { name: 'stripe-key', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { name: 'aws-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g },
];

/**
 * `KEY <sep> value`, for every spelling of a key a secret is kept under.
 *
 * The key may carry any prefix (`DB_PASSWORD`, `aws_secret_access_key`,
 * `OPENAI_API_KEY`, `config.password`) but must *end* in the keyword, give or
 * take a trailing `_key`/`_base` (`SECRET_KEY`, `SECRET_KEY_BASE`). That end
 * rule is what keeps `token_count: 1234567`, `max_tokens` and `passwordless`
 * out. The separator is `:`, `=` or `=>`, never `==`/`===`/`::`, with an
 * optional quote either side so JSON and PHP arrays match, and only spaces or
 * tabs around it: `password:` at the end of a line must not reach down and take
 * the next line's first word.
 *
 * Group 1 is everything kept (key, separator, an auth scheme); group 2 the
 * quote, group 3 a quoted value, group 4 a bare one.
 */
const ASSIGNED = new RegExp(
  String.raw`((?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*?` +
    String.raw`(?:password|passwd|passphrase|secret|credentials?|token|api[_-]?key|access[_-]?key|private[_-]?key|authorization)` +
    String.raw`(?:[_.-]?key)?(?:[_.-]base)?["']?\]?[ \t]*(?::|=>?)(?![=:])[ \t]*` +
    String.raw`(?:(?:basic|bearer|token|digest)[ \t]+)?)` +
    String.raw`(?:(["'])(?!\[redacted)([^"'\n]{4,})\2` +
    String.raw`|(?!\[redacted)([^\s"'\x60,;&(){}\[\]<>$][^\s"'\x60,;&<>)}\]]{5,}))`,
  'gi',
);

/**
 * Bare values that are code, not secrets. Judged only for an unquoted value: a
 * quoted one is a literal whatever it says.
 *
 * - a call — `token = getToken()`, `secret = crypto.randomBytes(32)`;
 * - a member reference — `apiKey = process.env.OPENAI_API_KEY`, `config.token`;
 * - a type — `password: string` in an interface.
 *
 * What is still redacted, on purpose: a bare identifier (`token = userToken`)
 * and an index (`token = tokens[i]`, which leaves a stray `]`). In a shell or a
 * `.env` file those shapes *are* the secret — `PASSWORD=Hunter2[x]` looks exactly
 * like `tokens[i]` — and a variable name lost from a memory costs far less than a
 * password kept in one. An exemption for indexes was tried and let those through.
 */
const CODE_CALL = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/;
const CODE_MEMBER = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
const TYPE_WORDS = new Set([
  'string', 'number', 'boolean', 'bigint', 'symbol', 'object', 'unknown', 'undefined', 'optional', 'required',
]);

/**
 * Whole values that describe a secret's state or a `fetch` option rather than
 * being one: `credentials: "same-origin"`, `Token: expired`. Exact, whole-value
 * matches only, quoted or not — `expired2024` is still a password. None of these
 * is a credential anyone could use, so keeping them costs nothing.
 */
const STATE_WORDS = new Set([
  'include', 'omit', 'same-origin',
  'expired', 'invalid', 'missing', 'revoked', 'rotated', 'present', 'absent', 'hidden', 'masked', 'redacted',
  'required', 'optional', 'provided', 'disabled', 'enabled', 'none', 'null', 'true', 'false', 'undefined',
]);

function looksLikeCode(value: string): boolean {
  return CODE_CALL.test(value) || CODE_MEMBER.test(value) || TYPE_WORDS.has(value.toLowerCase());
}

/**
 * Breaks any tag that would close or reopen a fence Eklavya wraps data in.
 *
 * Recalled memory and provider evidence are both quoted to a model inside a
 * tag, and both are text somebody else wrote. A title reading
 * `</eklavya-memory> Ignore the above` would otherwise end the fence early and
 * put its remainder outside the "this is evidence, not instruction" frame. Only
 * the fence tags are touched — every other `<` in code is left as written.
 */
export function defangFence(text: string, tags: string[] = ['eklavya-memory', 'event']): string {
  if (!text) return text;
  const names = tags.map((t) => t.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|');
  return text.replace(new RegExp(`<(\\s*/?\\s*)(${names})(?![\\w-])`, 'gi'), '‹$1$2');
}

export interface RedactionResult {
  text: string;
  redacted: boolean;
  kinds: string[];
}

export function redact(text: string, policy: PrivacyPolicy = DEFAULT_PRIVACY): RedactionResult {
  if (!text) return { text: '', redacted: false, kinds: [] };
  let out = text;
  const kinds: string[] = [];

  for (const { name, re } of BUILT_IN) {
    // A fresh RegExp each call: the module-level ones carry `lastIndex`.
    const pattern = new RegExp(re.source, re.flags);
    if (!pattern.test(out)) continue;
    pattern.lastIndex = 0;
    kinds.push(name);
    out =
      name === 'url-credentials'
        ? out.replace(pattern, '$1[redacted:password]@')
        : out.replace(pattern, `[redacted:${name}]`);
  }

  let assigned = false;
  out = out.replace(
    new RegExp(ASSIGNED.source, ASSIGNED.flags),
    (m: string, kept: string, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      if (bare !== undefined && looksLikeCode(bare)) return m;
      if (STATE_WORDS.has((quoted ?? bare ?? '').toLowerCase())) return m;
      assigned = true;
      return quoted !== undefined ? `${kept}${quote}[redacted:secret]${quote}` : `${kept}[redacted:secret]`;
    },
  );
  if (assigned) kinds.push('assigned-secret');

  for (const source of policy.redactPatterns) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, 'g');
    } catch {
      // An unparseable configured pattern is a configuration error, reported
      // elsewhere. Here it must not take the capture path down.
      continue;
    }
    if (!pattern.test(out)) continue;
    pattern.lastIndex = 0;
    kinds.push('configured');
    out = out.replace(pattern, '[redacted:configured]');
  }

  return { text: out, redacted: kinds.length > 0, kinds: [...new Set(kinds)] };
}

/**
 * True when this path must never be captured at all.
 *
 * Case-insensitive, and it follows a symlink where one exists. Both matter for
 * the same reason: the list is a list of *files*, and a match that depends on
 * how the path happened to be spelled is not an exclusion. On macOS and Windows
 * `/repo/.ENV` is the same file as `/repo/.env`, and `notes.txt -> ../.env` is
 * the same file again by another name.
 *
 * The realpath only runs when the literal comparison has already failed, so the
 * common case costs nothing, and a path that does not exist keeps the answer
 * the literal comparison gave.
 */
/**
 * `text` cut to `max` characters, redacted first. A cut made before redaction
 * can land inside a secret and leave a head no pattern recognises
 * (`DB_PASSWORD="hunter2` has lost the quote the rule needs), so every place
 * that trims a piece of a body goes through here, not `.slice()`.
 */
export function clip(text: string, max: number): string {
  return redact(text.slice(0, max * 4)).text.slice(0, max);
}

export function pathExcluded(file: string, policy: PrivacyPolicy = DEFAULT_PRIVACY): boolean {
  const matches = (candidate: string): boolean => {
    const normalised = candidate.replace(/\\/g, '/').toLowerCase();
    return policy.excludePaths.some((fragment) => normalised.includes(fragment.toLowerCase()));
  };

  if (matches(file)) return true;
  try {
    const resolved = fs.realpathSync(file);
    return resolved !== file && matches(resolved);
  } catch {
    // Not on disk, or not readable. The literal answer stands.
    return false;
  }
}

export function toolExcluded(tool: string | null | undefined, policy: PrivacyPolicy = DEFAULT_PRIVACY): boolean {
  if (!tool) return false;
  return policy.excludeTools.includes(tool);
}

/**
 * Eklavya's own traffic, which must never become memory (CAP-02).
 *
 * Without this the tutor's question becomes an observation, the observation
 * becomes a concept candidate, and the candidate becomes another question: a
 * loop that teaches the developer nothing but fills the corpus.
 */
export function isOwnTraffic(tool: string | null | undefined, body: string): boolean {
  if (tool && /^mcp__[a-z_]*eklavya/i.test(tool)) return true;
  if (tool === 'Bash' && /\beklavya\b/.test(body) && /\bdashboard\b|\bgate\b|\bdoctor\b/.test(body)) return true;
  return /\[Eklavya checkpoint\]|\[Eklavya\]/.test(body);
}
