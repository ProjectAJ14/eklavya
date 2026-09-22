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

/** Built-in secret shapes. Each keeps its name so the redaction stays readable. */
const BUILT_IN: { name: string; re: RegExp }[] = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}/g },
  { name: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { name: 'aws-key-id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  { name: 'assigned-secret', re: /\b(?:password|passwd|secret|api[_-]?key|token|access[_-]?key)\s*[:=]\s*["']?([^\s"'&;]{6,})["']?/gi },
];

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
      name === 'assigned-secret'
        ? out.replace(pattern, (m, value: string) => m.replace(value, '[redacted:secret]'))
        : out.replace(pattern, `[redacted:${name}]`);
  }

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
