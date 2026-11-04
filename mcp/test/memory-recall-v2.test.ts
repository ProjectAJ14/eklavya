import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type DB } from '../src/db.js';
import { cleanup, tempDbPath } from './helpers.js';
import { coerce, DEFAULT_CONFIG, type EklavyaConfig } from '../src/config.js';
import { MIN_COSINE, TERMS_SHARE, recall, recallForPrompt, termsGate } from '../src/memory/recall.js';
import { insertEntry, reembedLegacy, replaceEntry } from '../src/memory/store.js';
import { embedLocal, embedLocalV2, LOCAL_DIM, LOCAL_DIM_V2, LOCAL_EMBEDDER, LOCAL_EMBEDDER_V2, toBlob } from '../src/memory/embed.js';
import { keywordSearch, semanticSearch, termRarity } from '../src/memory/search.js';
import { informativeTermGroups, informativeTerms, splitIdentifier } from '../src/memory/terms.js';
import { branchWords, nextStepsOf, porcelainFiles, seamParts, seamQueryOf } from '../src/memory/seam.js';
import { RECEIPT_HINT, pullLine } from '../src/memory/tokens.js';
import { trimToLimits } from '../src/memory/provider.js';

const PROJECT = '/tmp/recall-v2';
const config = (patch: (c: EklavyaConfig) => void = () => {}): EklavyaConfig => {
  const c = structuredClone(DEFAULT_CONFIG);
  patch(c);
  return c;
};

let dbFile: string;
let db: DB;
beforeEach(() => {
  dbFile = tempDbPath('eklavya-recall-v2');
  db = openDb(dbFile);
});
afterEach(() => {
  if (db.open) db.close();
  cleanup(dbFile);
});

const at = (day: number, minute = 0) => new Date(Date.UTC(2026, 9, day, 10, minute)).toISOString();

describe('informative terms', () => {
  it('drops stopwords and request filler, keeps identifiers whole and split', () => {
    expect(informativeTerms('can you please look at why fetchUserById keeps timing out')).toEqual([
      'fetchuserbyid',
      'fetch',
      'user',
      'timing',
    ]);
  });

  it('keeps a path as its file stem and the parts of each segment', () => {
    expect(informativeTerms('fix src/memory/recall.ts and README.md')).toEqual(['recall', 'src', 'memory', 'readme']);
  });

  it('splits snake and kebab case, drops numbers and short words', () => {
    expect(informativeTerms('rate_limit max-retries 404 on io')).toEqual(['ratelimit', 'rate', 'limit', 'maxretries', 'max', 'retries']);
    expect(splitIdentifier('HTTPServerError')).toEqual(['http', 'server', 'error']);
  });

  it('returns nothing for pure filler and punctuation', () => {
    expect(informativeTerms('yes, ok! ... "" thanks')).toEqual([]);
  });
});

describe('local-hash-v2', () => {
  it('has 1,024 normalised dimensions and ignores stopwords', () => {
    const v = embedLocalV2('the retry backoff');
    expect(v.length).toBe(LOCAL_DIM_V2);
    expect(Array.from(v).reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 5);
    expect(Array.from(embedLocalV2('retry backoff'))).toEqual(Array.from(v));
    expect(Array.from(embedLocalV2('the and of')).every((x) => x === 0)).toBe(true);
  });

  it('weights a term when asked', () => {
    const plain = embedLocalV2('retry backoff');
    const weighted = embedLocalV2('retry backoff', (t) => (t === 'retry' ? 5 : 1));
    expect(Array.from(weighted)).not.toEqual(Array.from(plain));
  });
});

describe('vectors during the switch', () => {
  const legacy = (id: number, text: string) => {
    db.prepare('DELETE FROM memory_vectors WHERE entry_id = ?').run(id);
    db.prepare('INSERT INTO memory_vectors (entry_id, embedder_id, dim, vec) VALUES (?, ?, ?, ?)').run(
      id,
      LOCAL_EMBEDDER,
      LOCAL_DIM,
      toBlob(embedLocal(text)),
    );
  };

  it('writes both vectors for a new entry, and a replace keeps both', () => {
    const id = insertEntry(db, { project: PROJECT, title: 'Retry backoff with jitter' });
    legacy(id, 'Retry backoff with jitter');
    replaceEntry(db, id, { project: PROJECT, title: 'Retry backoff with full jitter', keywords: ['Exponential'] });
    const rows = db.prepare('SELECT embedder_id FROM memory_vectors WHERE entry_id = ? ORDER BY embedder_id').all(id);
    expect(rows).toEqual([{ embedder_id: LOCAL_EMBEDDER }, { embedder_id: LOCAL_EMBEDDER_V2 }]);
    expect(db.prepare('SELECT keywords FROM memory_entries WHERE id = ?').get(id)).toEqual({ keywords: '["exponential"]' });
  });

  it('compares each entry with the query embedded its own way, and re-embeds legacy entries', () => {
    const a = insertEntry(db, { project: PROJECT, title: 'Retry backoff with jitter', occurredAt: at(1) });
    const b = insertEntry(db, {
      project: PROJECT,
      title: 'Cache warmup',
      facts: ['warm the cache'],
      files: ['src/cache.ts'],
      keywords: ['preload'],
      occurredAt: at(2),
    });
    legacy(a, 'Retry backoff with jitter');
    legacy(b, 'Cache warmup');
    const c = insertEntry(db, { project: PROJECT, title: 'Retry jitter tuning', occurredAt: at(3) });
    // The default compares on v1 alone, so an upgrade changes nothing.
    expect(semanticSearch(db, 'retry backoff', { project: PROJECT }).every((h) => h.embedder === LOCAL_EMBEDDER)).toBe(true);
    const hits = semanticSearch(db, 'retry backoff', { project: PROJECT, embedder: 'v2' });
    expect(hits.find((h) => h.entry.id === a)?.embedder).toBe(LOCAL_EMBEDDER);
    expect(hits.find((h) => h.entry.id === c)?.embedder).toBe(LOCAL_EMBEDDER_V2);

    expect(reembedLegacy(db, 1)).toBe(1);
    expect(reembedLegacy(db)).toBe(1);
    expect(reembedLegacy(db)).toBe(0);
    const after = semanticSearch(db, 'retry backoff', { project: PROJECT, embedder: 'v2' });
    expect(after.every((h) => h.embedder === LOCAL_EMBEDDER_V2)).toBe(true);
    // The v1 vectors stay, so switching back is never one-way.
    expect(db.prepare('SELECT COUNT(*) AS n FROM memory_vectors WHERE embedder_id = ?').get(LOCAL_EMBEDDER)).toEqual({ n: 3 });
  });

  it('holds each embedder to its own cut-off before the list is cut', () => {
    const a = insertEntry(db, { project: PROJECT, title: 'Retry backoff with jitter', occurredAt: at(1) });
    legacy(a, 'Retry backoff with jitter');
    insertEntry(db, { project: PROJECT, title: 'Retry jitter tuning', occurredAt: at(2) });
    const all = semanticSearch(db, 'retry backoff', { project: PROJECT, embedder: 'v2' });
    expect(all.map((h) => h.embedder).sort()).toEqual([LOCAL_EMBEDDER, LOCAL_EMBEDDER_V2]);
    // A v1 cut-off nothing reaches leaves the v2 hit, even with one place.
    const held = semanticSearch(db, 'retry backoff', { project: PROJECT, embedder: 'v2', limit: 1, minScore: { [LOCAL_EMBEDDER]: 2 } });
    expect(held.map((h) => h.embedder)).toEqual([LOCAL_EMBEDDER_V2]);
  });

  it('caps and normalises stored keywords, and keeps none as null', () => {
    const many = Array.from({ length: 20 }, (_, i) => ` Word${i} `);
    const id = insertEntry(db, { project: PROJECT, title: 'Many', keywords: [...many, 'word0', ''] });
    expect(JSON.parse((db.prepare('SELECT keywords FROM memory_entries WHERE id = ?').get(id) as { keywords: string }).keywords)).toHaveLength(16);
    const none = insertEntry(db, { project: PROJECT, title: 'None', keywords: [' '] });
    expect(db.prepare('SELECT keywords FROM memory_entries WHERE id = ?').get(none)).toEqual({ keywords: null });
  });

  it('indexes keywords for keyword search', () => {
    const id = insertEntry(db, { project: PROJECT, title: 'Rotate refresh tokens', keywords: ['logout', 'session cookie'] });
    expect(keywordSearch(db, 'logout', { project: PROJECT }).map((h) => h.entry.id)).toEqual([id]);
  });
});

describe('rarity and OR search', () => {
  it('weighs a rare term above a common one, and an unparsable term as unseen', () => {
    for (let i = 0; i < 5; i++) insertEntry(db, { project: PROJECT, title: `Order change ${i}` });
    insertEntry(db, { project: PROJECT, title: 'Idempotency key collision' });
    const r = termRarity(db, ['order', 'idempotency', 'unseen']);
    expect(r.get('idempotency')!).toBeGreaterThan(r.get('order')!);
    expect(r.get('unseen')!).toBeGreaterThan(r.get('idempotency')!);
    expect(termRarity(db, [])).toEqual(new Map());
    db.exec('DROP TABLE memory_fts');
    // A broken index: every term reads as unseen rather than throwing.
    expect(termRarity(db, ['order']).get('order')).toBeCloseTo(Math.log(1 + 6));
  });

  it('matches any term in `any` mode, and nothing for a query with no terms', () => {
    const a = insertEntry(db, { project: PROJECT, title: 'Retry backoff' });
    const b = insertEntry(db, { project: PROJECT, title: 'Cache warmup' });
    expect(keywordSearch(db, 'retry cache', { project: PROJECT, any: true }).map((h) => h.entry.id).sort()).toEqual([a, b]);
    expect(keywordSearch(db, '!!', { project: PROJECT, any: true })).toEqual([]);
  });
});

describe('the terms prompt gate', () => {
  it('keeps an entry with two informative terms, or one carrying most of the rarity, and drops a single common match', () => {
    for (let i = 0; i < 6; i++) insertEntry(db, { project: PROJECT, title: `Order list tweak ${i}`, occurredAt: at(1, i) });
    const two = insertEntry(db, { project: PROJECT, title: 'Payment retry backoff', files: ['src/payments/retry.ts'], occurredAt: at(2) });
    const rare = insertEntry(db, { project: PROJECT, title: 'fetchUserById timeout', occurredAt: at(3) });
    const scope = { project: PROJECT };
    expect(termsGate(db, 'the payment retry is hammering the provider', scope).map((h) => h.entry.id)).toEqual([two]);
    expect(termsGate(db, 'fetchUserById', scope).map((h) => h.entry.id)).toEqual([rare]);
    // "order" is in six entries and the prompt's other terms are in none.
    expect(termsGate(db, 'order zebra giraffe', scope)).toEqual([]);
    expect(termsGate(db, 'yes ok thanks', scope)).toEqual([]);
    expect(TERMS_SHARE).toBe(0.6);
  });

  it('counts an identifier or a path as one word, and matches whole terms only', () => {
    for (let i = 0; i < 6; i++) {
      insertEntry(db, { project: PROJECT, title: `Tweak ${i}`, files: [`mcp/src/memory/other${i}.ts`], occurredAt: at(1, i) });
    }
    const user = insertEntry(db, { project: PROJECT, title: 'fetchUser cache', occurredAt: at(2) });
    const catalog = insertEntry(db, { project: PROJECT, title: 'Catalog latest', occurredAt: at(3) });
    const scope = { project: PROJECT };
    // One path: its segments are in every entry, but it is one word of the prompt, and not the rare one.
    expect(termsGate(db, 'look at mcp/src/memory/recall.ts and widget zebra', scope)).toEqual([]);
    // `fetchUser` is one word however it splits; with a second word it passes.
    expect(termsGate(db, 'fetchUser zebra giraffe ostrich', scope)).toEqual([]);
    expect(termsGate(db, 'fetchUser cache zebra giraffe', scope).map((h) => h.entry.id)).toEqual([user]);
    // "log" and "test" are not in "catalog" and "latest".
    expect(termsGate(db, 'log test zebra', scope).map((h) => h.entry.id)).not.toContain(catalog);
    expect(informativeTermGroups('fetchUser in src/a.ts, fetchUser')).toEqual([['fetchuser', 'fetch', 'user'], ['src']]);
  });

  it('opens a prompt recall that the strict gate leaves shut', () => {
    insertEntry(db, {
      project: PROJECT,
      sessionId: 'old',
      title: 'Payment retry backoff with jitter',
      narrative: 'Backs off exponentially.',
      occurredAt: at(2),
    });
    const prompt = 'can you look at why the payment retry keeps hammering the provider again today';
    const strict = recallForPrompt(db, config((c) => (c.retrieval.prompt_gate = 'strict')), { project: PROJECT, sessionId: 's-strict', prompt });
    const terms = recallForPrompt(db, config((c) => (c.retrieval.prompt_gate = 'terms')), { project: PROJECT, sessionId: 's-terms', prompt });
    expect(strict).toBeNull();
    expect(terms?.entries.map((e) => e.title)).toEqual(['Payment retry backoff with jitter']);
  });

  it('has one cosine floor per embedder', () => {
    expect(MIN_COSINE[LOCAL_EMBEDDER]).toBe(0.35);
    expect(MIN_COSINE[LOCAL_EMBEDDER_V2]).toBe(0.25);
  });
});

describe('the seam query', () => {
  it('reads words from a branch, files from porcelain and next steps from a checkpoint', () => {
    expect(branchWords('feat/retry-backoff')).toBe('retry backoff');
    expect(branchWords('main')).toBeNull();
    expect(branchWords('HEAD')).toBeNull();
    expect(branchWords(null)).toBeNull();
    expect(branchWords('fix/')).toBeNull();
    expect(porcelainFiles(' M src/a.ts\nR  old.ts -> new.ts\n?? "spaced name.ts"\n M src/a.ts\n\nx')).toEqual(['src/a.ts', 'new.ts', 'spaced name.ts']);
    expect(nextStepsOf('Request: x\n\nNext steps: revisit retry.ts\n\nOther: y')).toBe('revisit retry.ts');
    expect(nextStepsOf('Request: x')).toBeNull();
    expect(seamQueryOf({ branch: null, files: [], commits: [], nextSteps: null })).toBeNull();
    expect(seamQueryOf({ branch: 'retry', files: ['a.ts'], commits: ['fix: b'], nextSteps: 'c' })).toBe('retry a.ts fix: b c');
  });

  it('reads git state from a checkout, within its time budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-seam-'));
    try {
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
      git('init', '-q', '-b', 'feat/retry-backoff');
      git('-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'fix: payment retry');
      fs.writeFileSync(path.join(dir, 'retry.ts'), 'x');
      insertEntry(db, { project: PROJECT, sessionId: 'mine', kind: 'session_summary', title: 'mine', narrative: 'Next steps: not this', occurredAt: at(5) });
      insertEntry(db, { project: PROJECT, sessionId: 'prev', kind: 'session_summary', title: 'prev', narrative: 'Next steps: tune jitter', occurredAt: at(4) });
      const parts = seamParts(db, { cwd: dir, project: PROJECT, sessionId: 'mine' });
      expect(parts).toEqual({ branch: 'retry backoff', files: ['retry.ts'], commits: ['fix: payment retry'], nextSteps: 'tune jitter' });

      // A spent budget leaves git out; no checkout at all leaves it out too.
      let t = 0;
      const clock = () => (t += 2000);
      expect(seamParts(db, { cwd: dir, project: PROJECT }, clock)).toMatchObject({ branch: null, files: [], commits: [] });
      expect(seamParts(db, { cwd: path.join(dir, 'missing'), project: PROJECT })).toMatchObject({ branch: null, files: [], commits: [] });
      expect(seamParts(db, { cwd: null, project: '/elsewhere' })).toEqual({ branch: null, files: [], commits: [], nextSteps: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('puts an old matching entry in full ahead of sixty newer ones', () => {
    const old = insertEntry(db, {
      project: PROJECT,
      sessionId: 'early',
      title: 'Exponential backoff with jitter for the payment retry',
      files: ['src/payments/retry.ts'],
      occurredAt: at(1),
    });
    for (let i = 0; i < 60; i++) {
      insertEntry(db, { project: PROJECT, sessionId: `s${i}`, title: `Admin layout tweak ${i}`, occurredAt: at(10, i) });
    }
    const off = recall(db, config(), { project: PROJECT, index: true });
    expect(off.entries.map((e) => e.id)).not.toContain(old);
    const on = recall(db, config((c) => (c.retrieval.seam_query = true)), {
      project: PROJECT,
      index: true,
      seamQuery: 'payment retry backoff src/payments/retry.ts',
    });
    expect(on.entries[0]!.id).toBe(old);
    expect(on.block).toContain('Closest to the current work, in full:');
    // No match: newest first, as without a query.
    const none = recall(db, config(), { project: PROJECT, index: true, seamQuery: 'zebra giraffe' });
    expect(none.block).toContain('Latest, in full:');
  });

  it('sizes the timeline from retrieval.timeline_items, and leaves it out at 0', () => {
    for (let i = 0; i < 12; i++) insertEntry(db, { project: PROJECT, sessionId: `s${i}`, title: `Work item ${i}`, occurredAt: at(3, i) });
    const lines = (n: number) =>
      (recall(db, config((c) => (c.retrieval.timeline_items = n)), { project: PROJECT, index: true }).block ?? '')
        .split('\n')
        .filter((l) => /^\[#\d+\] .* · /.test(l)).length;
    expect(lines(3)).toBe(3);
    expect(lines(0)).toBe(0);
  });
});

describe('the lookup hint', () => {
  it('names the Bash command when memory.lookup_hint is bash', () => {
    expect(RECEIPT_HINT(7, [], 'bash')).toContain('`eklavya memory show <id>` in Bash.');
    expect(RECEIPT_HINT(7)).toContain('memory_get({ids: [<id>], receipt_id: 7})');
    expect(pullLine(2000, 'bash')).toContain('eklavya memory search');
    insertEntry(db, { project: PROJECT, sessionId: 'a', title: 'Something done', occurredAt: at(1) });
    const block = recall(db, config((c) => (c.memory.lookup_hint = 'bash')), { project: PROJECT, index: true }).block!;
    expect(block).toContain('eklavya memory show');
    expect(block).not.toContain('memory_get(');
  });
});

describe('config keys', () => {
  it('default prompt_gate to terms, keep seam_query and lookup_hint off, and coerce only valid values', () => {
    expect(DEFAULT_CONFIG.retrieval).toMatchObject({ seam_query: false, prompt_gate: 'terms', timeline_items: 50 });
    expect(DEFAULT_CONFIG.memory.lookup_hint).toBe('mcp');
    const good = coerce({ retrieval: { seam_query: true, prompt_gate: 'strict', timeline_items: 12.7 }, memory: { lookup_hint: 'bash' } }, DEFAULT_CONFIG);
    expect(good.retrieval).toMatchObject({ seam_query: true, prompt_gate: 'strict', timeline_items: 12 });
    expect(good.memory.lookup_hint).toBe('bash');
    expect(coerce({ retrieval: { timeline_items: 900 } }, DEFAULT_CONFIG).retrieval.timeline_items).toBe(200);
    const bad = coerce({ retrieval: { seam_query: 'yes', prompt_gate: 'loose', timeline_items: -1 }, memory: { lookup_hint: 'web' } }, DEFAULT_CONFIG);
    expect(bad.retrieval).toMatchObject({ seam_query: false, prompt_gate: 'terms', timeline_items: 50 });
    expect(bad.memory.lookup_hint).toBe('mcp');
  });
});

describe('observer keywords', () => {
  it('trims keywords to their limits and leaves a missing list alone', () => {
    const raw = { observations: [{ title: 't', keywords: Array.from({ length: 20 }, () => 'k'.repeat(80)) }, { title: 'u' }] };
    const out = trimToLimits(raw) as { observations: { keywords?: string[] }[] };
    expect(out.observations[0]!.keywords).toHaveLength(12);
    expect(out.observations[0]!.keywords![0]!.length).toBe(60);
    expect(out.observations[1]!.keywords).toBeUndefined();
  });
});

vi.restoreAllMocks();
