// Translated and adapted from microsoft/TokenEconomizer,
// tokeneconomizer/loopguard/shell_edits.py at d3e193b8734ec76230da1e08d7929ba9d14640d8.
// Licensed under the Apache License, Version 2.0 (see ./LICENSE in this folder).
// Changes: ported from Python to TypeScript; the Codex `apply_patch` form is kept,
// `shlex` is replaced by a small tokenizer with the same punctuation rules.

/**
 * Edits made through the shell, which an edit-tool counter does not see.
 *
 * An agent that edits with `sed -i`, `perl -pi`, a redirect or `tee` into a
 * source file, an inline Python script that writes the file back, `patch` or
 * `git apply` looks like one that edited nothing. `shellEditTargets` reads those
 * writes off the command so the loop guard's turn state counts them.
 */

const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/;
const OPS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '\n', '(', ')']);
const OUT = new Set(['>', '>>', '>|', '&>', '&>>']);
const SKIP_OPERAND = new Set(['<', '<<', '<<<', '<&', '>&', '<>']);
const PUNCT = '();<>|&\n';
/** Redirect and `tee` targets count only when they look like source, so `> out.log` is not an edit. */
export const SOURCE_FILE =
  /\.(?:py|pyi|pyx|pxd|js|jsx|mjs|cjs|ts|tsx|rs|go|java|kt|kts|scala|c|cc|cpp|cxx|h|hh|hpp|rb|php|cs|swift|m|mm|sh|bash|zsh|lua|jl|ex|exs|erl|hs|ml|clj|sql|toml|ya?ml|json|cfg|ini|conf|md|rst|html?|css|scss|vue|svelte|xml|gradle|properties|in)$/i;
const PYTHON = /(?:^|[\s/;&|(])python\d?(?:\.\d+)?\b/;
const PY_OPEN_LIT = /open\(\s*(['"])([^'"\n]+)\1\s*,\s*(['"])([^'"]*)\3/g;
const PY_OPEN_VAR = /open\(\s*([A-Za-z_]\w*)\s*,\s*(['"])([^'"]*)\2/g;
const PY_WRITE_PATH_LIT = /(?:pathlib\.)?Path\(\s*(['"])([^'"\n]+)\1\s*\)\.write_(?:text|bytes)\(/g;
const PY_WRITE_PATH_VAR = /\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(/g;
const PATCH_FILE = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+?)\s*$/gm;

export const basename = (p: string): string => p.replace(/\/+$/, '').split('/').pop()!;
const notScratch = (p: string) => Boolean(p) && !/^\/(dev|proc|tmp)\//.test(p);
const unquote = (t: string) => (t.length >= 2 && t[0] === t[t.length - 1] && (t[0] === "'" || t[0] === '"') ? t.slice(1, -1) : t);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The command without heredoc bodies, and the bodies. */
function splitHeredocs(cmd: string): [string, string[]] {
  const shell: string[] = [];
  const bodies: string[] = [];
  let tag: string | null = null;
  let body: string[] = [];
  for (const line of cmd.split('\n')) {
    if (tag !== null) {
      if (line.trim() === tag) {
        bodies.push(body.join('\n'));
        tag = null;
        body = [];
      } else body.push(line);
      continue;
    }
    shell.push(line);
    const m = HEREDOC_START.exec(line);
    if (m) tag = m[2]!;
  }
  if (tag !== null) bodies.push(body.join('\n'));
  return [shell.join('\n'), bodies];
}

/**
 * Shell words and operators. Quotes stay on quoted words, so a quoted `'>'` is
 * never an operator; a run of punctuation is one token. Throws on an
 * unbalanced quote, as `shlex` does.
 */
export function shellTokens(text: string): string[] {
  const out: string[] = [];
  let word = '';
  let i = 0;
  const flush = () => {
    if (word) out.push(word);
    word = '';
  };
  while (i < text.length) {
    const c = text[i]!;
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end === -1) throw new Error('unbalanced quote');
      word += text.slice(i, end + 1);
      i = end + 1;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flush();
      i++;
    } else if (PUNCT.includes(c)) {
      flush();
      let j = i;
      while (j < text.length && PUNCT.includes(text[j]!)) j++;
      out.push(text.slice(i, j));
      i = j;
    } else {
      word += c;
      i++;
    }
  }
  flush();
  return out;
}

/** Simple commands as unquoted word lists, and the files their redirects write. */
function commands(shell: string): [string[][], string[]] {
  let streams: string[][];
  try {
    streams = [shellTokens(shell)];
  } catch {
    // One bad line must not hide the others.
    streams = [];
    for (const line of shell.split('\n')) {
      try {
        streams.push([...shellTokens(line), '\n']);
      } catch {
        /* skip the line */
      }
    }
  }
  const cmds: string[][] = [];
  const writes: string[] = [];
  for (const toks of streams) {
    let cur: string[] = [];
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]!;
      if (OPS.has(t)) {
        if (cur.length) cmds.push(cur);
        cur = [];
      } else if (OUT.has(t) || SKIP_OPERAND.has(t)) {
        // `2>`: the fd number is not an operand.
        if (cur.length && /^\d+$/.test(cur[cur.length - 1]!)) cur.pop();
        if (OUT.has(t) && i + 1 < toks.length && !OPS.has(toks[i + 1]!)) writes.push(unquote(toks[i + 1]!));
        i++;
      } else cur.push(unquote(t));
    }
    if (cur.length) cmds.push(cur);
  }
  return [cmds, writes];
}

/** File operands of an in-place editor (`sed -i`, `perl -pi`), or [] if not in place. */
function inplaceFiles(tokens: string[], inplace: (t: string) => boolean, scriptFlag: (t: string) => boolean): string[] {
  if (!tokens.slice(1).some(inplace)) return [];
  const files: string[] = [];
  let haveScript = false;
  let skip = false;
  for (const t of tokens.slice(1)) {
    if (skip) {
      skip = false;
      haveScript = true;
      continue;
    }
    if (!t || t.startsWith('-')) {
      if (t && scriptFlag(t)) skip = true;
      continue;
    }
    if (!haveScript) {
      haveScript = true;
      continue;
    }
    files.push(t);
  }
  return files;
}

/** Paths an inline Python script writes; "(script)" for a write whose path this cannot resolve. */
function pyWrites(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PY_OPEN_LIT)) if (/[wax+]/.test(m[4]!)) out.push(m[2]!);
  const variables: string[] = [];
  for (const m of text.matchAll(PY_OPEN_VAR)) if (/[wax+]/.test(m[3]!)) variables.push(m[1]!);
  for (const m of text.matchAll(PY_WRITE_PATH_LIT)) out.push(m[2]!);
  for (const m of text.matchAll(PY_WRITE_PATH_VAR)) variables.push(m[1]!);
  for (const v of new Set(variables)) {
    const name = escapeRe(v);
    const found = [...text.matchAll(new RegExp(`\\b${name}\\s*=\\s*(?:(?:pathlib\\.)?Path\\(\\s*)?(['"])([^'"\\n]+)\\1`, 'g'))].map((m) => m[2]!);
    const loop = new RegExp(`\\bfor\\s+${name}\\s+in\\s+[\\[(]([^\\])]*)[\\])]`).exec(text);
    const paths = [...found, ...(loop ? [...loop[1]!.matchAll(/['"]([^'"\n]+)['"]/g)].map((m) => m[1]!) : [])];
    out.push(...(paths.length ? paths : ['(script)']));
  }
  return out;
}

/** Basenames of the files a shell command writes, in order, without repeats. */
export function shellEditTargets(cmd: unknown): string[] {
  if (typeof cmd !== 'string' || !cmd.trim()) return [];
  const [shell, bodies] = splitHeredocs(cmd);
  const [cmds, writes] = commands(shell);
  const found = writes.filter((w) => SOURCE_FILE.test(w));
  for (let tokens of cmds) {
    while (tokens.length && (['sudo', 'command', 'env', 'time', 'nohup'].includes(tokens[0]!) || /^\w+=/.test(tokens[0]!))) {
      tokens = tokens.slice(1);
    }
    if (!tokens.length) continue;
    const head = tokens[0]!.split('/').pop()!;
    if (head === 'sed') {
      found.push(...inplaceFiles(tokens, (t) => /^(?:-[a-zA-Z]*i|--in-place)/.test(t), (t) => ['-e', '-f', '--expression', '--file'].includes(t)));
    } else if (head === 'perl') {
      found.push(...inplaceFiles(tokens, (t) => /^-[a-zA-Z]*i/.test(t), (t) => /^-[a-zA-Z]*e$/.test(t)));
    } else if (head === 'tee') {
      found.push(...tokens.slice(1).filter((t) => !t.startsWith('-') && SOURCE_FILE.test(t)));
    } else if (head === 'apply_patch') {
      const named = [...[...bodies, tokens.slice(1).join(' ')].join('\n').matchAll(PATCH_FILE)].map((m) => m[1]!);
      found.push(...(named.length ? named : ['(patch)']));
    } else if (head === 'patch' || (head === 'git' && tokens[1] === 'apply')) {
      found.push('(patch)');
    } else if (head === 'git' && tokens.length > 2 && (tokens[1] === 'checkout' || tokens[1] === 'restore')) {
      const dash = tokens.indexOf('--');
      const rest = dash !== -1 ? tokens.slice(dash + 1) : tokens[1] === 'restore' ? tokens.slice(2) : [];
      found.push(...rest.filter((t) => !t.startsWith('-')));
    }
  }
  if (PYTHON.test(shell)) found.push(...pyWrites([shell, ...bodies].join('\n')));
  const names = found
    .filter((p) => p.startsWith('(') || notScratch(p))
    .map((p) => (p.startsWith('(') ? p : basename(p)))
    .filter(Boolean);
  return [...new Set(names)];
}
