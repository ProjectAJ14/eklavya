import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { expand, findSymbol, languageOf, outline } from '../src/memory/code.js';
import { DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { insertEntry } from '../src/memory/store.js';
import {
  collectionEntries,
  createCollection,
  deleteCollection,
  listCollections,
  rebuildCollection,
} from '../src/memory/collections.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-code-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(rel: string, body: string): string {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

describe('code outline', () => {
  it('names the declarations in a TypeScript file with their lines', () => {
    const file = write(
      'src/auth.ts',
      ['export interface Token {', '  jti: string;', '}', '', 'export function rotate(t: Token) {', '  return t;', '}', ''].join('\n'),
    );
    const parsed = outline(file)!;
    expect(parsed.language).toBe('typescript');
    expect(parsed.symbols.map((s) => [s.kind, s.name, s.line])).toEqual([
      ['interface', 'Token', 1],
      ['function', 'rotate', 5],
    ]);
  });

  it('skips a declaration that is only mentioned in a comment', () => {
    const file = write('src/a.ts', ['// export function ghost() {}', 'export function real() {}'].join('\n'));
    expect(outline(file)!.symbols.map((s) => s.name)).toEqual(['real']);
  });

  it('reports nothing rather than something wrong for a language it cannot read', () => {
    // The honest failure. A model told "no symbols" for an unsupported language
    // must not read that as "this file declares nothing".
    const file = write('notes.txt', 'function looksLikeCode() {}');
    expect(outline(file)).toBeNull();
    expect(languageOf(file)).toBeNull();
  });

  it('reads Python, Go and SQL too', () => {
    expect(outline(write('a.py', 'class Thing:\n    def go(self):\n        pass\n'))!.symbols.map((s) => s.name)).toEqual(['Thing', 'go']);
    expect(outline(write('a.go', 'type T struct{}\nfunc Do() {}\n'))!.symbols.map((s) => s.name)).toEqual(['T', 'Do']);
    expect(
      outline(write('a.sql', 'CREATE TABLE IF NOT EXISTS memory_entries (\n  id INTEGER\n);\n'))!.symbols.map((s) => s.name),
    ).toEqual(['memory_entries']);
  });
});

describe('finding a symbol across a tree', () => {
  it('finds the declaration and reports a repo-relative path', () => {
    write('src/deep/store.ts', 'export function recordReceipt() {}\n');
    write('src/other.ts', 'recordReceipt();\n');
    const hits = findSymbol(root, 'recordReceipt');
    // The call site in other.ts is deliberately not a hit: it is a mention.
    expect(hits).toHaveLength(1);
    expect(hits[0]!.file).toBe(path.join('src', 'deep', 'store.ts'));
    expect(hits[0]!.line).toBe(1);
  });

  it('never walks into node_modules or .git', () => {
    write('node_modules/pkg/index.js', 'function recordReceipt() {}\n');
    write('.git/hooks/x.js', 'function recordReceipt() {}\n');
    expect(findSymbol(root, 'recordReceipt')).toHaveLength(0);
  });

  it('expands the lines around a declaration instead of the whole file', () => {
    const file = write('a.ts', Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`).join('\n'));
    const text = expand(file, 40, 2, 2)!;
    expect(text).toContain('line38');
    expect(text).toContain('line41');
    expect(text).not.toContain('line70');
  });
});

describe('saved collections', () => {
  let dbFile: string;
  let db: DB;
  let config: EklavyaConfig;
  const PROJECT = '/tmp/collection-repo';

  beforeEach(() => {
    dbFile = tempDbPath('eklavya-collections');
    db = openDb(dbFile);
    config = { ...DEFAULT_CONFIG };
    insertEntry(db, { project: PROJECT, title: 'Refresh cookie rotation', narrative: 'auth work', type: 'feature' });
    insertEntry(db, { project: PROJECT, title: 'WAL checkpointing', narrative: 'sqlite work', type: 'discovery' });
  });

  afterEach(() => {
    db.close();
    cleanup(dbFile);
  });

  it('saves a query and materialises its members', () => {
    createCollection(db, { name: 'auth', filter: { query: 'cookie rotation', mode: 'keyword', project: PROJECT }, project: PROJECT });
    const built = rebuildCollection(db, config, 'auth')!;
    expect(built.members).toBe(1);
    expect(collectionEntries(db, 'auth').map((e) => e.title)).toEqual(['Refresh cookie rotation']);
    expect(listCollections(db).map((c) => c.name)).toEqual(['auth']);
  });

  it('refuses a rebuild that would empty a collection that had members, and keeps the last good set', () => {
    // A rebuild finding nothing where there used to be something is far more
    // likely a broken index or a mistyped filter than a genuine emptying, and
    // overwriting on that guess destroys the collection.
    createCollection(db, { name: 'auth', filter: { query: 'cookie rotation', mode: 'keyword', project: PROJECT }, project: PROJECT });
    rebuildCollection(db, config, 'auth');

    db.prepare("UPDATE memory_collections SET filter = ? WHERE name = 'auth'").run(
      JSON.stringify({ query: 'nothing matches this at all', mode: 'keyword', project: PROJECT }),
    );
    const refused = rebuildCollection(db, config, 'auth')!;
    expect(refused.kept).toBe(true);
    expect(refused.reason).toBe('empty_rebuild_refused');
    expect(collectionEntries(db, 'auth')).toHaveLength(1);
    expect(
      (db.prepare("SELECT status FROM memory_collections WHERE name = 'auth'").get() as { status: string }).status,
    ).toBe('failed');

    const forced = rebuildCollection(db, config, 'auth', { force: true })!;
    expect(forced.kept).toBe(false);
    expect(collectionEntries(db, 'auth')).toHaveLength(0);
  });

  it('deletes a collection without deleting the entries it pointed at', () => {
    createCollection(db, { name: 'auth', filter: { query: 'cookie', mode: 'keyword', project: PROJECT }, project: PROJECT });
    rebuildCollection(db, config, 'auth');
    expect(deleteCollection(db, 'auth')).toBe(true);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM memory_entries').get() as { n: number }).n,
    ).toBe(2);
  });

  it('returns null rather than throwing for a collection that is not there', () => {
    expect(rebuildCollection(db, config, 'missing')).toBeNull();
  });
});
