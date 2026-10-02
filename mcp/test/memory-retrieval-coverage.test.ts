import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { recallForPrompt } from '../src/memory/recall.js';
import { deleteEntry, insertEntry, supersedeEntry } from '../src/memory/store.js';
import { search, semanticSearch } from '../src/memory/search.js';
import { estimateTokens } from '../src/memory/tokens.js';

/**
 * Issue #83: what the automatic prompt recall and explicit search find, case by
 * case, on one synthetic project. Each case says what it pins; the two that
 * record a limit of the local embedder say so rather than pass for a feature.
 */

const P = '/tmp/coverage-repo';
const OTHER = '/tmp/coverage-other';
let dbFile = '';
let db: DB;
let ids: Record<string, number>;
let session = 0;

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString();
const recalled = (prompt: string) =>
  recallForPrompt(db, structuredClone(DEFAULT_CONFIG), { project: P, sessionId: `s${session++}`, prompt });
const recalledIds = (prompt: string) => recalled(prompt)?.entries.map((e) => e.id) ?? [];
const searched = (query: string, limit = 6) => search(db, query, 'hybrid', { project: P, limit }).map((h) => h.entry.id);

beforeEach(() => {
  dbFile = tempDbPath('retrieval-coverage');
  db = openDb(dbFile);
  const add = (project: string, title: string, narrative: string, type: string, n: number, files?: string[]) =>
    insertEntry(db, { project, title, narrative, type, files, occurredAt: day(n) });
  ids = {
    csv: add(P, 'CSV export uses semicolon delimiter for the finance importer', 'The finance importer rejects comma-separated files, so exportCsv writes ; between fields.', 'decision', 1, ['src/export.js']),
    cookie: add(P, 'Refresh cookie rotated on every use for reuse detection', 'Each refresh issues a new cookie; reuse of an old one revokes the family.', 'decision', 2, ['src/auth.ts']),
    big: add(P, 'Payment webhook retries with exponential backoff', 'webhook backoff '.repeat(400), 'bugfix', 3, ['src/pay.ts']),
    stale: add(P, 'Staging deploy port is 8080', 'Deploy staging on port 8080.', 'decision', 4),
    fresh: add(P, 'Staging deploy port is 9090', 'Deploy staging on port 9090 since the proxy moved.', 'decision', 5),
    other: add(OTHER, 'CSV export uses tab delimiter', 'The other project exports with tabs.', 'decision', 6),
    gone: add(P, 'Legacy XML export removed', 'Removed the XML export.', 'change', 7),
  };
  supersedeEntry(db, ids.stale!, ids.fresh!);
  deleteEntry(db, ids.gone!);
  for (let i = 0; i < 30; i++) add(P, `Filler change ${i} to the dashboard layout`, 'Moved some panels around.', 'change', 10 + i);
});

afterEach(() => {
  db.close();
  cleanup(dbFile);
});

describe('prompt recall and search coverage', () => {
  it('recalls an old decision from a long natural-language prompt', () => {
    // Thirty newer entries in between: recency does not hide it.
    expect(recalledIds('Can you add a CSV export for the monthly report? Make sure it works with the finance importer.')).toEqual([ids.csv]);
  });

  it('finds a paraphrase by explicit search, and recalls nothing wrong for it', () => {
    // Limit of local-hash-v1: "separator" and "spreadsheet download" share no
    // tokens or four-grams with "delimiter" and "CSV export", so the automatic
    // path stays silent. It must not hand something else instead.
    const prompt = 'what separator character should the spreadsheet download use';
    expect(recalledIds(prompt).filter((id) => id !== ids.csv)).toEqual([]);
    expect(searched(prompt, 3)).toContain(ids.csv);
  });

  it('sends a large relevant entry as a marked excerpt inside the budget, not filler in its place', () => {
    const result = recalled('why does the payment webhook retry with exponential backoff')!;
    expect(result.entries.map((e) => e.id)).toEqual([ids.big]);
    expect(result.block).toContain(`[excerpt: memory_get #${ids.big} for the rest]`);
    expect(estimateTokens(result.block)).toBeLessThanOrEqual(Math.floor(DEFAULT_CONFIG.retrieval.max_tokens / 3) + 5);
  });

  it('sends a small entry whole, with no excerpt marker', () => {
    expect(recalled('how is the refresh cookie rotated on every use')!.block).not.toContain('[excerpt:');
  });

  it('recalls nothing for an unrelated prompt', () => {
    expect(recalled('write a haiku about autumn leaves falling on a quiet pond')).toBeNull();
  });

  it('recalls the correction, never the entry it superseded', () => {
    expect(recalledIds('which port does the staging deploy use these days')).toEqual([ids.fresh]);
    expect(searched('staging deploy port', 20)).not.toContain(ids.stale);
  });

  it('never recalls or finds a deleted entry', () => {
    const prompt = 'what happened to the legacy XML export we used to have';
    expect(recalledIds(prompt)).not.toContain(ids.gone);
    expect(searched(prompt, 20)).not.toContain(ids.gone);
  });

  it("keeps another project's entries out of recall and search", () => {
    const prompt = 'which delimiter does the CSV export use';
    expect(recalledIds(prompt)).not.toContain(ids.other);
    expect(searched(prompt, 50)).not.toContain(ids.other);
  });

  it('reaches an entry older than the semantic window through keyword search', () => {
    // The vector scan reads the newest N entries (5,000 in production); the
    // keyword half of hybrid search has no such window.
    expect(semanticSearch(db, 'finance importer delimiter', { project: P }, 10).map((h) => h.entry.id)).not.toContain(ids.csv);
    expect(searched('finance importer delimiter', 3)).toContain(ids.csv);
  });
});
