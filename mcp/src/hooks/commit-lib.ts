/**
 * Does this Bash command create a commit? The PreToolUse gate's one question.
 *
 * It used to be a single regex anchored at the start of the line or after `;`,
 * `&` or `|`. That missed a commit on its own line (`npm test\ngit commit`),
 * inside `( )`, `{ }`, `$( )` or backticks, behind `env`, `command`, `time`,
 * `nice` or `VAR=x`, through `/usr/bin/git` or `bash -c "…"`, and after
 * `git --no-pager` or `git -C "my dir"`. Each extra case made the regex less
 * readable, so this is a small shell lexer instead: split the command into
 * simple commands the way the shell would, peel off the prefixes that run their
 * argument as a command, and look at what git is asked to do.
 *
 * What it deliberately still lets through, because none of it runs a commit:
 * a quoted string (`echo "git commit"`), a comment, a here-document body, and
 * other subcommands that merely contain the word (`git commit-tree`,
 * `git log --grep commit`).
 *
 * Scope matches the git pre-commit hook (`cli/eklavya-gate`), checked against
 * git 2.50: `git commit` and `git merge --continue` run pre-commit; a clean
 * `git merge`, `cherry-pick`, `revert`, `am` and `rebase --continue` do not. Two
 * enforcement paths disagreeing about what a commit is would be a gate one of
 * them waves through.
 *
 * Known misses, accepted: git aliases (`git ci`), a variable holding the command
 * (`$GIT commit`), and scripts on disk. This is a speed bump for an agent that
 * forgot the quiz, not a sandbox; the git hook is the backstop.
 */

type Words = string[];

/** Every simple command in `src`, as its words with quotes resolved. */
export function simpleCommands(src: string): Words[] {
  const out: Words[] = [];
  let i = 0;
  const heredocs: { delim: string; strip: boolean }[] = [];

  // Skip here-document bodies queued on the line just ended. `i` sits just
  // past the newline.
  const skipHeredocs = () => {
    while (heredocs.length) {
      const { delim, strip } = heredocs.shift()!;
      while (i < src.length) {
        const nl = src.indexOf('\n', i);
        const end = nl === -1 ? src.length : nl;
        let line = src.slice(i, end);
        if (strip) line = line.replace(/^\t+/, '');
        i = end + 1;
        if (line === delim) break;
      }
    }
  };

  // One command list, up to `stop` (`)` or a backtick) or the end of input.
  const list = (stop: string | null): void => {
    let words: string[] = [];
    let word = '';
    let inWord = false;
    const endWord = () => {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    };
    const endCmd = () => {
      endWord();
      if (words.length) out.push(words);
      words = [];
    };

    while (i < src.length) {
      const c = src[i];
      if (c === stop) {
        i += 1;
        endCmd();
        return;
      }
      if (c === ' ' || c === '\t') {
        endWord();
        i += 1;
      } else if (c === '\n') {
        endCmd();
        i += 1;
        skipHeredocs();
      } else if (c === ';' || c === '&' || c === '|' || c === ')') {
        endCmd();
        i += 1;
      } else if (c === '(') {
        endCmd();
        i += 1;
        list(')');
      } else if (c === '`') {
        i += 1;
        inWord = true;
        list('`');
      } else if (c === '$' && src[i + 1] === '(') {
        i += 2;
        inWord = true;
        list(')');
      } else if (c === '#' && !inWord) {
        const nl = src.indexOf('\n', i);
        i = nl === -1 ? src.length : nl;
      } else if (c === '\\') {
        // A backslash-newline is a line continuation; anything else is literal.
        if (src[i + 1] !== '\n') {
          word += src[i + 1] ?? '';
          inWord = true;
        }
        i += 2;
      } else if (c === "'") {
        const close = src.indexOf("'", i + 1);
        const end = close === -1 ? src.length : close;
        word += src.slice(i + 1, end);
        inWord = true;
        i = end + 1;
      } else if (c === '"') {
        i += 1;
        inWord = true;
        while (i < src.length && src[i] !== '"') {
          if (src[i] === '\\') {
            word += src[i + 1] ?? '';
            i += 2;
          } else if (src[i] === '$' && src[i + 1] === '(') {
            i += 2;
            list(')');
          } else if (src[i] === '`') {
            i += 1;
            list('`');
          } else {
            word += src[i];
            i += 1;
          }
        }
        i += 1;
      } else if (c === '<' && src.startsWith('<<', i) && !src.startsWith('<<<', i)) {
        endWord();
        i += 2;
        const strip = src[i] === '-';
        if (strip) i += 1;
        while (src[i] === ' ' || src[i] === '\t') i += 1;
        const m = /^[^\s;&|()<>]+/.exec(src.slice(i));
        if (m) {
          heredocs.push({ delim: m[0].replace(/["'\\]/g, ''), strip });
          i += m[0].length;
        }
      } else {
        word += c;
        inWord = true;
        i += 1;
      }
    }
    endCmd();
  };

  list(null);
  return out;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Words that sit in front of a command without changing which one runs. */
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', 'exec', 'nohup', 'builtin']);
/**
 * Wrappers that run their argument as a command, and which of their options
 * take a separate value. Anything else starting with `-` is a flag.
 */
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U']),
  doas: new Set(['-u', '-C']),
  env: new Set(['-u', '-C', '-S']),
  command: new Set(),
  time: new Set(['-f', '-o']),
  nice: new Set(['-n']),
  xargs: new Set(['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a']),
  timeout: new Set(['-s', '-k']),
};
/** `git` options that take a separate value, before the subcommand. */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);

const base = (word: string) => word.replace(/^.*[/\\]/, '').replace(/\.exe$/i, '');

function commits(words: Words, depth: number): boolean {
  let k = 0;
  // Peel prefixes until the word that actually runs.
  for (;;) {
    const w = words[k];
    if (w === undefined) return false;
    if (ASSIGNMENT.test(w) || KEYWORDS.has(w)) {
      k += 1;
      continue;
    }
    const wrapper = WRAPPERS[base(w)];
    if (!wrapper) break;
    k += 1;
    // `timeout 10 git commit`: the duration is its first bare argument.
    let needsDuration = base(w) === 'timeout';
    for (let a = words[k]; a !== undefined; a = words[k]) {
      if (a.startsWith('-') && a !== '-') k += wrapper.has(a) ? 2 : 1;
      else if (ASSIGNMENT.test(a)) k += 1;
      else if (needsDuration) {
        needsDuration = false;
        k += 1;
      } else break;
    }
  }

  const cmd = base(words[k] ?? '');
  const args = words.slice(k + 1);

  if ((SHELLS.has(cmd) || cmd === 'eval') && depth < 4) {
    let script: string | undefined;
    if (cmd === 'eval') script = args.join(' ');
    else {
      const flag = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
      if (flag !== -1) script = args.slice(flag + 1).find((a) => !a.startsWith('-'));
    }
    return script !== undefined && isCommitCommand(script, depth + 1);
  }

  if (cmd !== 'git') return false;
  let j = 0;
  for (let a = args[j]; a?.startsWith('-'); a = args[j]) j += GIT_VALUE_OPTS.has(a) ? 2 : 1;
  const sub = args[j];
  if (sub === 'commit') return true;
  return sub === 'merge' && args.slice(j + 1).includes('--continue');
}

/**
 * True when running `command` would create a commit. Never throws: any
 * internal failure answers false, so the gate fails open.
 */
export function isCommitCommand(command: string, depth = 0): boolean {
  try {
    return simpleCommands(command).some((words) => commits(words, depth));
  } catch {
    return false;
  }
}
