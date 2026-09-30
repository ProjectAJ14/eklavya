import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { expand, findSymbol, languageOf, outline } from '../src/memory/code.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-code-cov-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

describe('code lookup edges', () => {
  it('has no language for an unknown extension', () => {
    expect(languageOf('notes.txt')).toBeNull();
    expect(languageOf('a.TS')).toBe('typescript');
  });

  it('declines files over 2MB and files it cannot read', () => {
    const big = write('big.ts', `export function huge() {}\n${'x'.repeat(2 * 1024 * 1024)}`);
    expect(outline(big)).toBeNull();
    fs.mkdirSync(path.join(root, 'dir.ts'));
    expect(outline(path.join(root, 'dir.ts'))).toBeNull();
    // The oversize file is skipped during the walk rather than failing it.
    write('small.ts', 'export function huge2() {}\n');
    expect(findSymbol(root, 'huge').map((h) => h.symbol)).toEqual(['huge2']);
  });

  it('returns nothing for a missing root and stops descending after 12 levels', () => {
    expect(findSymbol(path.join(root, 'missing'), 'x')).toEqual([]);
    const deep = Array.from({ length: 14 }, (_, i) => `d${i}`).join('/');
    write(`${deep}/buried.ts`, 'export function buried() {}\n');
    write('d0/shallow.ts', 'export function buriedShallow() {}\n');
    expect(findSymbol(root, 'buried').map((h) => h.symbol)).toEqual(['buriedShallow']);
  });

  it('skips non-matching symbols and stops at the limit', () => {
    write('a.ts', ['export function alpha() {}', 'export function beta1() {}', 'export function beta2() {}'].join('\n'));
    expect(findSymbol(root, 'beta', 1)).toEqual([
      { file: 'a.ts', line: 2, text: 'export function beta1() {}', symbol: 'beta1' },
    ]);
  });

  it('expands nothing for a missing file', () => {
    expect(expand(path.join(root, 'nope.ts'), 1)).toBeNull();
  });
});
