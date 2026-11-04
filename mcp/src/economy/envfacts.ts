// Translated and adapted from microsoft/TokenEconomizer,
// tokeneconomizer/microskills/envfacts.py, observe.py and lifecycle.py at
// d3e193b8734ec76230da1e08d7929ba9d14640d8.
// Licensed under the Apache License, Version 2.0 (see ./LICENSE in this folder).
// Changes: ported from Python to TypeScript and reduced to the five families
// over Claude Code's Bash and WebFetch calls; forms and error classes are
// recognised by smaller patterns; the lifecycle is the one Eklavya's pinned
// facts share (memory/pinned.ts), so this file only observes and renders.

import { TEST_RUN_RE } from './signals.js';

/**
 * Environment facts, learned for free from failures that recur.
 *
 * An agent rediscovers the same fact about a machine by failing at it,
 * session after session: bare `pytest` is not installed here, `python -m
 * pytest` is; the code needs `DATABASE_URL` set; nothing can be fetched from a
 * host. Each family below reads one session's calls and returns what it saw;
 * the lifecycle in `memory/pinned.ts` turns observations that recur across
 * sessions into a fact. No model is involved. Every string a fact shows is a
 * form, a variable name or a host taken from the calls, filled into a fixed
 * template.
 */

export interface Call {
  tool: string;
  /** Bash: the command. WebFetch: the URL. */
  input: string;
  /** What came back, or the error. Read here and dropped; never stored. */
  output: string;
  failed: boolean;
}

export type Family = 'form_repair' | 'env_value' | 'boundary' | 'arg_repair' | 'empty_probe';

/**
 * One session's evidence about one fact. `verdict` is `confirm` (the session
 * hit the failure again, or used the working form), `contradict` (the thing
 * the fact says fails worked), or null (seen, nothing learned).
 */
export interface Observation {
  family: Family;
  /** Stable per fact: the family and what it is about. */
  key: string;
  params: Record<string, string>;
  verdict: 'confirm' | 'contradict' | null;
  /** The session ran the intent the fact is about. */
  exercised: boolean;
  /** The session used the fact's working form, and it worked. */
  applied: boolean;
  /** One clean contradiction retires a high-stakes fact at once. */
  high: boolean;
}

const INFRA: { cls: string; re: RegExp; phrase: string }[] = [
  { cls: 'command_missing', re: /command not found|is not recognized as an internal or external command|: not found$|No such file or directory.*\b(?:bin|exec)\b|ENOENT.*spawn/im, phrase: 'command not found' },
  { cls: 'module_missing', re: /ModuleNotFoundError|No module named|Cannot find module|ERR_MODULE_NOT_FOUND/i, phrase: 'a missing-module error' },
  { cls: 'permission_denied', re: /permission denied|EACCES/i, phrase: 'permission denied' },
];
const NETWORK = /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|Could not resolve host|Connection refused|Name or service not known|Network is unreachable|getaddrinfo/i;

export const infraError = (text: string): string | null => INFRA.find((e) => e.re.test(text))?.cls ?? null;
export const errorPhrase = (cls: string): string => INFRA.find((e) => e.cls === cls)?.phrase ?? cls;

/** `FOO=1 BAR=2 cmd` → [{FOO: '1', BAR: '2'}, 'cmd']. */
export function envPrefix(command: string): [Record<string, string>, string] {
  const env: Record<string, string> = {};
  let rest = command.trim();
  for (;;) {
    const m = /^([A-Z_][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s+/.exec(rest);
    if (!m) break;
    env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
    rest = rest.slice(m[0].length);
  }
  return [env, rest];
}

/** What the command is for, when it is one a fact can be about. */
export function intentOf(command: string): string | null {
  const [, cmd] = envPrefix(command);
  if (TEST_RUN_RE.test(cmd)) return 'run_tests';
  if (/^(?:\S*\/)?(?:python\d?(?:\.\d+)?|node|ruby|deno|bun)\b/.test(cmd)) return 'run_interpreter';
  if (/^(?:\S*\/)?(?:pip\d?|npm|pnpm|yarn|poetry|uv|cargo|go|mvn|gradlew?)\b/.test(cmd)) return 'package_tool';
  return null;
}

/**
 * How a command was invoked, without its arguments: `pytest`, `python -m
 * pytest`, `npx vitest`, `.venv/bin/pytest`, `cd api && pytest`. The first
 * command of a `&&` chain only, plus a leading `cd DIR &&`.
 */
export function formOf(command: string): string {
  const [, cmd] = envPrefix(command);
  const parts = cmd.split(/\s*&&\s*/);
  const cd = /^cd\s+\S+$/.test(parts[0]!) && parts.length > 1 ? `${parts.shift()} && ` : '';
  const words = parts[0]!.split(/\s+/);
  const head = words[0]!;
  let n = 1;
  if (/python\d?(?:\.\d+)?$/.test(head) && words[1] === '-m') n = 3;
  else if (/^(?:npx|pnpx|bunx|uv|poetry|pipenv)$/.test(head) && words[1] && !words[1].startsWith('-')) n = words[1] === 'run' ? 3 : 2;
  else if (/^(?:npm|pnpm|yarn)$/.test(head) && words[1] && !words[1].startsWith('-')) n = words[1] === 'run' ? 3 : 2;
  else if (/^(?:go|cargo)$/.test(head) && words[1]) n = 2;
  return cd + words.slice(0, n).join(' ');
}

const isBare = (form: string) => !form.includes('/') && !form.includes(' ');

/** FormRepair: form A of an intent fails with an infrastructure error, and a later form B of the same intent works. */
export function formRepairs(calls: Call[]): Observation[] {
  const out = new Map<string, Observation>();
  const failedForms = new Map<string, { form: string; cls: string }>(); // intent → first failing form
  for (const c of calls) {
    if (c.tool !== 'Bash') continue;
    const intent = intentOf(c.input);
    if (!intent) continue;
    const [env] = envPrefix(c.input);
    const form = formOf(c.input);
    const cls = infraError(c.output);
    if (cls) {
      if (!failedForms.has(intent)) failedForms.set(intent, { form, cls });
      continue;
    }
    const a = failedForms.get(intent);
    if (a && !c.failed && form !== a.form && !Object.keys(env).length && (intent === 'run_tests' || !isBare(form))) {
      const key = `form_repair:${intent}:${a.form}`;
      out.set(key, { family: 'form_repair', key, params: { a: a.form, b: form, error: a.cls, intent }, verdict: 'confirm', exercised: true, applied: false, high: false });
    }
  }
  return [...out.values()];
}

/**
 * How a session bears on known FormRepair facts: the failing form working
 * contradicts one; the working form working applies it.
 */
export function formRepairEvidence(calls: Call[], fact: { a: string; b: string; intent: string }): Pick<Observation, 'verdict' | 'exercised' | 'applied'> {
  let exercised = false;
  let applied = false;
  let verdict: Observation['verdict'] = null;
  for (const c of calls) {
    if (c.tool !== 'Bash' || intentOf(c.input) !== fact.intent) continue;
    exercised = true;
    const form = formOf(c.input);
    const ok = !c.failed && !infraError(c.output);
    if (form === fact.b && ok) applied = true;
    if (form === fact.a) verdict = ok ? 'contradict' : verdict ?? 'confirm';
  }
  return { verdict, exercised, applied };
}

const ENV_ASK = /(?:environment variable|env var(?:iable)?)\s+[`'"]?([A-Z][A-Z0-9_]{2,})|KeyError: ['"]([A-Z][A-Z0-9_]{2,})['"]|\b([A-Z][A-Z0-9_]{2,}) (?:is not set|must be set|is required|not defined in (?:the )?environment)/;

/** EnvValue: a run fails asking for a variable by name, and a later run that sets it works. */
export function envValues(calls: Call[]): Observation[] {
  const asked = new Set<string>();
  const out = new Map<string, Observation>();
  for (const c of calls) {
    if (c.tool !== 'Bash') continue;
    const m = ENV_ASK.exec(c.output);
    if (m && c.failed !== false) {
      asked.add((m[1] ?? m[2] ?? m[3])!);
      continue;
    }
    const [env] = envPrefix(c.input);
    for (const v of Object.keys(env)) {
      if (asked.has(v) && !c.failed) {
        const key = `env_value:${v}`;
        out.set(key, { family: 'env_value', key, params: { var: v, good: env[v]! }, verdict: 'confirm', exercised: true, applied: false, high: false });
      }
    }
  }
  return [...out.values()];
}

const hostOf = (input: string): string | null => /https?:\/\/([^/\s:'"]+)/i.exec(input)?.[1]?.toLowerCase() ?? null;
const FETCHERS = /^(?:\S*\/)?(?:curl|wget|http|pip\d? (?:install|download)|npm (?:install|i)|git (?:clone|fetch|pull))\b/;

/** Boundary: every fetch to a host fails with a network error and none succeeds. */
export function boundaries(calls: Call[]): Observation[] {
  const tally = new Map<string, { failed: number; ok: number }>();
  for (const c of calls) {
    const fetch = c.tool === 'WebFetch' || (c.tool === 'Bash' && FETCHERS.test(envPrefix(c.input)[1]));
    if (!fetch) continue;
    const host = hostOf(c.input);
    if (!host) continue;
    const t = tally.get(host) ?? { failed: 0, ok: 0 };
    if (NETWORK.test(c.output)) t.failed++;
    else if (!c.failed) t.ok++;
    tally.set(host, t);
  }
  return [...tally.entries()]
    .filter(([, t]) => t.failed || t.ok)
    .map(([host, t]) => ({
      family: 'boundary' as const,
      key: `boundary:${host}`,
      params: { host },
      verdict: t.ok ? ('contradict' as const) : ('confirm' as const),
      exercised: true,
      applied: false,
      high: false,
    }));
}

/** ArgRepair: a test label written `a::b` fails to load and the dotted `a.b`, run the same way, loads. */
export function argRepairs(calls: Call[]): Observation[] {
  const failedSep = new Map<string, boolean>(); // form → saw a `::` label fail to load
  const out = new Map<string, Observation>();
  const NOT_LOADED = /not found|no tests ran|ERROR: (?:file or directory|module) not found|ImportError|cannot import/i;
  for (const c of calls) {
    if (c.tool !== 'Bash' || intentOf(c.input) !== 'run_tests') continue;
    const form = formOf(c.input);
    const label = c.input.split(/\s+/).slice(1).find((w) => /\w(::|\.)\w/.test(w) && !w.startsWith('-'));
    if (!label) continue;
    if (label.includes('::')) {
      if (NOT_LOADED.test(c.output)) failedSep.set(form, true);
      else if (failedSep.has(form)) out.set(`arg_repair:${form}`, { family: 'arg_repair', key: `arg_repair:${form}`, params: { form, kind: 'sep' }, verdict: 'contradict', exercised: true, applied: false, high: false });
    } else if (failedSep.get(form) && !c.failed && !NOT_LOADED.test(c.output)) {
      out.set(`arg_repair:${form}`, { family: 'arg_repair', key: `arg_repair:${form}`, params: { form, kind: 'sep' }, verdict: 'confirm', exercised: true, applied: false, high: false });
    }
  }
  return [...out.values()];
}

const PROBE = /^git (?:remote(?:\s+-v)?|branch\s+-(?:r|a)|ls-remote|tag)\s*$/;

/** EmptyProbe: a probe for git remotes or other refs returns nothing. High stakes: one probe that finds something retires it. */
export function emptyProbes(calls: Call[]): Observation[] {
  let seen = false;
  let empty = true;
  for (const c of calls) {
    if (c.tool !== 'Bash' || !PROBE.test(c.input.trim()) || c.failed) continue;
    seen = true;
    if (c.output.trim() && !/^\*?\s*(?:main|master|HEAD)\s*$/m.test(c.output.trim())) empty = false;
  }
  if (!seen) return [];
  return [{ family: 'empty_probe', key: 'empty_probe:git', params: {}, verdict: empty ? 'confirm' : 'contradict', exercised: true, applied: false, high: true }];
}

/** Every family over one session's calls. */
export function observe(calls: Call[]): Observation[] {
  return [...formRepairs(calls), ...envValues(calls), ...boundaries(calls), ...argRepairs(calls), ...emptyProbes(calls)];
}

/** Words that would turn a fact into completion or verification advice; a fact that has one is never shown. */
export const LINT = /\b(skip|no need|don'?t|do not|stop|done|completed?|finish(?:ed)?|verify|verification|instead of (?:running|testing))\b/i;

/** A form shown as a claim. One that starts with `cd DIR &&` is shown as a subshell, so the shell's directory is not left in DIR. */
const usage = (form: string, args = ' …') => (/^cd \S+ && /.test(form) ? `\`(${form}${args})\`` : `\`${form}${args}\``);

/** The one-line fact for an observation's parameters. */
export function render(family: Family, p: Record<string, string>): string {
  switch (family) {
    case 'form_repair':
      return `${usage(p.a!)} fails here with ${errorPhrase(p.error!)}; ${usage(p.b!)} works.`;
    case 'env_value':
      return `Code that imports the project needs \`${p.var}\` set here: \`${p.var}=${p.good}\` works.`;
    case 'boundary':
      return `Outbound connections to ${p.host} fail here; nothing can be fetched from it.`;
    case 'arg_repair':
      return `${usage(p.form!, '')} takes dotted test labels (\`module.Class.test\`, not \`module::Class::test\`).`;
    case 'empty_probe':
      return 'This checkout has no git remote and no branches or tags beyond the local ones.';
  }
}
