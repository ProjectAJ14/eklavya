// Split by feature so Vitest's file sharding can divide the browser work.
//
// Phase 5 of #171, the page's half: cheaper renders. The lists the views read are built once for
// the payload and the project and kept; the sidebar keeps its elements when only the page changes;
// the heatmap draws from days it has already bucketed and labelled; a keystroke in a search box
// replaces the list and nothing else. None of it may change what the reader sees, so the tests
// hold the new code to the old one: the heatmap against the first version of its drawing, the lists
// against a fresh build, the sidebar against a page loaded at the same address.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { insertFeedback } from '../src/feedback.js';
import { OPTS, db, fx, open, pickProject, ready } from './dashboard-browser-helpers.js';

// Globals of the page under test (a script's `let` and `const` are reachable by name from `evaluate`, not from `window`).
declare const S: { concepts: { slug: string; name: string; seen: boolean; due: boolean; domain: string }[]; attempts: unknown[]; logged: unknown[]; daily: { day: string; repo: string | null; passed: number; corrected?: number; missed: number; skipped: number }[]; cursor: string };
declare const INV: { projects: { id: string }[] };
declare const PROJECT: string | null;
declare const RESP: Map<string, unknown>;
declare const DATA_GEN: number;
declare const SETS_AT: unknown;
declare const HEAT_OFF: number;
declare const HEAT_ARROWS: number;
declare const DAY_MS: number;
declare const FMT_DAY: Intl.DateTimeFormat;
declare const FMT_DAY_YEAR: Intl.DateTimeFormat;
declare const FMT_MONTH: Intl.DateTimeFormat;
declare function sessions(): { id: string }[];
declare function learningSessions(): unknown[];
declare function buildSessions(): unknown[];
declare function conceptsInScope(): unknown[];
declare function seenConcepts(): unknown[];
declare function attemptsInScope(): unknown[];
declare function loggedInScope(): unknown[];
declare function artifactsInScope(): unknown[];
declare function dailyInScope(): Map<string, { day: string; total: number; passed: number; corrected: number }>;
declare function streaks(map?: Map<string, { day: string; total: number }>): { current: number; best: number; days: number; run: Set<string>; today: boolean };
declare function lastThirty(): unknown[];
declare function navCounts(wf: string): Record<string, number>;
declare function fillDays(map: Map<string, unknown>, n: number, endKey?: string): { day: string }[];
declare function chartHeatmap(el: Element): void;
declare function chartActivity(el: Element, days: unknown[]): void;
declare function adoptState(s: unknown, inv: unknown): void;
declare function render(opts?: { nav?: boolean }): void;
declare function todayKey(): string;
declare function fromKey(k: string): Date;
declare function dayKey(d: Date): string;
declare function heatFill(step: number): string;
declare function plural(n: number, w: string): string;
declare function esc(s: unknown): string;
declare function pid(raw: unknown, sid?: unknown): string;

const HEIGHT = 900;
const html = fs.readFileSync(new URL('../src/assets/dashboard.html', import.meta.url), 'utf8');

describe('the page source', () => {
  it('assigns the payload and the inventory in one place, and the project beside the scope that follows from it', () => {
    // A kept list is only as good as the promise that nothing changes `S`, `INV` or `PROJECT` behind its back.
    const body = /function adoptState\(s, inv\) \{[\s\S]*?\n\}/.exec(html)![0];
    expect(body).toMatch(/\bS = s;/);
    expect(body).toMatch(/\bINV = inv;/);
    expect(body).toMatch(/recomputeScope\(\);/);
    expect(body).toMatch(/invalidateData\(\);/);
    const outside = html.replace(body, '');
    expect(outside.match(/^\s*(S|INV)\s*=[^=]/gm) ?? [], 'assignments of S or INV outside adoptState').toEqual([]);
    expect(outside.match(/\bObject\.assign\((S|INV)\b/g) ?? []).toEqual([]);
    const assigned = outside.match(/(?<!let )\bPROJECT = [^;\n]*;[^\n]*/g) ?? [];
    expect(assigned.length, 'assignments of PROJECT').toBe(1);
    expect(assigned[0]).toContain('recomputeScope()');
    expect(/function recomputeScope\(\) \{\s*dropDerived\(\);/.test(html), 'recomputeScope drops the kept lists first').toBe(true);
  });

  it('builds every list a view reads through derived(), so none is rebuilt from rows by a view', () => {
    for (const name of ['conceptsInScope', 'seenConcepts', 'attemptsInScope', 'loggedInScope', 'artifactsInScope', 'lastThirty', 'sessions', 'learningSessions', 'navCounts']) {
      expect(new RegExp(`const ${name} = \\(.*?\\) => derived\\('`).test(html), name).toBe(true);
    }
    expect(/function dailyInScope\(\) \{\s*return derived\('/.test(html), 'dailyInScope').toBe(true);
    // Without a map it is the kept streak in scope; with one, a plain reading of that map.
    expect(/function streaks\(map\) \{\s*if \(!map\) return derived\('streaks'/.test(html), 'streaks').toBe(true);
  });
});

/** One heatmap as the page left it: the markup of its SVG and what the arrows say. */
const drawn = (page: Page) => page.evaluate(() => {
  const el = document.getElementById('c-heat')!;
  const prev = document.getElementById('heat-prev') as HTMLButtonElement;
  const next = document.getElementById('heat-next') as HTMLButtonElement;
  return { inner: el.innerHTML, viewBox: el.getAttribute('viewBox'), width: el.getAttribute('width'), height: el.getAttribute('height'),
    arrows: { hidden: [prev.hidden, next.hidden], disabled: [prev.disabled, next.disabled], weeks: [prev.dataset.weeks, next.dataset.weeks] } };
});

/**
 * The heatmap as its first version drew it, kept here word for word as the reference: every day bucketed from
 * `S.daily` and labelled with `toLocaleDateString` on each draw. It reads the page's current window (`HEAT_OFF`)
 * and the page's own width, draws into a scratch element and reports the same things `drawn` does. The streak
 * and the daily buckets are the first versions' too, so the lists the page keeps are not an input to what they
 * are compared with.
 */
const reference = (page: Page) => page.evaluate(() => {
  const refDaily = () => {
    const m = new Map<string, any>();
    for (const d of S.daily) {
      if (PROJECT !== null && pid(d.repo) !== PROJECT) continue;
      const cur = m.get(d.day) ?? { day: d.day, passed: 0, corrected: 0, missed: 0, skipped: 0, total: 0 };
      cur.passed += d.passed; cur.corrected += d.corrected ?? 0; cur.missed += d.missed; cur.skipped += d.skipped;
      cur.total = cur.passed + cur.corrected + cur.missed + cur.skipped;
      m.set(d.day, cur);
    }
    return m;
  };
  const refStreaks = (map: Map<string, any>) => {
    const active = new Set([...map.values()].filter((d) => d.total > 0).map((d) => d.day));
    const run = new Set<string>();
    const cur = fromKey(todayKey());
    const today = active.has(dayKey(cur));
    if (!today) cur.setUTCDate(cur.getUTCDate() - 1);
    while (active.has(dayKey(cur))) { run.add(dayKey(cur)); cur.setUTCDate(cur.getUTCDate() - 1); }
    return { run };
  };

  const el = document.getElementById('c-heat')!;
  const map = refDaily();
  const run = refStreaks(map).run;
  const CELL = 13, GAP = 3, PAD_T = 18, PAD_L = 26;
  const box = el.closest('.streak__cal') ?? el.parentElement!;
  const fit = (w: number) => Math.floor((w - PAD_L - 2) / (CELL + GAP));
  const room = box.clientWidth || 700;
  const paged = fit(room) < 53;
  const weeks = paged ? Math.max(12, fit(room - HEAT_ARROWS)) : 53;
  const off = paged ? HEAT_OFF : 0;
  const today = fromKey(todayKey());
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()) - off * 7);
  const total = weeks * 7;
  const days = fillDays(map, total, dayKey(end)) as any[];
  const max = Math.max(...days.map((d) => d.total), 1);
  const year = today.getUTCFullYear();
  const label = (k: string) => fromKey(k).toLocaleDateString(undefined,
    { month: 'short', day: 'numeric', year: fromKey(k).getUTCFullYear() === year ? undefined : 'numeric', timeZone: 'UTC' });

  let out = '', lastMonth = '', lastCol = -9;
  days.forEach((d, i) => {
    const col = Math.floor(i / 7), row = i % 7;
    const x = PAD_L + col * (CELL + GAP), y = PAD_T + row * (CELL + GAP);
    if (row === 0) {
      const m = fromKey(d.day).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' });
      if (m !== lastMonth) {
        if (col < weeks - 2 && col - lastCol >= 3) { out += `<text class="axis" x="${x}" y="${PAD_T - 6}">${m}</text>`; lastCol = col; }
        lastMonth = m;
      }
    }
    const step = d.total ? Math.min(4, Math.ceil((4 * d.total) / max)) : 0;
    const fill = step ? heatFill(step) : d.day > todayKey() ? 'transparent' : 'var(--mass)';
    const on = run.has(d.day), inset = on ? 0.75 : 0;
    const title = `${label(d.day)} — ${d.total ? `${plural(d.total, 'answer')} (${d.passed + d.corrected} right)` : 'nothing'}${on ? ' · current streak' : ''}`;
    out += `<rect class="cell${on ? ' is-run' : ''}" data-step="${step}" x="${x + inset}" y="${y + inset}" width="${CELL - 2 * inset}" height="${CELL - 2 * inset}" fill="${fill}">`
         + `<title>${esc(title)}</title></rect>`;
  });
  ['Mon', 'Wed', 'Fri'].forEach((name, n) => {
    const row = [1, 3, 5][n]!;
    out += `<text class="axis" x="0" y="${PAD_T + row * (CELL + GAP) + CELL - 3}">${name}</text>`;
  });
  const W = PAD_L + weeks * (CELL + GAP), H = PAD_T + 7 * (CELL + GAP);
  const scratch = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  scratch.innerHTML = out;
  return { inner: scratch.innerHTML, viewBox: `0 0 ${W} ${H}`, width: String(W), height: String(H),
    arrows: { hidden: [!paged, !paged], disabled: [today.getTime() - fromKey(days[0]!.day).getTime() >= 365 * DAY_MS, off === 0], weeks: [String(weeks), String(weeks)] } };
});

/** The window the page shows, and the reference's, must agree on every step as the reader pages back and forward. */
async function sameHeatmap(page: Page, where: string) {
  const [real, ref] = [await drawn(page), await reference(page)];
  expect(real.viewBox, where).toBe(ref.viewBox);
  expect(real.width, where).toBe(ref.width);
  expect(real.height, where).toBe(ref.height);
  expect(real.arrows, where).toEqual(ref.arrows);
  // One cell at a time, so a difference names the day and not a 60 KB string.
  const cells = (s: string) => s.split('</rect>');
  const [a, b] = [cells(real.inner), cells(ref.inner)];
  expect(a.length, `${where}: cells`).toBe(b.length);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) expect(a[i], `${where}: cell ${i}`).toBe(b[i]);
  expect(real.inner === ref.inner, `${where}: the whole drawing`).toBe(true);
  return a.length;
}

/** Pages back as far as the arrows go and forward again, holding every window to the reference. */
async function pageThrough(page: Page, where: string) {
  let windows = 0;
  windows += await sameHeatmap(page, `${where}: open`) > 0 ? 1 : 0;
  for (const arrow of ['#heat-prev', '#heat-next']) {
    for (let i = 0; i < 12 && await page.$eval(arrow, (b) => !(b as HTMLButtonElement).hidden && !(b as HTMLButtonElement).disabled); i++) {
      await page.click(arrow);
      windows += await sameHeatmap(page, `${where}: ${arrow} ${i + 1}`) > 0 ? 1 : 0;
    }
  }
  return windows;
}

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('the heatmap and the activity chart are drawn as before, from days the page keeps', () => {
    it('draws every window the arrows reach, in every width and scope, exactly as the first version did', async () => {
      let windows = 0;
      for (const width of [1280, 900, 560, 390]) {
        const w = await open('#/learning/dashboard', { width, height: HEIGHT });
        const { page } = w;
        windows += await pageThrough(page, `${width}px, all projects`);
        // Another scope has other days in it; the days kept for the first must not leak into it.
        for (const project of [fx.repo.mixed, fx.repo.answered]) {
          // By address: at the narrow widths the project control is in the drawer.
          await page.evaluate((h) => { location.hash = h; }, `#/learning/dashboard?project=${encodeURIComponent(project)}`);
          await ready(page);
          windows += await pageThrough(page, `${width}px, ${path.basename(project)}`);
        }
        // A resize while paged redraws the window for the new width from the same days.
        await page.setViewportSize({ width: width === 1280 ? 700 : 1280, height: HEIGHT });
        await page.waitForTimeout(400);
        await sameHeatmap(page, `${width}px, resized`);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }
      // 1280px is one window; the narrower widths page back through the year in steps.
      expect(windows).toBeGreaterThanOrEqual(24);
    }, 120000);

    it('says the same words in another language: the formatters it keeps match toLocaleDateString day for day', async () => {
      for (const locale of ['en-US', 'de-DE', 'ja-JP', 'ar-EG']) {
        const w = await open('#/learning/dashboard', { width: 900, height: HEIGHT, locale });
        const { page } = w;
        await pageThrough(page, locale);
        const mismatches = await page.evaluate(() => {
          const bad: string[] = [];
          const year = fromKey(todayKey()).getUTCFullYear();
          for (let i = -800; i <= 40; i++) {
            const d = new Date(fromKey(todayKey()).getTime() + i * DAY_MS);
            const k = dayKey(d);
            const ref = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString(undefined, { ...o, timeZone: 'UTC' });
            if (FMT_DAY.format(d) !== ref({ month: 'short', day: 'numeric' })) bad.push(`${k} day`);
            if (FMT_DAY_YEAR.format(d) !== ref({ month: 'short', day: 'numeric', year: 'numeric' })) bad.push(`${k} day+year`);
            if (FMT_MONTH.format(d) !== ref({ month: 'short' })) bad.push(`${k} month`);
            if (d.getUTCFullYear() !== year && FMT_DAY_YEAR.format(d) === FMT_DAY.format(d)) bad.push(`${k} year missing`);
          }
          return bad;
        });
        expect(mismatches, locale).toEqual([]);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }
    }, 120000);

    it('draws the activity chart from the kept thirty days exactly as from days filled fresh', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      for (const project of [null, fx.repo.mixed]) {
        if (project) { await pickProject(page, project); await ready(page); }
        const r = await page.evaluate(() => {
          const el = document.getElementById('c-activity')!;
          const kept = lastThirty();
          const fresh = fillDays(dailyInScope(), 30);
          const draw = (days: unknown[]) => { chartActivity(el, days); return el.innerHTML; };
          const a = draw(kept);
          const b = draw(fresh);
          return { same: a === b, bars: a.split('<g class="col">').length - 1, days: kept.length, equal: JSON.stringify(kept) === JSON.stringify(fresh) };
        });
        expect(r).toMatchObject({ same: true, days: 30, equal: true });
        expect(r.bars).toBe(30);
      }
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);
  });

  describe('the lists the views read are built once and kept', () => {
    it('hands back the same list until the payload or the project changes, and the same list a fresh build would give', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      const read = () => page.evaluate(() => {
        const names = { sessions, learningSessions, conceptsInScope, seenConcepts, attemptsInScope, loggedInScope, artifactsInScope, lastThirty, dailyInScope, streaks } as Record<string, () => unknown>;
        const kept = Object.fromEntries(Object.entries(names).map(([k, f]) => [k, f() === f()]));
        const wf = { learning: navCounts('learning') === navCounts('learning'), memory: navCounts('memory') === navCounts('memory'), artifacts: navCounts('artifacts') === navCounts('artifacts') };
        // What is kept is what a fresh build gives: the kept sessions against the function that builds them.
        const same = JSON.stringify(sessions()) === JSON.stringify(buildSessions());
        const frozen = [sessions(), learningSessions(), conceptsInScope(), seenConcepts(), attemptsInScope(), loggedInScope(), artifactsInScope(), lastThirty(), streaks()].map((x) => Object.isFrozen(x));
        return { kept, wf, same, frozen, n: [sessions().length, conceptsInScope().length, seenConcepts().length, attemptsInScope().length] };
      });
      const all = await read();
      expect(Object.values(all.kept).every(Boolean), JSON.stringify(all.kept)).toBe(true);
      expect(Object.values(all.wf).every(Boolean)).toBe(true);
      expect(all.same).toBe(true);
      expect(all.frozen.every(Boolean)).toBe(true);
      // Given a map of days, `streaks` is a plain reading of it: not the kept one, and not memoized.
      expect(await page.evaluate(() => {
        const today = todayKey();
        const one = new Map([[today, { day: today, total: 1 }]]);
        return [streaks(one).current, streaks(one) === streaks(one), streaks(one) === streaks()];
      })).toEqual([1, false, false]);

      // Another project is another scope: new lists, with other numbers in them.
      await page.evaluate(() => { (window as any).__before = { s: sessions(), c: conceptsInScope(), d: dailyInScope(), st: streaks() }; });
      await pickProject(page, fx.repo.answered);
      await ready(page);
      const scoped = await page.evaluate(() => {
        const b = (window as any).__before;
        return { s: sessions() !== b.s, c: conceptsInScope() !== b.c, d: dailyInScope() !== b.d, st: streaks() !== b.st, fewer: sessions().length < b.s.length };
      });
      expect(scoped).toEqual({ s: true, c: true, d: true, st: true, fewer: true });
      expect((await read()).same).toBe(true);
      // And back: rebuilt for the scope the reader returned to, not a stale list.
      await pickProject(page, '');
      await ready(page);
      expect((await read()).n).toEqual(all.n);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('refuses a caller that would change a list: sorting or pushing onto one throws instead of changing what every view reads', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const r = await w.page.evaluate(() => {
        const tries: [string, () => unknown][] = [
          ['sessions.sort', () => sessions().sort()], ['concepts.push', () => (conceptsInScope() as unknown[]).push(1)],
          ['seen.reverse', () => seenConcepts().reverse()], ['attempts.pop', () => attemptsInScope().pop()],
          ['logged.splice', () => loggedInScope().splice(0, 1)], ['last30.fill', () => lastThirty().fill(0 as never)],
          ['streak.current', () => { 'use strict'; (streaks() as { current: number }).current = 99; }],
        ];
        return Object.fromEntries(tries.map(([name, f]) => { try { f(); return [name, 'changed']; } catch (e) { return [name, (e as Error).name]; } }));
      });
      expect(Object.values(r), JSON.stringify(r)).toEqual(Array(7).fill('TypeError'));
      await w.ctx.close();
    }, 30000);

    it('reads the new day after midnight: a page left open does not keep yesterday\'s streak or heatmap', async () => {
      const t0 = Date.now();
      const w = await open('#/learning/dashboard', { width: 900, height: HEIGHT, now: new Date(t0).toISOString() });
      const { page } = w;
      const first = await page.evaluate(() => ({ day: todayKey(), streak: streaks() === streaks() }));
      expect(first.streak).toBe(true);
      await page.evaluate(() => { (window as any).__s = streaks(); (window as any).__l = lastThirty(); });
      await sameHeatmap(page, 'before midnight');
      // The page is still open when the clock passes midnight and the reader moves on.
      await page.clock.setFixedTime(new Date(t0 + 36 * 3600 * 1000).toISOString());
      const next = await page.evaluate(() => ({ day: todayKey(), s: streaks() !== (window as any).__s, l: lastThirty() !== (window as any).__l, now: streaks() === streaks() }));
      expect(next.day).not.toBe(first.day);
      expect(next).toMatchObject({ s: true, l: true, now: true });
      await page.evaluate(() => chartHeatmap(document.getElementById('c-heat')!));
      await sameHeatmap(page, 'after midnight');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('swaps the payload in one place: adoptState drops every kept list and everything read under the old data', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      // Something the page read for itself, and the settings it holds.
      await page.evaluate(() => { location.hash = '#/memory/timeline'; });
      await ready(page);
      await page.evaluate(() => { location.hash = '#/learning/dashboard'; });
      await ready(page);
      const before = await page.evaluate(() => ({ cache: RESP.size, gen: DATA_GEN, concepts: conceptsInScope().length, sessions: sessions().length, counts: navCounts('learning') }));
      expect(before.cache).toBeGreaterThan(0);

      // New data arrives: fewer concepts and no logged work at all.
      await page.evaluate(() => {
        const s = structuredClone(S) as any;
        s.concepts = s.concepts.slice(0, 7);
        s.logged = [];
        s.cursor = 'a-new-cursor';
        adoptState(s, structuredClone(INV));
        render();
      });
      const after = await page.evaluate(() => ({
        cache: RESP.size, gen: DATA_GEN, settings: SETS_AT, cursor: S.cursor, concepts: conceptsInScope().length, sessions: sessions().length, counts: navCounts('learning'),
        shown: Object.fromEntries([...document.querySelectorAll('#nav a[data-nav] i')].map((i) => [i.parentElement!.getAttribute('data-nav'), i.textContent])),
      }));
      expect(after.cache, 'what was read under the old data').toBe(0);
      expect(after.gen).toBeGreaterThan(before.gen);
      expect(after.settings).toBeNull();
      expect(after.cursor).toBe('a-new-cursor');
      expect(after.concepts).toBe(7);
      expect(after.sessions).toBeLessThan(before.sessions);
      expect(after.counts.concepts).toBe(7);
      // The sidebar says what the new lists say, in place.
      expect(after.shown.concepts).toBe('7');
      expect(after.shown.sessions).toBe(String(after.counts.sessions));
      expect(await page.textContent('#view .page__title')).toBe('Am I actually getting better?');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);
  });

  describe('the sidebar keeps its elements when only the page changes', () => {
    /** Every element of the rail and of the workflow control, held so they can be asked about later. */
    const hold = (page: Page) => page.evaluate(() => {
      const els = [...document.querySelectorAll('#nav, #nav *, #wf, #wf *')];
      (window as any).__rail = els;
      return els.length;
    });
    /** The rail now: are the held elements still in the page, and is anything in it that was not held? */
    const rail = (page: Page) => page.evaluate(() => {
      const held: Element[] = (window as any).__rail;
      const now = [...document.querySelectorAll('#nav, #nav *, #wf, #wf *')];
      return { gone: held.filter((e) => !e.isConnected).length, added: now.filter((e) => !held.includes(e)).length, size: now.length };
    });
    /** What the rail says: where each link goes, which is current, its count, and which groups are open. */
    const says = (page: Page) => page.evaluate(() => ({
      links: [...document.querySelectorAll('#nav a[data-nav]')].map((a) => [a.getAttribute('data-nav'), a.getAttribute('href'), a.getAttribute('aria-current'), a.querySelector('i')?.textContent ?? null, a.querySelector('i')?.className ?? null]),
      groups: [...document.querySelectorAll('#nav [data-group]')].map((t) => [t.getAttribute('data-group'), t.getAttribute('aria-expanded'), (document.getElementById(t.getAttribute('aria-controls')!) as HTMLElement).hidden]),
      label: document.getElementById('nav')!.getAttribute('aria-label'),
      workflow: document.getElementById('wf-main')!.textContent!.trim(),
      wfHref: document.getElementById('wf-main')!.getAttribute('href'),
    }));
    /** A page loaded cold at the same address, which builds the rail from nothing: what the kept rail must say. */
    async function coldSays(hash: string, width = 1280) {
      const c = await open(hash, { width, height: HEIGHT });
      const r = await says(c.page);
      await c.ctx.close();
      return r;
    }

    it('through every page of a workflow, a project switch and a pager, saying what a cold page would say', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      const n = await hold(page);
      expect(n).toBeGreaterThan(20);
      const slug = await page.evaluate(() => S.concepts.find((c) => c.seen)!.slug);
      const steps: [string, () => Promise<unknown>][] = [
        ['a link in the rail', () => page.click('#nav [data-nav="concepts"]')],
        ['another link', () => page.click('#nav [data-nav="review"]')],
        ['a link in a group', () => page.click('#nav [data-nav="sessions"]')],
        ['a row of the list', () => page.click('#view tr.row')],
        ['the wordmark', () => page.click('#brand')],
        ['a typed address', () => page.evaluate((s) => { location.hash = `#/learning/concept/${s}`; }, slug)],
        ['Back', () => page.goBack()],
        ['a tile that is a link', () => page.click('#view .tile[data-go]')],
      ];
      for (const [what, step] of steps) {
        await step();
        await ready(page);
        const r = await rail(page);
        expect(r, what).toMatchObject({ gone: 0, added: 0, size: n });
        // Whatever it says now is what a page loaded here would say.
        const hash = await page.evaluate(() => location.hash);
        expect(await says(page), `${what}: ${hash}`).toEqual(await coldSays(hash));
      }

      // Another project changes every number and every link, in the same elements.
      await pickProject(page, fx.repo.mixed);
      await ready(page);
      expect(await rail(page)).toMatchObject({ gone: 0, added: 0, size: n });
      const scoped = await says(page);
      expect(scoped.links.every(([, href]) => String(href).includes(`project=${encodeURIComponent(fx.repo.mixed)}`))).toBe(true);
      expect(scoped).toEqual(await coldSays(await page.evaluate(() => location.hash)));
      await pickProject(page, '');
      await ready(page);
      const unscoped = await says(page);
      expect(unscoped.links.some(([, href]) => String(href).includes('project='))).toBe(false);
      expect(await rail(page)).toMatchObject({ gone: 0, added: 0, size: n });
      expect(unscoped).toEqual(await coldSays(await page.evaluate(() => location.hash)));
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 120000);

    it('builds a new rail only when the workflow changes, and keeps that one in turn', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      const n = await hold(page);
      await page.click('#wf-caret');
      await page.click('#wf-menu [data-wf="memory"]');
      await ready(page);
      // The other workflow has its own groups and links: none of the held rail's links is in the page.
      const after = await rail(page);
      expect(after.added).toBeGreaterThan(0);
      expect(await page.evaluate(() => (window as any).__rail.filter((e: Element) => e.matches('#nav a, #nav button')).every((e: Element) => !e.isConnected))).toBe(true);
      // The workflow control is the same element, with the new workflow in it.
      expect((await says(page)).workflow).toBe('Memory');
      expect(await page.evaluate(() => (window as any).__rail.find((e: Element) => e.id === 'wf-main').isConnected)).toBe(true);
      expect(await says(page)).toEqual(await coldSays('#/memory/dashboard'));

      const m = await hold(page);
      expect(m).toBeGreaterThan(10);
      // Its pages: some are fetched, one is a detail page, and the rail stays.
      for (const hash of ['#/memory/timeline', '#/memory/sessions', `#/memory/entry/${fx.entries.mixed}`, '#/memory/health', '#/memory/dashboard']) {
        await page.evaluate((h) => { location.hash = h; }, hash);
        await ready(page);
        expect(await rail(page), hash).toMatchObject({ gone: 0, added: 0, size: m });
        expect(await says(page), hash).toEqual(await coldSays(hash));
      }
      // And back to the first workflow: built again, since it was not the one on show.
      await page.click('#wf-caret');
      await page.click('#wf-menu [data-wf="learning"]');
      await ready(page);
      expect(await says(page)).toEqual(await coldSays('#/learning/dashboard'));
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 120000);

    it('opens and closes the groups in place: a link into a collapsed group opens it, and a collapse made elsewhere applies', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      const n = await hold(page);
      const key = 'eklavya-dash-nav-collapsed:learning';
      await page.click('#tog-learning-history');
      expect(await page.isHidden('#grp-learning-history')).toBe(true);
      // Pages in the other groups leave it collapsed, in the same elements.
      await page.click('#nav [data-nav="concepts"]');
      await ready(page);
      expect(await page.isHidden('#grp-learning-history')).toBe(true);
      expect(await page.getAttribute('#tog-learning-history', 'aria-expanded')).toBe('false');
      expect(await rail(page)).toMatchObject({ gone: 0, added: 0, size: n });
      // An address inside it opens it, and the choice is stored.
      await page.evaluate(() => { location.hash = '#/learning/projects'; });
      await ready(page);
      expect(await page.isVisible('#grp-learning-history')).toBe(true);
      expect(await page.getAttribute('#tog-learning-history', 'aria-expanded')).toBe('true');
      expect(await page.evaluate((k) => localStorage.getItem(k), key)).toBe('[]');
      expect(await rail(page)).toMatchObject({ gone: 0, added: 0, size: n });
      // A collapse made on this page still takes effect at once, and survives the next page.
      await page.click('#tog-learning-history');
      expect(await page.isHidden('#grp-learning-history')).toBe(true);
      // Another tab collapsed a different group: this one applies it on the next page, in place.
      await page.evaluate((k) => localStorage.setItem(k, '["learn"]'), key);
      await page.evaluate(() => { location.hash = '#/learning/dashboard'; });
      await ready(page);
      expect(await page.isHidden('#grp-learning-learn')).toBe(true);
      expect(await page.isVisible('#grp-learning-history')).toBe(true);
      expect(await page.isVisible('#nav a[data-nav="dashboard"]')).toBe(true);
      expect(await rail(page)).toMatchObject({ gone: 0, added: 0, size: n });
      expect((await says(page)).groups).toEqual([['learn', 'false', true], ['history', 'true', false]]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('behaves in the drawer: a link closes it, the rail keeps its elements and the page behind wakes up', async () => {
      const w = await open('#/learning/dashboard', { width: 560, height: HEIGHT });
      const { page } = w;
      const n = await hold(page);
      await page.click('#menu');
      expect(await page.evaluate(() => document.getElementById('side')!.classList.contains('is-open'))).toBe(true);
      await page.click('#nav [data-nav="sessions"]');
      await ready(page);
      const s = await page.evaluate(() => ({
        open: document.getElementById('side')!.classList.contains('is-open'), inert: (document.getElementById('side') as HTMLElement & { inert: boolean }).inert,
        mainInert: (document.getElementById('main') as HTMLElement & { inert: boolean }).inert, current: document.querySelector('#nav [aria-current="page"]')?.getAttribute('data-nav'),
      }));
      expect(s).toEqual({ open: false, inert: true, mainInert: false, current: 'sessions' });
      expect(await rail(page)).toMatchObject({ gone: 0, added: 0, size: n });
      // Opened again, it is the same rail, still operable.
      await page.click('#menu');
      await page.click('#nav [data-nav="concepts"]');
      await ready(page);
      expect(await page.evaluate(() => document.querySelector('#nav [aria-current="page"]')?.getAttribute('data-nav'))).toBe('concepts');
      expect(await rail(page)).toMatchObject({ gone: 0, added: 0, size: n });
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('leaves the keyboard where it was: a link followed with Enter still has the focus', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      await page.focus('#nav [data-nav="concepts"]');
      await page.keyboard.press('Enter');
      await ready(page);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-nav'))).toBe('concepts');
      // The next link is one Tab away, and Enter follows it: the reader never had to find the rail again.
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-nav'))).toBe('review');
      await page.keyboard.press('Enter');
      await ready(page);
      expect(await page.evaluate(() => [document.activeElement?.getAttribute('data-nav'), document.querySelector('#nav [aria-current="page"]')?.getAttribute('data-nav')])).toEqual(['review', 'review']);
      await w.ctx.close();
    }, 30000);

    it('keeps the unread count on the workflow control through every page and into the Feedback workflow', async () => {
      const file = path.join(process.env.EKLAVYA_HOME!, 'config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ feedback: { enabled: true }, providers: { observer: { kind: 'anthropic', model: 'm' } } }));
      const item = insertFeedback(db, {
        session_id: 's-render', project: fx.repo.mixed, event_id: null, prompt: 'make it faster', model: 'sonnet',
        review: { worked: 'A goal.', gaps: [{ area: 'outcome', missing: 'Faster than what.' }] } as never, better: 'Make it faster than [the baseline].', tips: ['Say how fast.'],
      })!;
      try {
        const w = await open('#/learning/dashboard', { height: HEIGHT });
        const { page } = w;
        const badge = () => page.evaluate(() => ({ shown: !document.getElementById('wf-badge')!.hidden, text: document.getElementById('wf-badge')!.textContent, label: document.getElementById('wf-caret')!.getAttribute('aria-label') }));
        const want = { shown: true, text: '1', label: 'Switch workflow, 1 feedback unread' };
        expect(await badge()).toEqual(want);
        for (const hash of ['#/learning/concepts', '#/learning/review', '#/learning/sessions', '#/learning/dashboard']) {
          await page.evaluate((h) => { location.hash = h; }, hash);
          await ready(page);
          expect(await badge(), hash).toEqual(want);
        }
        // Another workflow, and the unread item opened and acknowledged there.
        await page.click('#wf-caret');
        await page.click('#wf-menu [data-wf="feedback"]');
        await ready(page);
        expect(await badge()).toEqual(want);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      } finally {
        db.prepare('DELETE FROM feedback_items WHERE id = ?').run(item);
        fs.rmSync(file, { force: true });
      }
    }, 60000);
  });

  describe('a keystroke in a search box replaces the list and nothing else', () => {
    /** Holds what a keystroke must leave alone, and every row of the list it must replace. */
    const hold = (page: Page, keep: string[], rows: string) => page.evaluate(([k, r]) => {
      (window as any).__kept = k!.map((s) => [s, [...document.querySelectorAll(s!)]]);
      (window as any).__rows = [...document.querySelectorAll(r!)];
      return { kept: (window as any).__kept.map(([s, els]: [string, Element[]]) => [s, els.length]), rows: (window as any).__rows.length };
    }, [keep, rows] as const);
    const after = (page: Page) => page.evaluate(() => {
      const kept: [string, Element[]][] = (window as any).__kept;
      const rows: Element[] = (window as any).__rows;
      return {
        // Every element held is still the one on the page, in the same place among the others of its kind.
        kept: kept.map(([s, els]) => [s, els.length === document.querySelectorAll(s).length && els.every((e, i) => e === document.querySelectorAll(s)[i])]),
        oldRows: rows.filter((e) => e.isConnected).length,
        scroll: window.scrollY,
        caret: (() => { const a = document.activeElement as HTMLInputElement | null; return a && 'selectionStart' in a ? [a.id, a.selectionStart, a.selectionEnd] : null; })(),
      };
    });
    const scrollTo = async (page: Page, y: number) => { await page.evaluate((v) => window.scrollTo({ top: v, behavior: 'instant' }), y); return page.evaluate(() => window.scrollY); };

    it('on Concepts: the box, the selects, the chips and the heading stay, the rows are new, the caret and the scroll stay', async () => {
      const w = await open('#/learning/concepts', { height: 420 });
      const { page } = w;
      const at = await scrollTo(page, 150);
      expect(at).toBeGreaterThan(0);
      const held = await hold(page, ['#q', '#view > .page__head', '.filters', '[data-region="concepts-selects"]', '.filters .combo', '#chips', '#chips .chip', 'section.card'], '[data-region="concepts"] tr.row');
      expect(held.rows).toBeGreaterThan(3);
      expect(held.kept.map(([, n]) => n).every((n: number) => n >= 1)).toBe(true);
      const term = await page.evaluate(() => S.concepts.find((c) => c.seen)!.name.replace(/[^A-Za-z]/g, '').slice(0, 5).toLowerCase());
      expect(term.length).toBe(5);
      await page.focus('#q');
      // Typed without its fourth letter, then one back and that letter typed in the middle: the caret has to come back where it was.
      await page.keyboard.type(term.slice(0, 3) + term[4], { delay: 25 });
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.type(term[3]!, { delay: 25 });
      await page.waitForTimeout(150);
      const r = await after(page);
      expect(r.kept, 'held elements').toEqual(held.kept.map(([s]: [string, number]) => [s, true]));
      expect(r.oldRows, 'the rows of the list typed over').toBe(0);
      expect(r.scroll).toBe(at);
      expect(r.caret).toEqual(['q', term.length - 1, term.length - 1]);
      expect(await page.inputValue('#q')).toBe(term);
      // The list is the search's: it narrowed.
      expect(await page.locator('[data-region="concepts"] tr.row').count()).toBeLessThan(held.rows);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('on Artifacts: the box and the chips stay, the gallery is new', async () => {
      const w = await open('#/artifacts/dashboard', { height: 420 });
      const { page } = w;
      await scrollTo(page, 120);
      const held = await hold(page, ['#aq', '#view > .page__head', '.filters', '[data-region="artifacts-chips"]', '.chips .chip', 'section.card'], '[data-region="artifacts"] .art');
      expect(held.rows).toBeGreaterThanOrEqual(2);
      await page.focus('#aq');
      await page.keyboard.type('quues', { delay: 25 });
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('e', { delay: 25 });
      await page.waitForTimeout(150);
      // `qu` + `e` + `ues`: the middle of the word is where the caret went back to.
      expect(await page.inputValue('#aq')).toBe('queues');
      const r = await after(page);
      expect(r.kept, 'held elements').toEqual(held.kept.map(([s]: [string, number]) => [s, true]));
      expect(r.oldRows, 'the cards of the gallery typed over').toBe(0);
      expect(r.caret).toEqual(['aq', 3, 3]);
      expect(await page.locator('[data-region="artifacts"] .art').count()).toBe(1);
      // A search that matches nothing says so, in the same region.
      await page.fill('#aq', 'zzzz-nothing');
      await page.waitForSelector('[data-region="artifacts"] .empty');
      expect(await page.evaluate(() => (window as any).__kept.every(([s, els]: [string, Element[]]) => els.every((e, i) => e === document.querySelectorAll(s)[i])))).toBe(true);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('on the Timeline: the box, the selects and the list element stay, and the rows are the answer to the new search', async () => {
      const w = await open('#/memory/timeline', { height: 420 });
      const { page } = w;
      const term = await page.evaluate(() => fetch('/api/memory?per=5').then((r) => r.json()).then((d) => String(d.rows[0].title).replace(/[^A-Za-z]/g, '').slice(0, 4).toLowerCase()));
      expect(term.length).toBe(4);
      await scrollTo(page, 100);
      const held = await hold(page, ['#mq', '#view > .page__head', '.filters', '[data-region="timeline-filters"]', '.filters .combo', '#mem-rows'], '#mem-rows li');
      expect(held.rows).toBeGreaterThan(0);
      const asked: string[] = [];
      page.on('request', (rq) => { const u = new URL(rq.url()); if (u.pathname === '/api/memory') asked.push(u.search); });
      await page.focus('#mq');
      await page.keyboard.type(term, { delay: 60 });
      await page.waitForFunction((t) => !document.querySelector('#mem-rows[aria-busy]') && document.getElementById('mq')!.value === t, term);
      const r = await after(page);
      expect(r.kept, 'held elements').toEqual(held.kept.map(([s]: [string, number]) => [s, true]));
      expect(r.caret).toEqual(['mq', 4, 4]);
      expect(asked.some((q) => q.includes(`q=${term}`)), asked.join(' ')).toBe(true);
      expect(await page.evaluate(() => [...document.querySelectorAll('#mem-rows li')].every((e) => !(window as any).__rows.includes(e)))).toBe(true);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);
  });
});
