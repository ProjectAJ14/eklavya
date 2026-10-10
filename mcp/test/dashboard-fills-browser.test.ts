// Split by feature so Vitest's file sharding can divide the browser work.
//
// Phase 2 of #171: no page paints a loader it does not need. A page the reader has seen is drawn
// again from what the page holds (no request, no loader); a page they have not seen reserves the
// room its content will take, so the footer does not move; a region that is replaced keeps showing
// what it had, dimmed and out of reach, until the answer draws. Each test holds a response back
// (or fails it) to look at the page while it waits, the way the reader would see it.
import fs from 'node:fs';
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { acknowledgeFeedback, insertFeedback } from '../src/feedback.js';
import { createArtifact } from '../dist/artifacts.js';
import { KEY, OPTS, db, enc, fix, fx, open, pickOption, pickProject, probeTransition, ready } from './dashboard-browser-helpers.js';

// Globals of the page under test (a script's `let` and `const` are reachable by name from `evaluate`, not from `window`).
declare const S: { cursor: string; artifacts: { id: string; title: string }[] };
declare const RESP: Map<string, { cursor: string; body: unknown }>;
declare const SLOT_H: Map<string, number>;
declare const TABS: { height: Map<string, string> };
declare function respGet(url: string): { body: unknown } | null;
declare function respPut(url: string, body: unknown, at: { cursor: string; gen: number }): void;
declare function respAt(): { cursor: string; gen: number };
declare function invalidateData(): void;
declare function poll(): void;

const HEIGHT = 600;
const go = (page: Page, hash: string) => () => page.evaluate((h) => { location.hash = h; }, hash);

/** The path and query of every request the page makes to `/api/`. */
function watch(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) seen.push(u.pathname + u.search); });
  return seen;
}

/**
 * Holds back the answer to every request that `glob` and `match` pick out until `release()`, and
 * remembers what was asked. A held request is a request the page is still waiting for: release it
 * before the test ends.
 */
async function hold(page: Page, glob: string | RegExp, match: (url: string) => boolean = () => true) {
  let release = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const asked: string[] = [];
  await page.route(glob, async (route) => {
    const url = route.request().url();
    if (!match(url)) return route.continue();
    asked.push(new URL(url).pathname + new URL(url).search);
    await gate;
    return route.continue();
  });
  return { release, asked };
}

/** How `#id` looks to the reader and to the pointer: dimmed, reachable, and what it says about being busy. */
const looks = (page: Page, selector: string) => page.$eval(selector, (el) => {
  const cs = getComputedStyle(el);
  return { opacity: cs.opacity, pointerEvents: cs.pointerEvents, busy: el.getAttribute('aria-busy'), kept: el.hasAttribute('data-kept'), failed: el.hasAttribute('data-failed') };
});

const rows = (page: Page, selector: string) => page.$$eval(selector, (r) => r.map((x) => (x.textContent ?? '').replace(/\s+/g, ' ').trim()));

describe('the page source', () => {
  const html = fs.readFileSync(new URL('../src/assets/dashboard.html', import.meta.url), 'utf8');

  it('documents the room every region that is fetched reserves on a first visit', () => {
    // A region that waits with no height to hold moves the footer when it draws: a new `slot()` gets an estimate.
    const used = new Set([...html.matchAll(/\bslot\('([\w-]+)'/g)].map((m) => m[1]));
    const table = /const SLOT_MIN = \{([^}]*)\}/.exec(html)![1]!;
    const documented = new Set([...table.matchAll(/'?([\w-]+)'?\s*:\s*\d+/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThanOrEqual(10);
    expect([...used].filter((id) => !documented.has(id!)), 'slots with no default').toEqual([]);
    expect([...documented].filter((id) => !used.has(id!)), 'defaults for no slot').toEqual([]);
  });

  it('gives a fetched region its target through slot(), never by calling fill() itself', () => {
    // `fill` is the engine `slot()` queues; a view that called it itself would paint no box and keep no rows.
    expect([...html.matchAll(/(?<![\w.])fill\(/g)].length, 'calls of fill( outside its own definition and slot()').toBe(2);
  });
});

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('a page the reader has seen comes back with no request and no loader', () => {
    it('on Back and on Forward, through every page that reads a resource of its own', async () => {
      const w = await open('#/learning/domains', { height: HEIGHT });
      const { page } = w;
      const tour = [
        '#/memory/dashboard', '#/memory/timeline', `#/memory/entry/${fx.entries.mixed}`, '#/memory/sessions', '#/memory/session/s-mixed',
        '#/feedback/history', '#/settings/dashboard', `#/artifacts/view/${enc(fix.other)}`,
      ];
      for (const hash of tour) {
        const first = await probeTransition(page, go(page, hash));
        expect(first.hash).toBe(hash);
      }
      // Back through them all and forward again: every step is a page already seen.
      const trail = [...tour].reverse();
      for (const hash of trail.slice(1)) {
        const r = await probeTransition(page, () => page.goBack());
        expect(r.hash, 'Back').toBe(hash);
        expect(r.requests, `Back to ${hash}`).toEqual([]);
        expect(r.sawLoader, `Back to ${hash}`).toBe(false);
      }
      for (const hash of tour.slice(1)) {
        const r = await probeTransition(page, () => page.goForward());
        expect(r.hash, 'Forward').toBe(hash);
        expect(r.requests, `Forward to ${hash}`).toEqual([]);
        expect(r.sawLoader, `Forward to ${hash}`).toBe(false);
      }
      // What it holds is the parsed answer, never markup: the draw runs on it again each time.
      expect(await page.evaluate(() => [...RESP.values()].every((e) => typeof e.body === 'object' && e.body !== null))).toBe(true);
      expect(w.errors).toEqual([]);
      expect(w.outbound).toEqual([]);
      await w.ctx.close();
    }, 120000);

  });

  describe('a page that has not been seen keeps the footer where it will end up', () => {
    it('reserves a box with the loader in it, and the last height seen for that region the next time', async () => {
      const w = await open('#/learning/domains', { height: HEIGHT });
      const { page } = w;
      const first = await hold(page, '**/api/memory/entry?*');
      await page.evaluate((h) => { location.hash = h; }, `#/memory/entry/${fx.entries.mixed}`);
      await page.waitForSelector('#entry-body > .slot__wait .loader');
      // Nothing is known about an entry yet: the documented default, held by the box, not by the loader inside it.
      const box = await page.$eval('#entry-body > .slot__wait', (b) => ({ min: getComputedStyle(b).minHeight, height: b.getBoundingClientRect().height }));
      expect(box.min).toBe('650px');
      expect(box.height).toBeGreaterThanOrEqual(650);
      // The mascot still waits before it shows, and nothing in this phase animates.
      expect(await page.$eval('#entry-body .loader', (l) => getComputedStyle(l).animationDelay)).toBe('0.15s');
      expect(await page.$eval('#entry-body > .slot__wait', (b) => getComputedStyle(b).animationName)).toBe('none');
      first.release();
      await ready(page);
      const seen = await page.evaluate(() => SLOT_H.get('entry-body')!);
      expect(seen).toBeGreaterThan(0);
      expect(seen).not.toBe(650);

      // Another entry: a page not seen, so it waits, in a box as tall as the entry before it drew.
      const second = await hold(page, '**/api/memory/entry?*');
      await page.evaluate((h) => { location.hash = h; }, `#/memory/entry/${fx.entries.memoryOnly}`);
      await page.waitForSelector('#entry-body > .slot__wait');
      expect(await page.$eval('#entry-body > .slot__wait', (b) => getComputedStyle(b).minHeight)).toBe(`${seen}px`);
      second.release();
      await ready(page);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('adds no animation and nothing for reduced motion to switch off', async () => {
      const w = await open('#/learning/domains', { height: HEIGHT });
      const { page } = w;
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const gate = await hold(page, '**/api/memory/entry?*');
      await page.evaluate((h) => { location.hash = h; }, `#/memory/entry/${fx.entries.mixed}`);
      await page.waitForSelector('#entry-body > .slot__wait');
      // The box and the target are plain: no animation, no transition. (The loader's own fade is the
      // shared mascot stylesheet's, and it is the one that honours the preference.)
      const style = await page.$eval('#entry-body', (el) => {
        const box = getComputedStyle(el.querySelector('.slot__wait')!);
        const host = getComputedStyle(el);
        return { boxAnimation: box.animationName, hostAnimation: host.animationName, hostTransition: host.transitionDuration };
      });
      expect(style).toEqual({ boxAnimation: 'none', hostAnimation: 'none', hostTransition: '0s' });
      gate.release();
      await ready(page);
      await w.ctx.close();
    });

    it('shows an error as it always did, and asks again the next time: a failure is never cached', async () => {
      const w = await open('#/learning/domains', { height: HEIGHT });
      const { page } = w;
      await page.evaluate(() => { location.hash = '#/memory/entry/987654'; });
      await page.waitForFunction(() => /Could not load: 404/.test(document.getElementById('entry-body')?.textContent ?? ''));
      // Not dimmed, not out of reach, not busy: the message is the page.
      expect(await looks(page, '#entry-body')).toEqual({ opacity: '1', pointerEvents: 'auto', busy: null, kept: false, failed: true });
      expect(await page.evaluate(() => [...RESP.keys()].some((k) => k.includes('987654')))).toBe(false);
      const asked = watch(page);
      await page.evaluate(() => { location.hash = '#/learning/domains'; });
      await ready(page);
      await page.evaluate(() => { location.hash = '#/memory/entry/987654'; });
      await page.waitForFunction(() => /Could not load: 404/.test(document.getElementById('entry-body')?.textContent ?? ''));
      expect(asked.filter((a) => a.includes('987654'))).toHaveLength(1);
      // Each failed read is the browser's own console error, and the only ones.
      expect(w.errors).toEqual([expect.stringMatching(/status of 404/), expect.stringMatching(/status of 404/)]);
      await w.ctx.close();
    }, 30000);
  });

  describe('a region that is replaced keeps what it showed until the answer draws', () => {
    it('dims it, puts it out of reach of the pointer, and gives it back on draw', async () => {
      const w = await open('#/memory/timeline', { height: 900 });
      const { page } = w;
      await page.waitForSelector('#mem-rows [data-entry]');
      expect(await looks(page, '#mem-rows')).toEqual({ opacity: '1', pointerEvents: 'auto', busy: null, kept: false, failed: false });
      const before = await page.$$eval('#mem-rows [data-entry]', (r) => r.length);
      const gate = await hold(page, '**/api/memory?*', (u) => u.includes('tag=auth'));
      await pickOption(page, '#mtag', 'auth');
      await page.waitForFunction(() => document.getElementById('mem-rows')!.getAttribute('aria-busy') === 'true');
      expect(await looks(page, '#mem-rows')).toEqual({ opacity: '0.55', pointerEvents: 'none', busy: 'true', kept: true, failed: false });
      // What the reader was looking at is still there, still readable, and no loader has been drawn over it.
      expect(await page.$$eval('#mem-rows [data-entry]', (r) => r.length)).toBe(before);
      expect(await page.locator('#view .loader').count()).toBe(0);
      expect(await page.$eval('#mem-rows', (el) => el.textContent!.length)).toBeGreaterThan(40);

      // A click on a row lands on nothing: the second entry does not open.
      const box = (await page.locator('#mem-rows [data-entry] > summary').nth(1).boundingBox())!;
      expect(await page.evaluate(([x, y]) => !!document.elementFromPoint(x!, y!)?.closest('#mem-rows'), [box.x + 20, box.y + 8])).toBe(false);
      await page.mouse.click(box.x + 20, box.y + 8);
      expect(await page.locator('#mem-rows [data-entry]').nth(1).evaluate((d) => (d as HTMLDetailsElement).open)).toBe(false);

      gate.release();
      await page.waitForFunction(() => !document.getElementById('mem-rows')!.hasAttribute('aria-busy'));
      expect(await looks(page, '#mem-rows')).toEqual({ opacity: '1', pointerEvents: 'auto', busy: null, kept: false, failed: false });
      expect(await page.$$eval('#mem-rows [data-entry]', (r) => r.length)).toBe(2);
      // Alive again: a click on a row opens it.
      await page.locator('#mem-rows [data-entry] > summary').nth(1).click();
      expect(await page.locator('#mem-rows [data-entry]').nth(1).evaluate((d) => (d as HTMLDetailsElement).open)).toBe(true);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 30000);

    it('is cleared at once when the page returns to an answer it holds, and the late answer is kept, not drawn', async () => {
      const w = await open('#/memory/timeline', { height: HEIGHT });
      const { page } = w;
      const all = await rows(page, '#mem-rows [data-entry]');
      expect(all).toHaveLength(5);
      const asked = watch(page);
      const gate = await hold(page, '**/api/memory?*', (u) => u.includes('tag=auth'));
      await pickOption(page, '#mtag', 'auth');
      await page.waitForFunction(() => document.getElementById('mem-rows')!.getAttribute('aria-busy') === 'true');
      // Back to every tag while the auth answer is out: the page holds that one, so it is drawn now, at once,
      // and nothing is left dimmed by the request that is still out.
      await pickOption(page, '#mtag', 'all');
      await page.waitForFunction(() => location.hash === '#/memory/timeline' && !document.getElementById('mem-rows')!.hasAttribute('aria-busy'));
      expect(await rows(page, '#mem-rows [data-entry]')).toEqual(all);
      expect(await looks(page, '#mem-rows')).toEqual({ opacity: '1', pointerEvents: 'auto', busy: null, kept: false, failed: false });
      expect(asked, 'only the held request was made').toEqual([expect.stringContaining('tag=auth')]);

      // The answer that was out lands: the reader is on another list, so it is not drawn...
      gate.release();
      await page.waitForFunction(() => RESP.size > 0 && [...RESP.keys()].some((k) => k.includes('tag=auth')));
      await page.waitForTimeout(300);
      expect(await rows(page, '#mem-rows [data-entry]')).toEqual(all);
      // ...but it was read, so it is there when the reader asks for it.
      const again = await probeTransition(page, () => pickOption(page, '#mtag', 'auth'));
      expect(again.requests).toEqual([]);
      expect(again.sawLoader).toBe(false);
      expect(await page.$$eval('#mem-rows [data-entry]', (r) => r.length)).toBe(2);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('keeps a region the whole view is rebuilt around: the same rows, dimmed, then the new ones', async () => {
      // The Memory Dashboard's two lists are not regions of their own, so a redraw of the screen (a resize,
      // new data) replaces the view. What they showed is carried into the new view, node for node.
      const w = await open('#/memory/dashboard', { height: HEIGHT });
      const { page } = w;
      await page.waitForSelector('#mem-recent .lines > li');
      const held = await hold(page, /\/api\/memory(\/sessions)?\?/);
      await page.evaluate(() => {
        const w = window as any;
        w.__rows = document.querySelector('#mem-recent')!.firstElementChild;
        w.__loaders = 0;
        new MutationObserver((records) => {
          for (const r of records) for (const n of r.addedNodes) if (n instanceof Element && (n.matches('.loader') || n.querySelector('.loader'))) w.__loaders++;
        }).observe(document.getElementById('view')!, { childList: true, subtree: true });
        // The data under the page changed, and the screen is drawn again.
        invalidateData();
      });
      await page.setViewportSize({ width: 1100, height: HEIGHT });
      await page.waitForFunction(() => document.getElementById('mem-recent')!.getAttribute('aria-busy') === 'true' && document.getElementById('mem-sessions')!.getAttribute('aria-busy') === 'true');
      expect(await looks(page, '#mem-recent')).toMatchObject({ opacity: '0.55', pointerEvents: 'none', kept: true });
      expect(await page.evaluate(() => (window as any).__rows === document.querySelector('#mem-recent')!.firstElementChild), 'the same nodes').toBe(true);
      expect(await page.evaluate(() => (window as any).__loaders)).toBe(0);
      // The keyboard is held back as the pointer is: a row the reader can Tab to goes nowhere on Enter while it is dimmed.
      await page.focus('#mem-recent li[data-go]');
      expect(await page.evaluate(() => document.activeElement?.matches('#mem-recent li[data-go]'))).toBe(true);
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => location.hash)).toBe('#/memory/dashboard');
      held.release();
      await page.waitForFunction(() => !document.getElementById('mem-recent')!.hasAttribute('aria-busy') && !document.getElementById('mem-sessions')!.hasAttribute('aria-busy'));
      expect(await looks(page, '#mem-recent')).toMatchObject({ opacity: '1', pointerEvents: 'auto', kept: false });
      expect(await page.evaluate(() => (window as any).__rows === document.querySelector('#mem-recent')!.firstElementChild), 'the new answer replaced them').toBe(false);
      expect(await page.evaluate(() => (window as any).__loaders)).toBe(0);
      // Given back: the same key on the same kind of row opens the entry.
      await page.focus('#mem-recent li[data-go]');
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => location.hash.startsWith('#/memory/entry/'));
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 30000);
  });

  describe('what the response cache holds, and when it lets go', () => {
    it('is bounded at fifty answers, least recently used out first, and holds only what is current', async () => {
      const w = await open('#/learning/domains', { height: HEIGHT });
      const { page } = w;
      const r = await page.evaluate(() => {
        RESP.clear();
        const at = respAt();
        for (let i = 0; i < 50; i++) respPut(`/k${i}`, { i }, at);
        const full = RESP.size;
        respGet('/k0');                      // read: now the most recently used
        respPut('/k50', { i: 50 }, at);      // one over: the least recently used goes, and that is /k1
        const after = { size: RESP.size, k0: RESP.has('/k0'), k1: RESP.has('/k1'), k50: RESP.has('/k50') };
        // An answer read under another cursor is not what the page is showing.
        S.cursor = 'moved-on';
        const stale = respGet('/k0');
        const gone = RESP.has('/k0');
        // A read that was out when the cache was dropped is not stored when it lands.
        S.cursor = at.cursor;
        const out = respAt();
        invalidateData();
        respPut('/late', { i: 99 }, out);
        return { full, after, stale, gone, late: RESP.has('/late'), size: RESP.size };
      });
      expect(r).toEqual({ full: 50, after: { size: 50, k0: true, k1: false, k50: true }, stale: null, gone: false, late: false, size: 0 });
      await w.ctx.close();
    });

    it('is dropped when the page finds that the server moved on, and by a save, and kept across a project switch', async () => {
      const w = await open('#/memory/timeline', { height: HEIGHT });
      const { page } = w;
      const keys = () => page.evaluate(() => [...RESP.keys()]);
      expect((await keys()).length).toBeGreaterThan(0);

      // Another project is another key: switching to it and back costs the one read, and then nothing.
      await pickProject(page, fx.repo.mixed);
      await ready(page);
      const scoped = (await keys()).filter((k) => k.startsWith('/api/memory'));
      expect(scoped.length).toBe(2);
      expect(scoped.filter((k) => k.includes(`project=${enc(fx.repo.mixed)}`))).toHaveLength(1);
      const asked = watch(page);
      await pickProject(page, '');
      await ready(page);
      await pickProject(page, fx.repo.mixed);
      await ready(page);
      expect(asked.filter((a) => a.startsWith('/api/memory')), 'both are held, so neither is read again').toEqual([]);

      // A save drops it, and what the save read back is the one answer left.
      await page.evaluate(() => { location.hash = '#/settings/dashboard'; });
      await ready(page);
      await pickOption(page, '#set-cadence', 'end');
      await page.waitForSelector('[data-msg="cadence"].here:has-text("saved")');
      expect(await keys()).toEqual([expect.stringContaining('/api/settings')]);
      // Put the default back, which is a save too.
      await page.click('[data-unset="cadence"]');
      await page.waitForSelector('[data-msg="cadence"]:has-text("inherited")');

      // The page's own timer finds the cursor elsewhere: what it holds is out of date.
      await page.evaluate(() => { location.hash = '#/memory/timeline'; });
      await ready(page);
      expect((await keys()).length).toBeGreaterThan(1);
      await page.evaluate(() => { S.cursor = 'an-older-page'; });
      await page.evaluate(() => poll());
      await page.waitForSelector('#stale:not([hidden])');
      expect(await keys()).toEqual([]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 90000);

    it('puts the project in the key of every answer that depends on it', async () => {
      const w = await open('#/learning/domains', { height: HEIGHT });
      const { page } = w;
      await pickProject(page, fx.repo.mixed);
      await ready(page);
      const fb = insertFeedback(db, {
        session_id: 's-fills', project: fx.repo.mixed, event_id: null, prompt: 'fix the login bug', model: 'sonnet',
        review: { worked: 'You named the bug.', gaps: [] } as never, better: 'Fix the login bug in [the file].', tips: ['Name the file.'],
      })!;
      acknowledgeFeedback(db, fb);
      try {
        const scope = `?project=${enc(fx.repo.mixed)}`;
        // The last is a session the payload does not know, which is looked up through the scope as well.
        for (const route of ['memory/dashboard', 'memory/timeline', 'memory/sessions', 'feedback/history', 'settings/dashboard', 'learning/session/s-mem']) {
          await page.evaluate((h) => { location.hash = h; }, `#/${route}${scope}`);
          await ready(page);
        }
        const keys = await page.evaluate(() => [...RESP.keys()]);
        // Answers about a scope carry it. One about a single thing (an entry, a session's rows) is keyed by that thing.
        const scoped = keys.filter((k) => /^\/api\/(memory\?(?!.*\bsession=)|memory\/sessions|feedback\/list|settings)/.test(k));
        expect(scoped.length).toBeGreaterThanOrEqual(5);
        for (const k of scoped) expect(k, k).toContain(`project=${enc(fx.repo.mixed)}`);
      } finally {
        db.prepare('DELETE FROM feedback_items WHERE id = ?').run(fb);
      }
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('lets go of feedback it read when an item is acknowledged, and of a correction when one is made', async () => {
      const pending = insertFeedback(db, {
        session_id: 's-fills-pending', project: fx.repo.mixed, event_id: null, prompt: 'make it faster', model: 'sonnet',
        review: { worked: 'A goal.', gaps: [{ area: 'outcome', missing: 'Faster than what.' }] } as never, better: 'Make it faster than [the baseline].', tips: ['Say how fast.'],
      })!;
      const attempt = fix.missed();
      const art = createArtifact({ title: 'Mutexes, explained', kind: 'explainer', concept: 'csrf', attempt });
      try {
        const w = await open('#/feedback/history', { height: 900 });
        const { page } = w;
        // The history has been read; so has the item that waits.
        await page.evaluate(() => { location.hash = '#/feedback/dashboard'; });
        await page.waitForSelector('[data-fb-ack]');
        expect(await page.evaluate(() => [...RESP.keys()].filter((k) => k.startsWith('/api/feedback')).length)).toBe(2);
        await page.click('[data-fb-ack]');
        await page.waitForFunction(() => /nothing waiting/.test(document.getElementById('view')!.textContent ?? ''));
        expect(await page.evaluate(() => [...RESP.keys()].filter((k) => k.startsWith('/api/feedback')))).toEqual([]);
        // The history is read again, and shows the item that was just acknowledged.
        const again = await probeTransition(page, go(page, '#/feedback/history'));
        expect(again.requests).toEqual(['/api/feedback/list?page=1']);
        expect(await page.textContent('#fb-rows')).toContain('make it faster');

        // A correction: the bar is drawn from what was read, the pick is a write, and the next visit reads it again.
        const view = `#/artifacts/view/${enc(art.id)}`;
        await probeTransition(page, go(page, view));
        expect(await page.textContent('#fixbar')).toContain('You missed this one');
        expect(await page.evaluate(() => [...RESP.keys()].some((k) => k.startsWith('/api/attempts/correction')))).toBe(true);
        await page.click('#fix-open');
        await page.click(`#fix-opts [data-pick="${KEY.options[1]}"]`);
        await page.waitForSelector('#fix-msg:has-text("Corrected.")');
        expect(await page.evaluate(() => [...RESP.keys()].some((k) => k.startsWith('/api/attempts/correction')))).toBe(false);
        await page.click('#fix-close');
        await probeTransition(page, go(page, '#/artifacts/dashboard'));
        const reopened = await probeTransition(page, go(page, view));
        expect(reopened.requests).toEqual([`/api/attempts/correction?id=${attempt}`]);
        expect(await page.textContent('#fixbar')).toContain('Corrected on try 1');
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      } finally {
        db.prepare('DELETE FROM feedback_items WHERE id = ?').run(pending);
      }
    }, 90000);
  });

  describe('the explainer viewer', () => {
    const plain = (page: Page) => page.evaluate(() => S.artifacts.find((a) => a.title === 'Why CSRF needs SameSite')!.id);

    it('opens in a box the size of the frame, with the loader in it, and remembers the height the page reported', async () => {
      const w = await open('#/artifacts/dashboard', { height: HEIGHT });
      const { page } = w;
      const id = await plain(page);
      const hash = `#/artifacts/view/${enc(id)}`;
      const geometry = () => page.evaluate(() => {
        const f = document.getElementById('art-frame')!;
        const wait = document.getElementById('art-wait');
        return {
          frame: f.clientHeight, inline: f.style.height, box: f.parentElement!.clientHeight, vh: innerHeight,
          wait: wait ? { inBox: f.parentElement!.contains(wait), position: getComputedStyle(wait).position } : null,
          loaders: document.querySelectorAll('#view .loader').length,
        };
      });

      // The first time: the frame holds 80vh before its page has said how tall it is, the loader sits over it
      // and takes up no room of its own, so opening a tab is one move, when the real height arrives.
      const first = await hold(page, '**/artifacts/**', (u) => u.includes('?embed'));
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForSelector('#art-frame');
      expect(await geometry()).toEqual({ frame: Math.round(HEIGHT * 0.8), inline: '', box: Math.round(HEIGHT * 0.8), vh: HEIGHT, wait: { inBox: true, position: 'absolute' }, loaders: 1 });
      first.release();
      await page.waitForFunction(() => /^\d+px$/.test(document.getElementById('art-frame')!.style.height));
      const reported = await page.$eval('#art-frame', (f) => (f as HTMLElement).style.height);
      expect(await page.evaluate((i) => TABS.height.get(i), id)).toBe(reported);
      expect(await page.locator('#art-wait').count()).toBe(0);

      // The second time the frame is that tall from the first paint, and there is no loader at all.
      await probeTransition(page, go(page, '#/artifacts/dashboard'));
      const second = await hold(page, '**/artifacts/**', (u) => u.includes('?embed'));
      await page.evaluate((h) => { location.hash = h; }, hash);
      await page.waitForSelector('#art-frame');
      expect(await geometry()).toEqual({ frame: parseInt(reported), inline: '', box: parseInt(reported), vh: HEIGHT, wait: null, loaders: 0 });
      second.release();
      await page.waitForFunction((r) => document.getElementById('art-frame')!.style.height === r, reported);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('does not move the footer twice for a page that is taller than the box, nor squeeze it for one that is shorter', async () => {
      const w = await open('#/artifacts/dashboard', { height: HEIGHT });
      const { page } = w;
      const id = await plain(page);
      const r = await probeTransition(page, go(page, `#/artifacts/view/${enc(id)}`));
      // The frame is in the page from the first paint, so the view is never lower than where it ends or began.
      expect(r.footerBounced).toBe(false);
      expect(r.minHeight).toBeGreaterThanOrEqual(Math.min(r.beforeHeight, r.finalHeight) - 4);
      await w.ctx.close();
    });

    it('draws the correction bar from what it read, with no loader, when the tab is opened again', async () => {
      const w = await open(`#/artifacts/view/${enc(fix.other)}`, { height: HEIGHT });
      const { page } = w;
      expect(await page.textContent('#fixbar')).toContain('You missed this one');
      await probeTransition(page, go(page, '#/artifacts/dashboard'));
      const again = await probeTransition(page, go(page, `#/artifacts/view/${enc(fix.other)}`));
      expect(again.requests).toEqual([]);
      expect(again.sawLoader).toBe(false);
      expect(await page.textContent('#fixbar')).toContain('You missed this one');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 30000);
  });
});
