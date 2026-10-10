// Split by feature so Vitest's file sharding can divide the browser work.
//
// Phase 1 of #171: a tab, a chip, a select, a date range or a pager changes the list in front of
// the reader and nothing else. Each test takes the reader part-way down a page, makes the change
// the way a reader does (a click, or Tab to the control and Enter), and holds the page to what it
// may not do: scroll, remove the heading, rebuild the sidebar, ask the server for what it has.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { OPTS, PAGE_HEAD, base, enc, fix, fx, home, open, pickOption, pickProject, probeTransition, ready } from './dashboard-browser-helpers.js';

// Globals of the page under test (a script's `let` is reachable by name from `evaluate`, not from `window`).
declare const S: { cursor: string; concepts: { due: boolean; seen: boolean }[]; attempts: { slug: string; feedback: string }[] };
declare const LAZY: Map<string, unknown>;
declare const SETS: { user: { set: Record<string, unknown> } } | null;
declare const FOLD: Record<string, boolean>;
declare function render(opts?: { nav?: boolean }): void;
declare function poll(): void;

/** Short enough that every page below scrolls, and that it still can after a list gets shorter. */
const HEIGHT = 420;
const AT = 150;

/** Scrolls the reader down (the page's own scroll is smooth, so an instant one is asked for) and says how far. */
async function scrollDown(page: Page, to = AT): Promise<number> {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), to);
  return page.evaluate(() => window.scrollY);
}

/** Where the reader is once the page has stopped scrolling (it scrolls smoothly, so a focus or a key is still moving it a moment later). */
async function restingScroll(page: Page): Promise<number> {
  let last = -1;
  for (let same = 0; same < 4;) {
    const y = await page.evaluate(() => window.scrollY);
    same = y === last ? same + 1 : 0;
    last = y;
    await page.waitForTimeout(40);
  }
  return last;
}

/** Presses Tab until `selector` has focus, as a reader reaches a control, and fails if it never does. */
async function tabTo(page: Page, selector: string, limit = 120): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (await page.evaluate((s) => !!document.activeElement?.matches(s), selector)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(`Tab never reached ${selector}`);
}

/** Does the focused element match? */
const focused = (page: Page, selector: string) => page.evaluate((s) => !!document.activeElement?.matches(s), selector);

/** What the sidebar says: the current page and every count. */
const sidebar = (page: Page) => page.evaluate(() => ({
  current: [...document.querySelectorAll('#nav [aria-current="page"]')].map((a) => a.getAttribute('data-nav')),
  counts: Object.fromEntries([...document.querySelectorAll('#nav a[data-nav]')].map((a) => [a.getAttribute('data-nav'), a.querySelector('i')?.textContent ?? null])),
}));

/** Holds the sidebar's own elements, to ask later whether they are still the ones on the page. */
const holdSidebar = (page: Page) => page.evaluate(() => {
  (window as any).__nav = { nav: document.getElementById('nav'), links: [...document.querySelectorAll('#nav a[data-nav]')], badges: [...document.querySelectorAll('#nav a[data-nav] i')] };
});
const sidebarKept = (page: Page) => page.evaluate(() => {
  const h = (window as any).__nav;
  const same = (a: Element[], b: Element[]) => a.length === b.length && a.every((x, i) => x === b[i] && x.isConnected);
  return h.nav === document.getElementById('nav')
    && same(h.links, [...document.querySelectorAll('#nav a[data-nav]')])
    && same(h.badges, [...document.querySelectorAll('#nav a[data-nav] i')]);
});

/** Takes the reader to `AT`, then only as far as it takes to have `selector` in the window, as a reader does before using a control; says how far down that is. */
async function bringIntoView(page: Page, selector: string): Promise<number> {
  await scrollDown(page);
  await page.evaluate((s) => document.querySelector(s)!.scrollIntoView({ block: 'nearest', behavior: 'instant' }), selector);
  return restingScroll(page);
}

/** Opens or closes a page's "How this works" the way a reader does, and waits until the page has taken note of it. */
async function setAbout(page: Page, open: boolean): Promise<void> {
  const about = '#view details.about';
  if ((await page.$eval(about, (d) => (d as HTMLDetailsElement).open)) !== open) await page.click(`${about} > summary`);
  const id = await page.$eval(about, (d) => (d as HTMLElement).dataset.fold!);
  await page.waitForFunction(([i, v]) => FOLD[i as string] === v, [id, open] as const);
}

/** What `eklavya config set cadence <value>` does to the file, from outside the page. */
function setCadenceOnDisk(value: string): void {
  const file = path.join(home, 'home', 'config.json');
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none written yet */ }
  cfg.cadence = value;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg));
}

/** A test that saves a setting puts the default back through the file, so the next test starts from it. */
async function resetCadence(): Promise<void> {
  const file = path.join(home, 'home', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete cfg.cadence;
    fs.writeFileSync(file, JSON.stringify(cfg));
  } catch { /* never written */ }
}

/** Text of every row of the list on screen, for comparing "the list" rather than a pixel. */
const listText = (page: Page, selector: string) => page.$$eval(selector, (rows) => rows.map((r) => (r.textContent ?? '').replace(/\s+/g, ' ').trim()));

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('in-page changes stay in the page', () => {
    /**
     * One adjustment of each kind, made with the reader part-way down: the page does not scroll,
     * the heading and the sidebar are the same elements afterwards, and the sidebar is right.
     */
    const adjustments: {
      name: string; from: string; to: string; current: string; head: boolean;
      act: (p: Page) => Promise<unknown>; then: (p: Page) => Promise<void>; requests?: RegExp[];
      /** Where the reader is before: a pager is at the foot of the list, so the reader is there. Default `AT`. */
      scroll?: number;
    }[] = [
      {
        name: 'a Review tab', from: '#/learning/review', to: '#/learning/review/skipped', current: 'review', head: true,
        act: (p) => p.click('[data-tab="skipped"]'),
        then: async (p) => { expect(await p.getAttribute('[data-tab="skipped"]', 'aria-pressed')).toBe('true'); },
      },
      {
        name: 'a concept chip', from: '#/learning/concepts', to: '#/learning/concepts/due', current: 'concepts', head: true,
        act: (p) => p.click('[data-state="due"]'),
        then: async (p) => { expect(await p.getAttribute('[data-state="due"]', 'aria-pressed')).toBe('true'); },
      },
      {
        name: 'the domain select', from: '#/learning/concepts', to: '#/learning/concepts?domain=web-auth', current: 'concepts', head: true,
        act: (p) => pickOption(p, '#dom', 'web-auth'),
        then: async (p) => { expect(await p.inputValue('#dom')).toBe('web-auth'); },
      },
      {
        name: 'the sort select', from: '#/learning/concepts', to: '#/learning/concepts', current: 'concepts', head: true,
        act: (p) => pickOption(p, '#sort', 'name'),
        then: async (p) => { expect(await p.inputValue('#sort')).toBe('name'); },
      },
      {
        name: 'a Timeline tag', from: '#/memory/timeline', to: '#/memory/timeline?tag=auth', current: 'timeline', head: true,
        act: (p) => pickOption(p, '#mtag', 'auth'),
        then: async (p) => { expect(await p.$$eval('#mem-rows [data-entry]', (r) => r.length)).toBe(2); },
        requests: [/^\/api\/memory\?.*tag=auth/],
      },
      {
        name: 'a Timeline type', from: '#/memory/timeline', to: '#/memory/timeline/decision', current: 'timeline', head: true,
        act: (p) => pickOption(p, '#mtype', 'decision'),
        then: async (p) => { expect(await p.$$eval('#mem-rows [data-entry]', (r) => r.length)).toBe(1); },
        requests: [/^\/api\/memory\?.*type=decision/],
      },
      {
        name: 'a Timeline date range', from: '#/memory/timeline', to: '#/memory/timeline?from=', current: 'timeline', head: true,
        act: (p) => pickOption(p, '#mwhen', 'custom'),
        then: async (p) => { expect(await p.locator('#mfrom').count()).toBe(1); },
        requests: [/^\/api\/memory\?.*since=/],
      },
      {
        name: 'a pager', from: '#/learning/concepts', to: '#/learning/concepts', current: 'concepts', head: true, scroll: 1e6,
        act: (p) => p.click('[data-pager="concepts"][aria-label="Next page"]'),
        then: async (p) => { expect(await p.textContent('[data-pager="concepts"][aria-current="true"]')).toBe('2'); },
      },
    ];

    for (const c of adjustments) {
      it(`${c.name} leaves the reader's place, the heading and the sidebar alone`, async () => {
        const w = await open(c.from, { height: HEIGHT });
        const { page } = w;
        const before = await sidebar(page);
        await holdSidebar(page);
        const at = await scrollDown(page, c.scroll ?? AT);
        expect(at, 'the page is tall enough to have a place to lose').toBeGreaterThan(100);

        const r = await probeTransition(page, () => c.act(page));
        // The URL says where it says anything; a pager changes none.
        expect(r.hash).toMatch(new RegExp('^' + c.to.replace(/[?]/g, '\\?')));
        expect(r.scrollBefore).toBe(at);
        // Unmoved, unless the list got shorter than the reader's place: then as far down as the page goes.
        const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
        expect(r.scrollAfter, 'the reader was moved').toBe(Math.min(at, room));
        expect(r.headKept, 'the heading was removed from the page').toBe(true);
        expect(r.sawLoader, 'a loader replaced what the reader was reading').toBe(false);
        if (c.requests) expect(r.requests).toEqual(c.requests.map((re) => expect.stringMatching(re)));
        else expect(r.requests, 'this change needs nothing from the server').toEqual([]);
        await c.then(page);

        // The sidebar: the same elements, still on the right page, with the counts it had.
        expect(await sidebarKept(page), 'the sidebar was rebuilt').toBe(true);
        expect(await sidebar(page)).toEqual({ ...before, current: [c.current] });
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);
    }

    it('keeps the sidebar right when an adjustment changes what it counts', async () => {
      const w = await open('#/learning/concepts', { height: HEIGHT });
      const { page } = w;
      const was = Number((await sidebar(page)).counts.review);
      // A concept that has been asked and is not yet due becomes due: the count is the page's to recompute.
      await page.evaluate(() => { const c = S.concepts.find((x) => x.seen && !x.due)!; c.due = true; });
      await holdSidebar(page);
      await page.click('[data-state="due"]');
      await ready(page);
      expect(Number((await sidebar(page)).counts.review)).toBe(was + 1);
      expect(await sidebarKept(page)).toBe(true);
      // The badge is the page's `hot` one once something is due, and stays a badge.
      expect(await page.getAttribute('#nav [data-nav="review"] i', 'class')).toBe('hot');
      await w.ctx.close();
    });

    it('is operated from the keyboard: Tab to each control and press Enter', async () => {
      const w = await open('#/learning/review', { height: HEIGHT });
      const { page } = w;
      await holdSidebar(page);
      expect(await scrollDown(page)).toBe(AT);

      // A tab.
      await tabTo(page, '[data-tab="upcoming"]');
      const tab = await probeTransition(page, () => page.keyboard.press('Enter'));
      expect(tab.hash).toBe('#/learning/review/upcoming');
      expect(await page.getAttribute('[data-tab="upcoming"]', 'aria-pressed')).toBe('true');
      // Focus is on the control that was used, on the new markup, not on the page.
      expect(await focused(page, '[data-tab="upcoming"]')).toBe(true);
      expect(tab.scrollAfter).toBe(tab.scrollBefore);
      expect(tab.headKept).toBe(true);

      // A chip.
      await page.goto(base + '/#/learning/concepts'); await ready(page);
      expect(await scrollDown(page)).toBe(AT);
      await tabTo(page, '[data-state="learning"]');
      const chip = await probeTransition(page, () => page.keyboard.press('Enter'));
      expect(chip.hash).toBe('#/learning/concepts/learning');
      expect(await page.getAttribute('[data-state="learning"]', 'aria-pressed')).toBe('true');
      expect(await focused(page, '[data-state="learning"]')).toBe(true);
      expect(chip.scrollAfter).toBe(chip.scrollBefore);
      expect(chip.headKept).toBe(true);

      // A pager: Next stays under the reader's fingers for the next press.
      await page.goto(base + '/#/learning/concepts'); await ready(page);
      expect(await scrollDown(page)).toBe(AT);
      await tabTo(page, '[data-pager="concepts"][aria-label="Next page"]');
      expect(await page.evaluate(() => window.scrollY), 'Tab brought the pager into view').toBeGreaterThan(AT);
      const first = await probeTransition(page, () => page.keyboard.press('Enter'));
      expect(await page.textContent('[data-pager="concepts"][aria-current="true"]')).toBe('2');
      expect(await focused(page, '[data-pager="concepts"][aria-label="Next page"]')).toBe(true);
      expect(first).toMatchObject({ headKept: true, requests: [] });
      expect(first.scrollAfter).toBe(first.scrollBefore);
      // The same key, again: it activated the control that is now on the page, not a stale one.
      const second = await probeTransition(page, () => page.keyboard.press('Enter'));
      expect(await page.textContent('[data-pager="concepts"][aria-current="true"]')).toBe('3');
      expect(second.scrollAfter).toBe(second.scrollBefore);

      // A select: open it with Enter, choose with the arrows, and focus is back on it.
      await page.goto(base + '/#/memory/timeline'); await ready(page);
      expect(await scrollDown(page)).toBe(AT);
      await tabTo(page, '#mtag-combo');
      const tag = await probeTransition(page, async () => {
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
      });
      expect(tag.hash).toContain('tag=');
      expect(await page.evaluate(() => (document.getElementById('mtag') as HTMLSelectElement).value)).not.toBe('all');
      expect(await focused(page, '#mtag-combo')).toBe(true);
      expect(tag.scrollAfter).toBe(tag.scrollBefore);
      expect(tag.headKept).toBe(true);

      // A Settings tab is a link: Enter follows it, and nothing but the pane changes.
      await page.goto(base + '/#/settings/dashboard'); await ready(page);
      const href = (await page.$$eval('.sw__tab', (a) => a.map((x) => x.getAttribute('href')!)))[1]!;
      await tabTo(page, `.sw__tab[href="${href}"]`);
      const set = await probeTransition(page, () => page.keyboard.press('Enter'), { keep: '#settings .sw' });
      expect(set.hash).toBe(href);
      expect(set).toMatchObject({ requests: [], keptSelector: true });
      expect(await focused(page, `.sw__tab[href="${href}"]`)).toBe(true);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 90000);

    it('returns to the earlier list on Back', async () => {
      const w = await open('#/learning/review', { height: HEIGHT });
      const { page } = w;
      // The list and its tab bar, as one piece of text: the due list is empty on the fixture.
      const rows = '[data-region="review"]';
      const due = await listText(page, rows);

      await page.click('[data-tab="skipped"]'); await ready(page);
      const skipped = await listText(page, rows);
      expect(skipped).not.toEqual(due);
      await page.click('[data-tab="upcoming"]'); await ready(page);
      expect(await page.evaluate(() => location.hash)).toBe('#/learning/review/upcoming');

      await page.goBack(); await ready(page);
      expect(await page.evaluate(() => location.hash)).toBe('#/learning/review/skipped');
      expect(await listText(page, rows)).toEqual(skipped);
      expect(await page.getAttribute('[data-tab="skipped"]', 'aria-pressed')).toBe('true');
      await page.goBack(); await ready(page);
      expect(await listText(page, rows)).toEqual(due);
      expect(await page.getAttribute('[data-tab="due"]', 'aria-pressed')).toBe('true');
      await page.goForward(); await ready(page);
      expect(await listText(page, rows)).toEqual(skipped);

      // A concept chip, and the filtered list it leaves behind it.
      await page.goto(base + '/#/learning/concepts'); await ready(page);
      const rowsOf = 'tr.row';
      const all = await listText(page, rowsOf);
      await page.click('[data-state="mastered"]'); await ready(page);
      const mastered = await listText(page, rowsOf);
      expect(mastered).not.toEqual(all);
      await page.goBack(); await ready(page);
      expect(await listText(page, rowsOf)).toEqual(all);
      expect(await page.getAttribute('[data-state="all"]', 'aria-pressed')).toBe('true');

      // A Settings tab: the pane the reader left.
      await page.goto(base + '/#/settings/dashboard'); await ready(page);
      const tabs = await page.$$eval('.sw__tab', (a) => a.map((x) => x.getAttribute('href')!));
      const first = (await page.textContent('.sw__pane h1'))!;
      const pane = await page.textContent('.sw__pane .sw__list, .sw__pane .card');
      await page.click(`.sw__tab[href="${tabs[2]}"]`); await ready(page);
      expect(await page.textContent('.sw__pane .sw__list, .sw__pane .card')).not.toBe(pane);
      await page.goBack(); await ready(page);
      expect(await page.evaluate(() => location.hash)).toBe('#/settings/dashboard');
      expect(await page.textContent('.sw__pane .sw__list, .sw__pane .card')).toBe(pane);
      expect(await page.textContent('.sw__pane h1')).toBe(first);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('keeps the caret and the text in a search box while its list is redrawn', async () => {
      const w = await open('#/learning/concepts', { height: HEIGHT });
      const { page } = w;
      await holdSidebar(page);
      expect(await scrollDown(page)).toBe(AT);
      const r = await probeTransition(page, async () => {
        await page.focus('#q');
        await page.keyboard.type('refr');
        // Back one letter and type in the middle: the caret has to come back where it was.
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.type('e');
      });
      expect(await page.inputValue('#q')).toBe('refer');
      expect(await page.evaluate(() => { const q = document.getElementById('q') as HTMLInputElement; return [document.activeElement === q, q.selectionStart, q.selectionEnd]; })).toEqual([true, 4, 4]);
      expect(r).toMatchObject({ scrollBefore: AT, scrollAfter: AT, headKept: true, requests: [], sawLoader: false });
      expect(await sidebarKept(page)).toBe(true);
      // The list is the search's, and a select the reader opens next still works on it.
      expect((await listText(page, 'tr.row')).length).toBeLessThanOrEqual(20);
      await w.ctx.close();
    }, 30000);

    it('does not take the focus into the search box when the window is resized', async () => {
      const w = await open('#/learning/concepts', { height: HEIGHT });
      const { page } = w;
      expect(await scrollDown(page)).toBe(AT);
      await page.focus('[data-state="due"]');
      await page.setViewportSize({ width: 1100, height: HEIGHT });
      await page.waitForTimeout(400);
      // The page redrew (a resize redraws charts), and neither moved the reader nor changed what has focus.
      expect(await page.evaluate(() => window.scrollY)).toBe(AT);
      expect(await focused(page, '[data-state="due"]')).toBe(true);
      await w.ctx.close();
    }, 30000);

    it('keeps open folds and focus through a redraw of the screen they are on', async () => {
      const w = await open('#/learning/concept/csrf', { height: HEIGHT });
      const { page } = w;
      expect(await scrollDown(page)).toBe(AT);
      // One question opened (a <details> with no fold id: found again by its key), one fold left closed.
      const key = await page.$eval('.qa', (d) => { (d as HTMLDetailsElement).open = true; return d.getAttribute('data-key'); });
      expect(key).toMatch(/^qa:\d+$/);
      expect(await page.evaluate(() => LAZY.has('c-grades')), 'the grades chart waits for its fold').toBe(true);
      // New data for the same screen: the question's feedback changes, so its region is redrawn.
      const head = await probeTransition(page, () => page.evaluate(() => {
        S.attempts.find((a) => a.slug === 'csrf')!.feedback = 'Reworded feedback.';
        render();
      }));
      expect(head).toMatchObject({ scrollBefore: AT, scrollAfter: AT, headKept: true });
      expect(await page.$$eval('.qa', (d) => d.map((x) => [x.getAttribute('data-key'), (x as HTMLDetailsElement).open]))).toContainEqual([key, true]);
      expect(await page.textContent('.qa[open]')).toContain('Reworded feedback.');
      // The chart still waits, and still draws when its fold opens.
      expect(await page.evaluate(() => LAZY.has('c-grades'))).toBe(true);
      await page.click('details[data-fold="concept:grades"] > summary');
      await page.waitForFunction(() => document.querySelectorAll('#c-grades *').length > 0);
      expect(await page.evaluate(() => LAZY.has('c-grades'))).toBe(false);
      await w.ctx.close();
    }, 30000);

    it('keeps the outgoing timeline under the new request, and drops a late answer', async () => {
      const w = await open('#/memory/timeline', { height: HEIGHT });
      const { page } = w;
      const all = await page.$$eval('#mem-rows [data-entry]', (r) => r.length);
      expect(all).toBe(5);
      // The tag auth is slow to answer; the tag docs is not. Whatever arrives last must not win.
      let release = () => {};
      const held = new Promise<void>((r) => { release = r; });
      await page.route('**/api/memory?*', async (route) => {
        if (route.request().url().includes('tag=auth')) await held;
        await route.continue();
      });
      await pickOption(page, '#mtag', 'auth');
      await page.waitForFunction(() => location.hash.includes('tag=auth'));
      // While it is out, the rows the reader was looking at are still there, marked busy, with no loader over them.
      expect(await page.getAttribute('#mem-rows', 'aria-busy')).toBe('true');
      expect(await page.$$eval('#mem-rows [data-entry]', (r) => r.length)).toBe(all);
      expect(await page.locator('#mem-rows .loader').count()).toBe(0);
      await pickOption(page, '#mtag', 'docs');
      await page.waitForFunction(() => document.querySelectorAll('#mem-rows [data-entry]').length === 2 && !document.getElementById('mem-rows')!.hasAttribute('aria-busy'));
      const docs = await listText(page, '#mem-rows [data-entry]');
      release();
      await page.waitForTimeout(400);
      expect(await listText(page, '#mem-rows [data-entry]'), 'the late answer painted over the list').toEqual(docs);
      expect(await page.inputValue('#mtag')).toBe('docs');
      await page.unroute('**/api/memory?*');
      await w.ctx.close();
    }, 30000);

    it('pages a fetched list in place: the rows stay until the next page arrives, and the key that asked is under the reader', async () => {
      const w = await open('#/memory/timeline', { height: HEIGHT });
      const { page } = w;
      // Sixty entries in three pages of twenty, one day each so the list is long enough to scroll.
      const entry = (n: number, at: number) => ({
        id: 1000 + n, kind: 'observation', title: `Entry ${n}`, type: 'discovery', occurred_at: new Date(Date.now() - at * 36e5).toISOString(),
        session_id: null, project: fx.repo.mixed, snippet: `Entry ${n} snippet`, narrative_length: 5, event_count: 1, tags: [], deleted_at: null, superseded_by: null,
      });
      const requested: number[] = [];
      let release = () => {};
      let held = Promise.resolve();
      await page.route('**/api/memory?*', async (route) => {
        const n = Number(new URL(route.request().url()).searchParams.get('page'));
        requested.push(n);
        if (n === 2) await held;
        await route.fulfill({ json: { total: 60, page: n, pages: 3, per: 20, rows: Array.from({ length: 20 }, (_, i) => entry((n - 1) * 20 + i + 1, (n - 1) * 20 + i)) } });
      });
      // The page already holds the first page it read (the fixture's five entries, which a revisit draws
      // with no request), so the sixty are asked for by a fresh load of it.
      await page.reload();
      await page.waitForFunction(() => !!document.querySelector('#mem-rows [data-entry="1001"]') && !document.getElementById('mem-rows')!.hasAttribute('aria-busy'));
      await holdSidebar(page);
      await page.evaluate(() => { (window as any).__head = document.querySelector('#view > .page__head'); });

      // The reader scrolls to the foot of the list, Tabs to Next and presses Enter.
      await scrollDown(page, 1e6);
      await tabTo(page, '[data-pager="memory"][aria-label="Next page"]');
      const before = await restingScroll(page);
      held = new Promise<void>((r) => { release = r; });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('mem-rows')!.getAttribute('aria-busy') === 'true');
      // Page two is out; page one is still what the reader sees, and no loader has replaced it.
      expect(requested.at(-1)).toBe(2);
      expect(await page.locator('#mem-rows [data-entry="1001"]').count()).toBe(1);
      expect(await page.locator('#mem-rows .loader').count()).toBe(0);
      expect(await page.evaluate(() => window.scrollY)).toBe(before);
      release();
      await page.waitForFunction(() => !!document.querySelector('#mem-rows [data-entry="1021"]') && !document.getElementById('mem-rows')!.hasAttribute('aria-busy'));
      expect(await page.locator('#mem-rows [data-entry="1001"]').count()).toBe(0);
      expect(await page.textContent('[data-pager="memory"][aria-current="true"]')).toBe('2');
      // The Next button the reader pressed was replaced by the new list's; focus went to its successor.
      expect(await focused(page, '[data-pager="memory"][aria-label="Next page"]')).toBe(true);
      // Where the reader was, or as far down as the new page goes when it is shorter (other days, other gaps).
      const [now, limit] = await page.evaluate((b) => [window.scrollY, Math.min(b, document.documentElement.scrollHeight - innerHeight)], before);
      expect(now).toBe(limit);
      expect(await sidebarKept(page)).toBe(true);
      expect(await page.evaluate(() => (window as any).__head === document.querySelector('#view > .page__head') && (window as any).__head.isConnected)).toBe(true);
      await page.unroute('**/api/memory?*');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 30000);

    it('keeps the heading and the outgoing rows when a page that is only a fetched list changes page', async () => {
      // Memory's Sessions page has no tab, chip or select: the list and its pager are all there is, so
      // the list being a region is what keeps its heading in the page.
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      const row = (n: number) => ({ session_id: `s-${n}`, project: fx.repo.mixed, events: n, entries: 1, pending: 0, candidates: 0, first: new Date().toISOString(), last: new Date(Date.now() - n * 36e5).toISOString() });
      let release = () => {};
      let held = Promise.resolve();
      const requested: number[] = [];
      await page.route('**/api/memory/sessions?*', async (route) => {
        const n = Number(new URL(route.request().url()).searchParams.get('page'));
        requested.push(n);
        if (n === 2) await held;
        await route.fulfill({ json: { total: 60, page: n, pages: 3, per: 20, rows: Array.from({ length: 20 }, (_, i) => row((n - 1) * 20 + i + 1)) } });
      });
      await page.evaluate(() => { location.hash = '#/memory/sessions'; });
      await page.waitForSelector('#msess-rows tr.row');
      await page.evaluate(() => { (window as any).__head = document.querySelector('#view > .page__head'); });
      const first = await page.textContent('#msess-rows tr.row');
      await scrollDown(page, 1e6);
      await tabTo(page, '[data-pager="msessions"][aria-label="Next page"]');
      await restingScroll(page);
      held = new Promise<void>((r) => { release = r; });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.getElementById('msess-rows')!.getAttribute('aria-busy') === 'true');
      // Page two is out: page one is still on screen, and so is the heading.
      expect(requested.at(-1)).toBe(2);
      expect(await page.textContent('#msess-rows tr.row')).toBe(first);
      expect(await page.locator('#msess-rows .loader').count()).toBe(0);
      expect(await page.evaluate(() => (window as any).__head === document.querySelector('#view > .page__head') && (window as any).__head.isConnected)).toBe(true);
      release();
      await page.waitForFunction(() => !document.getElementById('msess-rows')!.hasAttribute('aria-busy'));
      expect(await page.textContent('#msess-rows tr.row')).not.toBe(first);
      expect(await page.textContent('[data-pager="msessions"][aria-current="true"]')).toBe('2');
      expect(await focused(page, '[data-pager="msessions"][aria-label="Next page"]')).toBe(true);
      expect(await page.evaluate(() => (window as any).__head === document.querySelector('#view > .page__head') && (window as any).__head.isConnected)).toBe(true);
      await page.unroute('**/api/memory/sessions?*');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 30000);

    it('is a navigation, not an adjustment, when the subject changes: another concept, another project, the other workflow', async () => {
      const w = await open('#/learning/concept/csrf', { height: HEIGHT });
      const { page } = w;
      // Another concept is another page: it opens at the top, with its own heading.
      expect(await scrollDown(page)).toBe(AT);
      const concept = await probeTransition(page, () => page.evaluate(() => { location.hash = '#/learning/concept/jwt-structure'; }));
      expect(concept).toMatchObject({ scrollBefore: AT, scrollAfter: 0, headKept: false });
      expect(await page.textContent('#view h1')).not.toBe('CSRF');

      // Another project: the sidebar's counts and the crumb say something else, so everything is rebuilt.
      await page.goto(base + '/#/learning/review'); await ready(page);
      await holdSidebar(page);
      expect(await scrollDown(page)).toBe(AT);
      const project = await probeTransition(page, () => pickProject(page, fx.repo.mixed));
      expect(project.hash).toBe(`#/learning/review?project=${enc(fx.repo.mixed)}`);
      expect(project).toMatchObject({ scrollBefore: AT, scrollAfter: 0, headKept: false });
      expect(await sidebarKept(page), 'the sidebar is rebuilt for a project').toBe(false);
      expect(await page.textContent('#crumb')).toContain('mixed');

      // The other workflow, and a page of the same workflow.
      await page.goto(base + '/#/learning/concepts'); await ready(page);
      expect(await scrollDown(page)).toBe(AT);
      const other = await probeTransition(page, () => page.evaluate(() => { location.hash = '#/learning/review'; }));
      expect(other).toMatchObject({ scrollBefore: AT, scrollAfter: 0, headKept: false });
      expect(await sidebar(page).then((s) => s.current)).toEqual(['review']);
      await w.ctx.close();
    }, 60000);

    it('puts a new page at the top at once: it is never seen gliding up from where the reader was', async () => {
      // The page asks for smooth scrolling (`html { scroll-behavior: smooth }`) for in-page jumps, so a scroll to the
      // top that does not say "instant" glides for half a second. `probeTransition` waits for a scroll to stop
      // and reports where it ended, so it cannot tell a jump from a glide; this samples every frame instead.
      const w = await open('#/learning/concepts', { height: HEIGHT });
      const { page } = w;
      expect(await scrollDown(page, 1e6), 'the catalogue is long enough for a glide to be seen').toBeGreaterThan(1000);
      // A first visit to the timeline holds the room its rows will take (the box), so the page stays tall for as
      // long as the answer is out, which is what a glide needs. Holding the answer makes that last, not a race.
      let release = () => {};
      const held = new Promise<void>((r) => { release = r; });
      await page.route('**/api/memory?*', async (route) => { await held; await route.continue(); });
      const seen = await page.evaluate((to) => new Promise<{ room: number; samples: number[] }>((resolve) => {
        const samples: number[] = [];
        let first = 0;
        let room = 0;
        const tick = (now: number) => {
          // Only once the screen is drawn for the URL: the scroll is the draw's.
          if (document.documentElement.dataset.rendered === to) {
            if (!first) { first = now; room = document.documentElement.scrollHeight - innerHeight; }
            samples.push(window.scrollY);
            if (now - first >= 300) return resolve({ room, samples });
          }
          requestAnimationFrame(tick);
        };
        location.hash = to;
        requestAnimationFrame(tick);
      }), '#/memory/timeline');
      expect(seen.room, 'the page was still tall while the timeline was out').toBeGreaterThan(1000);
      expect(seen.samples.length, 'frames were sampled').toBeGreaterThan(5);
      expect(Math.max(...seen.samples), `scrollY, frame by frame, after the screen drew: ${seen.samples.join(' ')}`).toBe(0);
      release();
      await ready(page);
      await page.unroute('**/api/memory?*');
      expect(await page.evaluate(() => window.scrollY)).toBe(0);
      await w.ctx.close();
    }, 30000);

    it('redraws a page with no regions in place, without scrolling, when the ground changes', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
      expect(room).toBeGreaterThan(AT);
      expect(await scrollDown(page)).toBe(AT);
      const r = await probeTransition(page, () => page.click('[data-ground="paper"]'));
      expect(await page.getAttribute('html', 'data-mode')).toBe('paper');
      expect(r.scrollAfter, 'the ground moved the reader').toBe(AT);
      expect(r.requests).toEqual([]);
      await w.ctx.close();
    }, 30000);

    describe('a fold the reader opened or closed first', () => {
      /**
       * "How this works" is open or closed because the reader chose it, and the page remembers the choice
       * (`FOLD`). It is not part of what the screen is, so the adjustment that follows must change the list and
       * nothing else: the same heading, the same chart, the same list host, no loader, no movement. Each case
       * opens the fold and adjusts, then closes it and adjusts again.
       */
      const cases: {
        name: string; from: string; target: string; keep?: string; requests?: RegExp[];
        acts: [(p: Page) => Promise<unknown>, (p: Page) => Promise<unknown>];
      }[] = [
        {
          name: 'a Review tab', from: '#/learning/review', target: '[data-tab="skipped"]', keep: '#c-forecast',
          acts: [(p) => p.click('[data-tab="skipped"]'), (p) => p.click('[data-tab="upcoming"]')],
        },
        {
          name: 'a concept chip', from: '#/learning/concepts', target: '[data-state="learning"]',
          acts: [(p) => p.click('[data-state="learning"]'), (p) => p.click('[data-state="due"]')],
        },
        {
          name: 'a Timeline tag', from: '#/memory/timeline', target: '#mtag-combo', keep: '#mem-rows', requests: [/^\/api\/memory\?.*tag=/],
          acts: [(p) => pickOption(p, '#mtag', 'auth'), (p) => pickOption(p, '#mtag', 'docs')],
        },
        {
          name: 'an Artifacts chip', from: '#/artifacts/dashboard', target: '.chips [data-go*="explainer"]',
          acts: [(p) => p.click('.chips [data-go*="explainer"]'), (p) => p.locator('.chips .chip').first().click()],
        },
      ];

      for (const c of cases) {
        it(`${c.name} leaves the heading, the list's host and the reader's place alone`, async () => {
          const w = await open(c.from, { height: HEIGHT });
          const { page } = w;
          for (const [i, opened] of [true, false].entries()) {
            await setAbout(page, opened);
            const at = await bringIntoView(page, c.target);
            expect(at, 'the page is tall enough to have a place to lose').toBeGreaterThan(0);
            const r = await probeTransition(page, () => c.acts[i]!(page), c.keep ? { keep: c.keep } : {});
            const how = `after the fold was ${opened ? 'opened' : 'closed'}`;
            expect(r.headKept, `the heading was removed ${how}`).toBe(true);
            if (c.keep) expect(r.keptSelector, `${c.keep} was replaced ${how}`).toBe(true);
            expect(r.sawLoader, `a loader replaced what the reader was reading ${how}`).toBe(false);
            const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
            expect(r.scrollAfter, `the reader was moved ${how}`).toBe(Math.min(r.scrollBefore, room));
            if (c.requests) expect(r.requests).toEqual(c.requests.map((re) => expect.stringMatching(re)));
            else expect(r.requests).toEqual([]);
          }
          expect(w.errors).toEqual([]);
          await w.ctx.close();
        }, 60000);
      }

      it('a redraw of a concept page keeps its heading and chart after its grades fold was opened', async () => {
        const w = await open('#/learning/concept/csrf', { height: HEIGHT });
        const { page } = w;
        await page.click('details[data-fold="concept:grades"] > summary');
        await page.waitForFunction(() => FOLD['concept:grades'] === true && document.querySelectorAll('#c-grades *').length > 0);
        const at = await bringIntoView(page, '#c-grades');
        expect(at).toBeGreaterThan(0);
        const r = await probeTransition(page, () => page.evaluate(() => render()), { keep: '#c-grades' });
        expect(r).toMatchObject({ headKept: true, keptSelector: true, sawLoader: false, scrollBefore: at, scrollAfter: at, requests: [] });
        await w.ctx.close();
      }, 30000);

      it('leaves a region alone when only a fold inside it was opened', async () => {
        // Settings draws its heading, and the fold with it, inside the pane the tabs redraw. A region that
        // is unchanged is not touched, whatever the reader did to it, and a fold is something the reader did.
        const w = await open('#/settings/dashboard', { height: HEIGHT });
        const { page } = w;
        await page.click('#settings details.about > summary');
        await page.waitForFunction(() => FOLD['about:settings:dashboard'] === true);
        const r = await probeTransition(page, () => page.click('[data-ground="paper"]'), { keep: '#settings .sw__list' });
        expect(await page.getAttribute('html', 'data-mode')).toBe('paper');
        expect(r, 'the settings list was replaced for a change of ground').toMatchObject({ keptSelector: true, sawLoader: false, requests: [] });
        expect(await page.$eval('#settings details.about', (d) => (d as HTMLDetailsElement).open), 'the fold the reader opened is still open').toBe(true);
        await w.ctx.close();
      }, 30000);

      it('keeps the gallery in the page after a tab was closed, then the last one', async () => {
        const seeded = JSON.stringify([fix.open, fix.other]);
        const w = await open('#/artifacts/dashboard', { height: HEIGHT, init: `try { localStorage.setItem('eklavya-dash-tabs', ${JSON.stringify(seeded)}); } catch (e) {}` });
        const { page } = w;
        const tabCount = () => page.locator('#view .tabs [role="tab"]').count();
        expect(await tabCount(), 'the gallery and its two open pages').toBe(3);
        // Close one (the strip keeps All artifacts and the other), then the other (the strip goes), each time before an adjustment.
        for (const { tabs: left, chip } of [{ tabs: 2, chip: '.chips [data-go*="explainer"]' }, { tabs: 0, chip: '.chips .chip' }]) {
          // The close button shows when its tab is under the pointer.
          const tab = page.locator('#view .tabw:has([data-close])').first();
          await tab.hover();
          await tab.locator('[data-close]').click();
          await page.waitForFunction((n) => document.querySelectorAll('#view .tabs [role="tab"]').length === n, left);
          const at = await bringIntoView(page, chip);
          expect(at).toBeGreaterThan(0);
          const r = await probeTransition(page, () => page.locator(chip).first().click(), { keep: '#view .tabs, #view .page__head' });
          expect(r, `the page was replaced after a tab was closed (${left ? 'one' : 'no'} tab left)`)
            .toMatchObject({ headKept: true, keptSelector: true, sawLoader: false, scrollBefore: at, requests: [] });
          const room = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
          expect(r.scrollAfter, 'the reader was moved').toBe(Math.min(at, room));
        }
        expect(await page.locator('#view .tabs').count(), 'with no tab open there is no strip').toBe(0);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);
    });

    describe('Settings', () => {
      it('keeps the tab strip where the reader scrolled it on a phone', async () => {
        const w = await open('#/settings/dashboard', { width: 560, height: 800 });
        const { page } = w;
        const strip = () => page.evaluate(() => { const t = document.querySelector('.sw__tabs')!; return [t.scrollLeft, t.scrollWidth - t.clientWidth]; });
        expect((await strip())[1], 'the tabs overflow a phone').toBeGreaterThan(40);
        // The reader scrolls the strip to its end and presses the last tab, which is then in view.
        await page.evaluate(() => { const t = document.querySelector('.sw__tabs')!; t.scrollLeft = t.scrollWidth; });
        const [at] = await strip();
        expect(at).toBeGreaterThan(40);
        const last = await page.$$eval('.sw__tab', (a) => a.at(-1)!.getAttribute('href')!);
        const r = await probeTransition(page, () => page.click(`.sw__tab[href="${last}"]`), { keep: '#settings .sw' });
        expect(r).toMatchObject({ requests: [], keptSelector: true });
        expect(await page.getAttribute(`.sw__tab[href="${last}"]`, 'aria-current')).toBe('page');
        expect((await strip())[0], 'the strip went back to its start').toBe(at);
        await w.ctx.close();
      }, 30000);

      it('reads from the server only when what it holds is missing or stale', async () => {
        const w = await open('#/settings/dashboard', { height: HEIGHT });
        const { page } = w;
        const tabs = await page.$$eval('.sw__tab', (a) => a.map((x) => x.getAttribute('href')!));
        const click = (href: string) => probeTransition(page, () => page.click(`.sw__tab[href="${href}"]`), { keep: '#settings .sw' });

        // Opened once: every tab after it is free.
        expect((await click(tabs[1]!)).requests).toEqual([]);
        // The cursor moved under the page: what it holds was read before, so it reads again, once...
        await page.evaluate(() => { S.cursor = 'moved-on'; });
        const stale = await click(tabs[2]!);
        expect(stale.requests).toEqual(['/api/settings']);
        expect(await page.getAttribute(`.sw__tab[href="${tabs[2]}"]`, 'aria-current')).toBe('page');
        // ...and then holds it under the new cursor.
        const after = await click(tabs[3]!);
        expect(after.requests).toEqual([]);
        expect(after.keptSelector).toBe(true);

        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);

      it('reads again after the poll has found that the server moved on, and holds that read', async () => {
        const w = await open('#/settings/dashboard', { height: HEIGHT });
        const { page } = w;
        try {
          const tabs = await page.$$eval('.sw__tab', (a) => a.map((x) => x.getAttribute('href')!));
          const click = (href: string) => probeTransition(page, () => page.click(`.sw__tab[href="${href}"]`));
          expect(await page.inputValue('#set-cadence')).not.toBe('end');
          // `eklavya config set cadence end`, from a terminal: the file changes under an open page.
          setCadenceOnDisk('end');
          // The page's own timer asks the server where it is, finds it elsewhere, and says so.
          await page.evaluate(() => poll());
          await page.waitForSelector('#stale:not([hidden])');
          // The page knows what it holds is out of date, so the next Settings draw reads, once, and shows the file.
          expect((await click(tabs[1]!)).requests).toEqual(['/api/settings']);
          expect((await click(tabs[0]!)).requests, 'the read is held').toEqual([]);
          expect(await page.inputValue('#set-cadence')).toBe('end');
          // Leaving Settings and coming back draws from that read too.
          await page.evaluate(() => { location.hash = '#/learning/concepts'; });
          await ready(page);
          const back = await probeTransition(page, () => page.evaluate(() => { location.hash = '#/settings/dashboard'; }));
          expect(back.requests).toEqual([]);
          expect(await page.inputValue('#set-cadence')).toBe('end');
          expect(w.errors).toEqual([]);
        } finally {
          await resetCadence();
          await w.ctx.close();
        }
      }, 60000);

      it('does not draw from a read that was out when the poll found that the server moved on', async () => {
        const w = await open('#/learning/concepts', { height: HEIGHT });
        const { page } = w;
        try {
          // The server answers before the file changes; the answer reaches the page after the poll has seen the change.
          let release = () => {};
          const held = new Promise<void>((r) => { release = r; });
          let answered = () => {};
          const early = new Promise<void>((r) => { answered = r; });
          await page.route('**/api/settings', async (route) => {
            const reply = await route.fetch();
            answered();
            await held;
            await route.fulfill({ response: reply });
          });
          await page.evaluate(() => { location.hash = '#/settings/dashboard'; });
          await early;
          setCadenceOnDisk('end');
          await page.evaluate(() => poll());
          await page.waitForSelector('#stale:not([hidden])');
          release();
          await ready(page);
          // The reader is shown the answer that arrived (the old one), and the page does not hold it as current.
          expect(await page.inputValue('#set-cadence')).not.toBe('end');
          await page.unroute('**/api/settings');
          const tabs = await page.$$eval('.sw__tab', (a) => a.map((x) => x.getAttribute('href')!));
          const r = await probeTransition(page, () => page.click(`.sw__tab[href="${tabs[1]}"]`));
          expect(r.requests, 'the next draw reads again').toEqual(['/api/settings']);
          await page.click(`.sw__tab[href="${tabs[0]}"]`);
          expect(await page.inputValue('#set-cadence')).toBe('end');
          expect(w.errors).toEqual([]);
        } finally {
          await resetCadence();
          await w.ctx.close();
        }
      }, 60000);

      it('is one screen whether it was reached as user settings or as preferences: the first tab pressed stays in the page', async () => {
        const w = await open('#/settings/user', { height: HEIGHT });
        const { page } = w;
        const tabs = await page.$$eval('.sw__tab', (a) => a.map((x) => x.getAttribute('href')!));
        await holdSidebar(page);
        const at = await scrollDown(page, 120);
        expect(at, 'the page is tall enough to have a place to lose').toBeGreaterThan(0);
        // The link the product itself makes (Feedback's "Open Settings", the project page's "user settings").
        const first = await probeTransition(page, () => page.click(`.sw__tab[href="${tabs[1]}"]`), { keep: '#settings .sw' });
        expect(first).toMatchObject({ hash: tabs[1], keptSelector: true, scrollBefore: at, scrollAfter: at, requests: [] });
        expect(await sidebarKept(page), 'the sidebar was rebuilt').toBe(true);
        expect(await sidebar(page)).toMatchObject({ current: ['dashboard'] });
        expect(await page.getAttribute(`.sw__tab[href="${tabs[1]}"]`, 'aria-current')).toBe('page');
        // Back goes to the route the reader arrived by, in place too.
        const back = await probeTransition(page, () => page.goBack(), { keep: '#settings .sw' });
        expect(back).toMatchObject({ hash: '#/settings/user', keptSelector: true, requests: [] });
        expect(await page.getAttribute(`.sw__tab[href="${tabs[0]}"]`, 'aria-current')).toBe('page');
        // And the tab after that is in place as well.
        const next = await probeTransition(page, () => page.click(`.sw__tab[href="${tabs[2]}"]`), { keep: '#settings .sw' });
        expect(next).toMatchObject({ hash: tabs[2], keptSelector: true, requests: [] });
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 30000);

      it('reads once for a load of the page, and a revisit of Settings costs nothing', async () => {
        const w = await open('#/learning/concepts', { height: HEIGHT });
        const { page } = w;
        const go = (hash: string) => probeTransition(page, () => page.evaluate((h) => { location.hash = h; }, hash));
        expect((await go('#/settings/dashboard')).requests, 'the first visit reads').toEqual(['/api/settings']);
        expect((await go('#/learning/concepts')).requests).toEqual([]);
        const back = await go('#/settings/dashboard');
        expect(back.requests, 'a revisit is drawn from what the page holds').toEqual([]);
        expect(back.sawLoader).toBe(false);
        expect(await page.locator('#settings .sw').count()).toBe(1);
        expect(await page.textContent('#settings .sw__pane h1')).toBe('User settings');
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 30000);

      it('reads again for another project and after a save, draws both scopes from one read, and not for the tab that follows', async () => {
        const w = await open('#/settings/dashboard', { height: HEIGHT });
        const { page } = w;
        try {
          // Another project is another response, and the switch (a navigation) drops the one held.
          const switched = await probeTransition(page, () => pickProject(page, fx.repo.mixed));
          expect(switched.requests).toEqual([`/api/settings?project=${enc(fx.repo.mixed)}`]);
          expect(await page.textContent('#settings .sw__pane h1')).toBe('User settings');
          const tabs = await page.$$eval('.sw__tab', (a) => a.map((x) => x.getAttribute('href')!));
          const next = await probeTransition(page, () => page.click(`.sw__tab[href^="${tabs[1]!.replace(/\?.*/, '')}"]`), { keep: '#settings .sw' });
          expect(next).toMatchObject({ requests: [], keptSelector: true });

          // The project's own page is in the same response: the project's scope link draws it with no read.
          const project = await probeTransition(page, () => page.click(`.sw__scope[href^="#/settings/project"][href*="project=${enc(fx.repo.mixed)}"]`));
          expect(project.hash).toMatch(/^#\/settings\/project\//);
          expect(project.requests, 'the project scope is in the response the page already holds').toEqual([]);
          expect(await page.textContent('#settings .sw__pane h1')).toBe('mixed settings');
          await probeTransition(page, () => page.click('.sw__scope[href^="#/settings/dashboard"]'));
          expect(await page.textContent('#settings .sw__pane h1')).toBe('User settings');

          // A save changes the file and reads it again, and what it read is what the next tab draws.
          await page.click(`.sw__tab[href^="${tabs[0]!.replace(/\?.*/, '')}"]`);
          await page.waitForSelector('#set-cadence', { state: 'attached' });
          await pickOption(page, '#set-cadence', 'end');
          await page.waitForSelector('[data-msg="cadence"].here:has-text("saved")');
          const changed = await probeTransition(page, () => page.click('.sw__tab[href*="/changed"]'), { keep: '#settings .sw' });
          expect(changed.requests).toEqual([]);
          expect(await page.textContent('#settings .sw__pane')).toMatch(/cadence[\s\S]*end/);
          // The tab the reader left: its control shows what was saved, and Reset puts the default back.
          await page.click(`.sw__tab[href="${tabs[0]}"]`);
          await page.waitForSelector('[data-unset="cadence"]');
          expect(await page.inputValue('#set-cadence')).toBe('end');
          await page.click('[data-unset="cadence"]');
          await page.waitForSelector('[data-msg="cadence"]:has-text("inherited")');
          expect(w.errors).toEqual([]);
        } finally {
          await resetCadence();
          await w.ctx.close();
        }
      }, 60000);

      it('draws the tab the reader chose when a save finishes after they moved on', async () => {
        const w = await open('#/settings/dashboard', { height: HEIGHT });
        const { page } = w;
        try {
          const tabs = await page.$$eval('.sw__tab', (a) => a.map((x) => x.getAttribute('href')!));
          // The save is slow to be answered, so the reader has time to click another tab while it is out:
          // that tab is drawn from what the page holds, which is what was read before the save.
          let release = () => {};
          const held = new Promise<void>((r) => { release = r; });
          await page.route('**/api/settings', async (route) => {
            if (route.request().method() === 'POST') await held;
            await route.continue();
          });
          await pickOption(page, '#set-cadence', 'end');
          await page.waitForSelector('[data-msg="cadence"]:has-text("saving")');
          await page.click(`.sw__tab[href="${tabs[1]}"]`);
          await page.waitForSelector(`.sw__tab[href="${tabs[1]}"][aria-current="page"]`);
          expect(await page.textContent('.sw__pane .counts'), 'drawn from what was read before the save').toContain('0 set here');
          release();
          // The tab the reader is on was drawn from what was read before the save. Once the save's read
          // lands, the page holds it, and the "Changed" tab (an adjustment: no read) lists the save.
          await page.waitForFunction(() => SETS?.user.set.cadence === 'end');
          // ...and the tab the reader is on is drawn again from it: its head says one setting is set here.
          await page.waitForFunction(() => /1 set here/.test(document.querySelector('.sw__pane .counts')?.textContent ?? ''));
          const changed = await probeTransition(page, () => page.click('.sw__tab[href*="/changed"]'), { keep: '#settings .sw' });
          expect(changed.requests).toEqual([]);
          expect(await page.textContent('.sw__pane')).toMatch(/cadence[\s\S]*end/);
          expect(w.errors).toEqual([]);
        } finally {
          await page.unroute('**/api/settings');
          await resetCadence();
          await w.ctx.close();
        }
      }, 60000);
    });

    it('holds the page-head selector the issue names: a heading block with the page__head class', async () => {
      const w = await open('#/learning/review', { height: HEIGHT });
      expect(await w.page.locator('#view > .page__head > h1.page__title').count()).toBe(1);
      expect(await w.page.evaluate((sel) => document.querySelector(sel)?.classList.contains('page__head'), PAGE_HEAD)).toBe(true);
      await w.ctx.close();
    });

    it('never asks for more than a fixture of requests: the artifacts gallery filters in place too', async () => {
      const w = await open('#/artifacts/dashboard', { height: HEIGHT });
      const { page } = w;
      expect(await scrollDown(page)).toBeGreaterThan(0);
      const at = await page.evaluate(() => window.scrollY);
      const r = await probeTransition(page, () => page.click('.chips [data-go*="explainer"]'));
      expect(r.hash).toContain('/artifacts/dashboard/explainer');
      expect(r).toMatchObject({ scrollBefore: at, scrollAfter: at, headKept: true, requests: [] });
      expect(await page.getAttribute('.chips [data-go*="explainer"]', 'aria-pressed')).toBe('true');
      // Typing in its search box redraws the gallery under it, and keeps the caret.
      await page.focus('#aq');
      await page.keyboard.type('que');
      expect(await page.inputValue('#aq')).toBe('que');
      expect(await focused(page, '#aq')).toBe(true);
      expect(await page.locator('.art').count()).toBe(1);
      expect(fix.other).toBeTruthy();
      await w.ctx.close();
    }, 30000);
  });
});
