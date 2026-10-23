import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isValidSlug, normalizeSlug } from '../src/slug.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtures = path.join(repo, 'eval', 'fixtures');

interface Fixture {
  id: string;
  source: string;
  diff: string;
  concepts: { slug: string; domain: string; tier: number; description: string; context: string }[];
  mastered?: { slug: string; domain: string; tier: number }[];
}

/** The extraction eval's examples: the original four beside `extraction/`, the same shape. */
function load(): Fixture[] {
  const dirs = [fixtures, path.join(fixtures, 'extraction')];
  return dirs.flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json') && f !== 'splits.json')
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
      .filter((d) => d && typeof d === 'object' && Array.isArray(d.concepts) && typeof d.diff === 'string'),
  );
}

describe('extraction eval fixtures', () => {
  const all = load();
  const splits = JSON.parse(fs.readFileSync(path.join(fixtures, 'extraction', 'splits.json'), 'utf8')) as Record<string, string[]>;

  it('has 19 fixtures, each in exactly one split', () => {
    expect(all).toHaveLength(19);
    const assigned = [...splits.train, ...splits.val, ...splits.test];
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(new Set(assigned)).toEqual(new Set(all.map((f) => f.id)));
    expect([splits.train.length, splits.val.length, splits.test.length]).toEqual([8, 3, 8]);
  });

  it('labels every fixture with valid, distinct slugs, a description and a context naming the code', () => {
    for (const f of all) {
      expect(f.concepts.length, f.id).toBeGreaterThanOrEqual(2);
      const slugs = f.concepts.map((c) => c.slug);
      expect(new Set(slugs).size, f.id).toBe(slugs.length);
      for (const c of f.concepts) {
        expect(isValidSlug(normalizeSlug(c.slug)), `${f.id}/${c.slug}`).toBe(true);
        expect(c.tier).toBeGreaterThanOrEqual(1);
        expect(c.tier).toBeLessThanOrEqual(5);
        expect(c.description.length, `${f.id}/${c.slug}`).toBeGreaterThan(30);
        expect(c.context.length, `${f.id}/${c.slug}`).toBeGreaterThan(20);
      }
    }
  });

  it('never labels a concept the learner has already mastered', () => {
    const withProfile = all.filter((f) => f.mastered);
    expect(withProfile.length).toBeGreaterThanOrEqual(2);
    for (const f of withProfile) {
      for (const m of f.mastered!) expect(f.concepts.map((c) => c.slug), f.id).not.toContain(m.slug);
    }
  });

  it('covers more than node-backend', () => {
    const kinds = new Set(load().map((f) => (f as Fixture & { kind?: string }).kind));
    for (const kind of ['front-end', 'ci-shell', 'migration', 'refactor', 'mastered']) expect(kinds.has(kind), kind).toBe(true);
  });

  it('keeps the tutor guidance block the eval replaces findable', () => {
    const skill = fs.readFileSync(path.join(repo, 'skills', 'tutor', 'SKILL.md'), 'utf8');
    const start = skill.indexOf('Call `log_session_concepts` as you implement');
    const end = skill.indexOf('\n## Which one is asking', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
  });
});
