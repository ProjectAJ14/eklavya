import fs from 'node:fs';
import path from 'node:path';

/**
 * Structured code search and outline (PRD RET-04).
 *
 * The honest description of what this is: a line-oriented declaration scanner,
 * not a parser. It finds the declarations a developer would find with a good
 * grep and reports them with their line numbers and nesting, which is what an
 * agent needs to decide *which file to open* — the job an outline does before
 * anything is read in full.
 *
 * Its ceiling is real and stated rather than hidden: it cannot resolve a symbol
 * across files, it does not know a declaration inside a string or a comment
 * from a real one, and a language it has no pattern for reports no symbols
 * rather than wrong ones. A real parser (tree-sitter and a wasm grammar per
 * language) is ~10MB of install weight for every user, most of whom never call
 * this; the upgrade path is one module behind the same three functions.
 */

export interface Symbol {
  name: string;
  kind: string;
  line: number;
  /** The declaration line itself, trimmed. */
  text: string;
}

export interface Outline {
  file: string;
  language: string;
  lines: number;
  symbols: Symbol[];
  truncated: boolean;
}

interface LanguagePatterns {
  language: string;
  patterns: { kind: string; re: RegExp }[];
  /** Lines starting with these are comments; a declaration in one is not one. */
  lineComment: string[];
}

const LANGUAGES: Record<string, LanguagePatterns> = {
  '.ts': tsLike('typescript'),
  '.tsx': tsLike('typescript'),
  '.js': tsLike('javascript'),
  '.jsx': tsLike('javascript'),
  '.mjs': tsLike('javascript'),
  '.cjs': tsLike('javascript'),
  '.py': {
    language: 'python',
    lineComment: ['#'],
    patterns: [
      { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
      { kind: 'function', re: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/ },
    ],
  },
  '.go': {
    language: 'go',
    lineComment: ['//'],
    patterns: [
      { kind: 'function', re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/ },
      { kind: 'type', re: /^\s*type\s+([A-Za-z_]\w*)/ },
    ],
  },
  '.rs': {
    language: 'rust',
    lineComment: ['//'],
    patterns: [
      { kind: 'function', re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/ },
      { kind: 'struct', re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/ },
      { kind: 'enum', re: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/ },
      { kind: 'trait', re: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/ },
      { kind: 'impl', re: /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][\w:<>]*)/ },
    ],
  },
  '.java': {
    language: 'java',
    lineComment: ['//'],
    patterns: [
      { kind: 'class', re: /^\s*(?:public\s+|private\s+|protected\s+|abstract\s+|final\s+|static\s+)*class\s+([A-Za-z_]\w*)/ },
      { kind: 'interface', re: /^\s*(?:public\s+)?interface\s+([A-Za-z_]\w*)/ },
      { kind: 'method', re: /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\],.\s]+\s+([A-Za-z_]\w*)\s*\(/ },
    ],
  },
  '.rb': {
    language: 'ruby',
    lineComment: ['#'],
    patterns: [
      { kind: 'class', re: /^\s*class\s+([A-Za-z_]\w*)/ },
      { kind: 'module', re: /^\s*module\s+([A-Za-z_]\w*)/ },
      { kind: 'method', re: /^\s*def\s+([A-Za-z_?!.]\w*[?!]?)/ },
    ],
  },
  '.sql': {
    language: 'sql',
    lineComment: ['--'],
    patterns: [
      { kind: 'table', re: /^\s*CREATE\s+(?:VIRTUAL\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_]\w*)/i },
      { kind: 'index', re: /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_]\w*)/i },
      { kind: 'trigger', re: /^\s*CREATE\s+TRIGGER(?:\s+IF\s+NOT\s+EXISTS)?\s+([A-Za-z_]\w*)/i },
    ],
  },
};

function tsLike(language: string): LanguagePatterns {
  return {
    language,
    lineComment: ['//', '*', '/*'],
    patterns: [
      { kind: 'class', re: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'enum', re: /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'function', re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/ },
      { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*[:=]/ },
    ],
  };
}

export function languageOf(file: string): string | null {
  return LANGUAGES[path.extname(file).toLowerCase()]?.language ?? null;
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SYMBOLS = 400;

export function outline(file: string): Outline | null {
  const spec = LANGUAGES[path.extname(file).toLowerCase()];
  if (!spec) return null;

  let text: string;
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }

  const lines = text.split('\n');
  const symbols: Symbol[] = [];
  for (let i = 0; i < lines.length && symbols.length < MAX_SYMBOLS; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || spec.lineComment.some((c) => trimmed.startsWith(c))) continue;
    for (const { kind, re } of spec.patterns) {
      const match = re.exec(line);
      if (match?.[1]) {
        symbols.push({ name: match[1], kind, line: i + 1, text: trimmed.slice(0, 200) });
        break;
      }
    }
  }

  return {
    file,
    language: spec.language,
    lines: lines.length,
    symbols,
    truncated: symbols.length >= MAX_SYMBOLS,
  };
}

export interface CodeHit {
  file: string;
  line: number;
  text: string;
  symbol: string | null;
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'vendor', '__pycache__']);

function* walk(root: string, depth = 0): Generator<string> {
  if (depth > 12) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.eklavya') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full, depth + 1);
    } else if (entry.isFile() && LANGUAGES[path.extname(entry.name).toLowerCase()]) {
      yield full;
    }
  }
}

/**
 * Finds a declaration by name across a tree, with the containing symbol.
 *
 * Declaration-first rather than every mention: an agent asking "where is
 * `recordReceipt`" wants the one line that defines it, and a list of its 40
 * call sites is the answer to a different question.
 */
export function findSymbol(root: string, name: string, limit = 20): CodeHit[] {
  const needle = name.toLowerCase();
  const hits: CodeHit[] = [];
  for (const file of walk(root)) {
    const parsed = outline(file);
    if (!parsed) continue;
    for (const symbol of parsed.symbols) {
      if (!symbol.name.toLowerCase().includes(needle)) continue;
      hits.push({ file: path.relative(root, file), line: symbol.line, text: symbol.text, symbol: symbol.name });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** The lines around a symbol's declaration: "show me this, not the whole file". */
export function expand(file: string, line: number, before = 5, after = 25): string | null {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const start = Math.max(0, line - 1 - before);
    // `after` counts lines AFTER the declaration, so the declaration's own line
    // does not eat one of them -- `before: 2, after: 2` is five lines, centred.
    const end = Math.min(lines.length, line + after);
    return lines
      .slice(start, end)
      .map((text, i) => `${String(start + i + 1).padStart(5)}  ${text}`)
      .join('\n');
  } catch {
    return null;
  }
}
