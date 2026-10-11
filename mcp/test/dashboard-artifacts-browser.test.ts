// Split by feature so Vitest's file sharding can divide the browser work.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createArtifact } from '../dist/artifacts.js';
import { gradeConcept, recordRetry } from '../src/store.js';
import type { Watched } from './dashboard-browser-helpers.js';
import { KEY, OPTS, base, db, enc, fix, fx, open, ready } from './dashboard-browser-helpers.js';

/** The page's artifact tabs and payload, top-level bindings of its script. */
declare const TABS: { scroll: Map<string, number> };
declare const S: { cursor: string };

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('artifacts', () => {
    it('searches as you type, and opens a page here, or in a new tab that cannot read the dashboard', async () => {
      const w = await open('#/artifacts/dashboard');
      const link = w.page.locator('#view .art:not(:has(.tag)) .art__open');
      expect(await link.count()).toBe(1);
      expect(await link.getAttribute('href')).toMatch(/^#\/artifacts\/view\/.+\.html$/);
      expect(await link.getAttribute('target')).toBeNull();
      // The card's thumbnail loads, and follows the ground when it changes.
      const img = link.locator('img[data-thumb]');
      await img.evaluate((i: HTMLImageElement) => i.decode());
      expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
      await w.page.evaluate(() => (window as any).eklavyaGround.set('paper'));
      expect(await img.getAttribute('src')).toContain('thumb=paper');
      await w.page.evaluate(() => (window as any).eklavyaGround.set('ink'));

      await w.page.fill('#aq', 'no such page');
      expect(await link.count()).toBe(0);
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('aq');
      await w.page.fill('#aq', 'samesite');
      expect(await link.count()).toBe(1);

      await link.click();
      await ready(w.page);
      const out = w.page.locator('#view .viewer__bar a');
      expect(await out.textContent()).toContain('Open in new browser tab');
      expect(await out.getAttribute('target')).toBe('_blank');
      expect(await out.getAttribute('rel')).toBe('noopener');
      const href = await out.getAttribute('href');
      expect(href).toMatch(/^\/artifacts\/.+\.html$/);
      const tab = await w.ctx.newPage();
      await tab.goto(base + href);
      expect(await tab.locator('h1').textContent()).toBe('Why CSRF needs SameSite');
      const read = await tab.evaluate(() => fetch('/api/state').then(() => 'read', () => 'blocked'));
      expect(read).toBe('blocked');
      await w.ctx.close();
    });

    it("saves the page itself from the viewer's HTML button: no frame code, and it scrolls on its own", async () => {
      const w = await open('#/artifacts/dashboard');
      await w.page.locator('#view .art:not(:has(.tag)) .art__open').click();
      await ready(w.page);
      const frame = w.page.frames().find((f) => f.url().includes('?embed'))!;
      // The framed page hides its own overflow while the viewer sizes it...
      expect(await frame.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe('hidden');
      const [download] = await Promise.all([
        w.page.waitForEvent('download'),
        frame.locator('.actions button', { hasText: 'HTML' }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/\.html$/);
      const html = fs.readFileSync((await download.path())!, 'utf8');
      // ...but the file it hands over carries none of the viewer's additions.
      expect(html).not.toMatch(/overflow-y:hidden|__eklavyaEmbed|eklavya:height|class="[^"]*framed/);
      expect(html).toContain('function saveHtml()');
      const saved = path.join(process.env.EKLAVYA_HOME!, 'saved.html');
      fs.writeFileSync(saved, html.replace('<!-- CONTENT', '<p>line</p>'.repeat(200) + '<!-- CONTENT'));
      const tab = await w.ctx.newPage();
      await tab.goto('file://' + saved);
      expect(await tab.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
      await tab.evaluate(() => scrollTo(0, 1000));
      expect(await tab.evaluate(() => scrollY)).toBeGreaterThan(0);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });
  });

  describe('correcting a missed answer', () => {
    const armed = (page: Page) => page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      dispatchEvent(e);
      return e.defaultPrevented;
    });

    it('shows a To be corrected tile on both Dashboards that opens the To correct list', async () => {
      for (const route of ['#/learning/dashboard', '#/artifacts/dashboard']) {
        const w = await open(route);
        const tile = w.page.locator('#view .tile', { hasText: 'To be corrected' });
        expect(await tile.locator('strong').textContent()).toBe('2');
        expect(await tile.getAttribute('class')).toContain('is-warn');
        await tile.click();
        expect(await w.page.evaluate(() => location.hash)).toBe('#/artifacts/dashboard/to-correct');
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }
      // Scoped to a project that has no explainers waiting, it reads zero and stops warning.
      const w = await open(`#/learning/dashboard?project=${enc(fx.repo.mixed)}`);
      const tile = w.page.locator('#view .tile', { hasText: 'To be corrected' });
      expect(await tile.locator('strong').textContent()).toBe('0');
      expect(await tile.locator('span').textContent()).toBe('nothing to correct');
      expect(await tile.getAttribute('class')).not.toContain('is-warn');
      await w.ctx.close();
    });

    it('frames the explainer sandboxed, corrects it in the modal and flips the bar and the gallery', async () => {
      const w = await open('#/artifacts/dashboard/to-correct');
      const card = w.page.locator(`#view a[href*="${enc(fix.open)}"]`);
      expect(await w.page.locator('#view .art').count()).toBe(2);
      expect(await w.page.textContent('#view')).toContain('To correct');
      await card.click();
      await ready(w.page);
      expect(await w.page.evaluate(() => location.hash)).toBe(`#/artifacts/view/${enc(fix.open)}`);
      const frame = w.page.locator('#art-frame');
      expect(await frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
      // The page reported its own height (ready() waits for it), so the two scroll as one document.
      expect(await frame.evaluate((f: HTMLIFrameElement) => f.style.height)).toMatch(/^\d+px$/);
      expect(await w.page.textContent('#fixbar')).toContain('Not now? It stays under To correct.');
      expect(await armed(w.page)).toBe(true);

      const barHeight = () => w.page.evaluate(() => document.getElementById('fixbar')!.getBoundingClientRect().height);
      const openHeight = await barHeight();
      const cursorBefore = await w.page.evaluate(() => S.cursor);
      await w.page.click('#fix-open');
      expect(await w.page.evaluate(() => (document.getElementById('fix') as HTMLDialogElement).open)).toBe(true);
      const labels = await w.page.$$eval('#fix-opts .fix__opt', (b) => b.map((x) => (x as HTMLElement).dataset.pick));
      expect([...labels].sort()).toEqual([...KEY.options].sort());
      expect(await w.page.textContent('#fix-opts')).toContain('serialises writers');
      // The options are keyboard-walkable: an arrow moves focus to the next one.
      const first = await w.page.evaluate(() => (document.activeElement as HTMLElement).dataset.pick);
      await w.page.keyboard.press('ArrowDown');
      expect(await w.page.evaluate(() => (document.activeElement as HTMLElement).dataset.pick)).not.toBe(first);

      await w.page.click('#fix-opts [data-pick="A queue"]');
      await w.page.waitForSelector('#fix-msg:has-text("Still incorrect. Please correct your answer.")');
      expect(await w.page.getAttribute('#fix-msg eklavya-mascot', 'state')).toBe('tip');
      expect(await w.page.isDisabled('#fix-opts [data-pick="A queue"]')).toBe(true);
      expect(await w.page.textContent('#fix-opts [data-pick="A queue"]')).toContain('Not this one');
      expect(await w.page.isDisabled('#fix-opts [data-pick="A lock"]')).toBe(false);

      await w.page.focus('#fix-opts [data-pick="A lock"]');
      await w.page.keyboard.press('Enter');
      await w.page.waitForSelector('#fix-msg:has-text("Corrected. Your accuracy now counts this as right.")');
      expect(await w.page.textContent('#fix-opts [data-pick="A lock"]')).toContain('Right answer');
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('fix-close');
      // The rest of the page follows by itself: the server saw the write and told the page, which read the payload
      // again and drew it in place. There is no notice to press and no reload, and what is open in front of the
      // reader (this dialog, the bar behind it, the frame) is left as it is.
      expect(await w.page.locator('#stale').count()).toBe(0);
      await w.page.waitForFunction((c) => S.cursor !== c, cursorBefore, { timeout: 4000 });
      expect(await w.page.evaluate(() => (document.getElementById('fix') as HTMLDialogElement).open)).toBe(true);
      expect(await w.page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
      expect(await armed(w.page)).toBe(false);
      await w.page.keyboard.press('Enter');
      await w.page.waitForFunction(() => /Corrected on try 2 · /.test(document.getElementById('fixbar')?.textContent ?? ''));
      // The bar changes state in place: same height, so nothing under or above it moves.
      expect(await barHeight()).toBe(openHeight);
      expect(db.prepare('SELECT picked, correct FROM attempt_retries WHERE attempt_id = ? ORDER BY id').all(fix.attempt))
        .toEqual([{ picked: 'A queue', correct: 0 }, { picked: 'A lock', correct: 1 }]);

      // Its tab's dot turned with it.
      expect(await w.page.locator('#view [role="tab"][aria-selected="true"] .tab__dot.is-done').count()).toBe(1);
      await w.page.click('#view [role="tab"]:has-text("All artifacts")');
      await ready(w.page);
      expect(await w.page.textContent(`#view .art:has(a[href*="${enc(fix.open)}"])`)).toContain('Corrected');
      expect(await w.page.textContent('#view .tile:has-text("To be corrected") strong')).toBe('1');
      expect(w.errors).toEqual([]);
      expect(w.outbound).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('counts a corrected miss as right on the Accuracy tile and in its session, out of the same answers', async () => {
      const miss = gradeConcept(db, {
        conceptId: (db.prepare(`SELECT id FROM concepts WHERE slug = 'csrf'`).get() as { id: number }).id,
        sessionId: 's-acc', question: 'Which one serialises writers?', answer: 'A cache', grade: 1, difficulty: 2,
        feedback: null, outcome: 'answered', format: 'mcq', options: KEY.options, correct: 'A lock', optionNotes: KEY.notes,
        repo: null, level: null, now: new Date(),
      }).attemptId;
      const tile = async (w: Watched) => {
        const [, right, of] = (await w.page.textContent('#view'))!.match(/(\d+) right of (\d+)/)!;
        return [Number(right), Number(of)];
      };
      const before = await open('#/learning/dashboard');
      const [right, of] = await tile(before);
      await before.ctx.close();
      const session = await open('#/learning/session/s-acc');
      expect(await session.page.textContent('#view')).toContain('0/1 right (0%)');
      await session.ctx.close();

      recordRetry(db, miss, 'A lock', new Date());
      const after = await open('#/learning/dashboard');
      expect(await tile(after)).toEqual([right + 1, of]);
      await after.page.goto(base + '/#/learning/session/s-acc'); await ready(after.page);
      expect(await after.page.textContent('#view')).toContain('1/1 right (100%)');
      expect(after.errors).toEqual([]);
      await after.ctx.close();
    });

    it('asks before leaving only while a correction is open, and Escape is "not now"', async () => {
      const w = await open(`#/artifacts/view/${enc(fix.other)}`);
      expect(await armed(w.page)).toBe(true);
      await w.page.click('#fix-open');
      await w.page.keyboard.press('Escape');
      expect(await w.page.evaluate(() => (document.getElementById('fix') as HTMLDialogElement).open)).toBe(false);
      expect(await w.page.textContent('#fixbar')).toContain('Correct your answer');
      expect(await armed(w.page)).toBe(true);
      await w.page.goto(base + '/#/artifacts/dashboard'); await ready(w.page);
      expect(await armed(w.page)).toBe(false);
      // A page with no attempt behind it gets no bar and no prompt.
      const plain = (await w.page.getAttribute('#view .art:not(:has(.tag)) .art__open', 'href'))!;
      await w.page.goto(base + '/' + plain); await ready(w.page);
      expect(await w.page.locator('#fixbar').count()).toBe(0);
      expect(await armed(w.page)).toBe(false);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });
  });

  describe('the correction bar', () => {
    // An explainer taller than any window, so there is something to read past.
    let tall = '';
    beforeAll(() => {
      if (!OPTS) return;
      const made = createArtifact({ title: 'Tall locks, explained', kind: 'explainer', concept: 'csrf', attempt: fix.missed() });
      fs.writeFileSync(made.path, fs.readFileSync(made.path, 'utf8').replace('<!-- CONTENT:', '<p>Read this line.</p>'.repeat(150) + '<!-- CONTENT:'));
      tall = made.id;
    });

    const geo = (page: Page) => page.evaluate(() => {
      const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const note = document.querySelector('#fixbar .fixbar__note') as HTMLElement;
      return { inner: innerHeight, bar: r('fixbar').toJSON(), frame: r('art-frame').toJSON(), btn: r('fix-open').toJSON(), note: note.offsetParent !== null };
    });

    for (const width of [1280, 560]) {
      it(`sits on the bottom edge while you read and under the page at its end, button on the right, at ${width}px`, async () => {
        const w = await open(`#/artifacts/view/${enc(tall)}`, { width });
        await w.page.waitForSelector('#fix-open');
        expect(await w.page.getAttribute('#fixbar', 'role')).toBe('region');
        expect(await w.page.getAttribute('#fixbar', 'aria-label')).toBe('Correction');
        expect(await w.page.textContent('#fixbar')).toContain('You missed this one.');
        let g = await geo(w.page);
        expect(Math.round(g.bar.bottom)).toBe(g.inner);
        expect(g.bar.right - g.btn.right).toBeLessThanOrEqual(24);
        expect(g.btn.right).toBeLessThanOrEqual(g.bar.right);
        // One row: the button sits beside the text, never under it.
        expect(g.btn.top).toBeGreaterThanOrEqual(g.bar.top);
        expect(g.note).toBe(width > 560);
        await w.page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
        g = await geo(w.page);
        expect(g.bar.top).toBeGreaterThanOrEqual(g.frame.bottom);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      });
    }

    it("says what went wrong when the question won't load, and retries", async () => {
      const w = await open('#/artifacts/dashboard');
      let fail = true;
      await w.page.route('**/api/attempts/correction*', (r) => fail
        ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the database is busy' }) })
        : r.continue());
      await w.page.evaluate((h) => { location.hash = h; }, `#/artifacts/view/${enc(tall)}`);
      await w.page.waitForSelector('#fix-retry');
      expect(await w.page.textContent('#fixbar')).toContain('the database is busy');
      fail = false;
      await w.page.click('#fix-retry');
      await w.page.waitForSelector('#fix-open');
      expect(w.errors.filter((e) => !/status of 500/.test(e))).toEqual([]);
      await w.ctx.close();
    });
  });

  describe('one scroll', () => {
    // A page written without the template's frame script, as every page before 1.46 was.
    const id = 'plain/tall.html';
    const dir = () => path.join(process.env.EKLAVYA_HOME!, 'artifacts', 'plain');
    beforeAll(() => {
      if (!OPTS) return;
      fs.mkdirSync(dir(), { recursive: true });
      fs.writeFileSync(path.join(dir(), 'tall.html'), '<!doctype html><html><head><title>Tall plain page</title>'
        + '<style>main{min-height:100vh}</style></head><body><main>'
        + '<p>A line of text that wraps on a narrow screen and stays on one line on a wide one.</p>'.repeat(200)
        + '</main></body></html>');
      const lines = '<p>A line of text that wraps on a narrow screen and stays on one line on a wide one.</p>'.repeat(120);
      // Two hand-written layouts that size themselves from the window, which inside the frame is the frame.
      fs.writeFileSync(path.join(dir(), 'full.html'), `<!doctype html><html><head><title>Full</title><style>html,body{height:100%;margin:0}</style></head><body>${lines}</body></html>`);
      fs.writeFileSync(path.join(dir(), 'hero.html'), `<!doctype html><html><head><title>Hero</title><style>.hero{min-height:100vh}</style></head><body><section class="hero"><h1>Hero</h1></section>${lines}</body></html>`);
    });
    afterAll(() => { if (OPTS) fs.rmSync(dir(), { recursive: true, force: true }); });

    it('sizes a page whose html and body are 100% tall to its content, not to the frame', async () => {
      const w = await open(`#/artifacts/view/${enc('plain/full.html')}`);
      const frame = w.page.frames().find((f) => f.url().includes('full.html?embed'))!;
      const content = await frame.evaluate(() => [...document.querySelectorAll('p')].at(-1)!.getBoundingClientRect().bottom + scrollY);
      expect(await w.page.evaluate(() => document.getElementById('art-frame')!.clientHeight)).toBeGreaterThanOrEqual(Math.floor(content));
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('lets a page that grows with its frame scroll on its own, instead of growing to the cap', async () => {
      const w = await open(`#/artifacts/view/${enc('plain/hero.html')}`);
      await w.page.waitForFunction(() => document.getElementById('art-frame')!.style.height === '80vh');
      const frame = w.page.frames().find((f) => f.url().includes('hero.html?embed'))!;
      expect(await frame.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight
        && getComputedStyle(document.documentElement).overflowY !== 'hidden')).toBe(true);
      // And it stays that way: no report pulls it back into the loop.
      await new Promise((r) => setTimeout(r, 500));
      expect(await w.page.evaluate(() => document.getElementById('art-frame')!.style.height)).toBe('80vh');
      await w.ctx.close();
    });

    // Measured before the frame has a width, the page is one word per line and
    // tens of thousands of pixels tall. If that report landed last, the frame sat
    // at the cap, never resized, and the outrun count behind `eklavya:scroll` stalled.
    // The frame is held at no width until its page has loaded, so that moment always happens.
    it('reports no height before the frame has a width', async () => {
      const w = await open(`#/artifacts/view/${enc('plain/hero.html')}`, {
        init: `if (window === top) {
          window.__h = []; addEventListener('message', (e) => { if (e.data?.type === 'eklavya:height') window.__h.push(e.data.h); });
          document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { id: 'no-width', textContent: '#art-frame{width:0 !important}' })));
        }`,
      });
      const frame = w.page.frames().find((f) => f.url().includes('hero.html?embed'))!;
      await frame.waitForLoadState('load');
      expect(await frame.evaluate(() => innerWidth)).toBe(0);
      expect(await w.page.evaluate(() => (window as any).__h)).toEqual([]);
      await w.page.evaluate(() => document.getElementById('no-width')!.remove());
      await w.page.waitForFunction(() => (window as any).__h.length > 0);
      expect(Math.max(...await w.page.evaluate(() => (window as any).__h as number[]))).toBeLessThan(20000);
      await w.ctx.close();
    });

    /**
     * The frame element's height, and the framed document's own heights, once
     * the framed page has caught up with its new size (that crosses a process).
     */
    const sizes = async (page: Page) => {
      const frame = page.frames().find((f) => f.url().includes('tall.html?embed'))!;
      const read = async () => ({
        frame: await page.evaluate(() => document.getElementById('art-frame')!.clientHeight),
        ...await frame.evaluate(() => ({ scroll: document.documentElement.scrollHeight, client: document.documentElement.clientHeight })),
      });
      await expect.poll(async () => { const s = await read(); return s.frame === s.client; }).toBe(true);
      return read();
    };
    const settled = (page: Page, h: number) => page.waitForFunction((was) => {
      const now = document.getElementById('art-frame')!.clientHeight;
      return now !== was;
    }, h);

    it('sizes the frame to a page that carries no frame script, so only the window scrolls', async () => {
      const w = await open(`#/artifacts/view/${enc(id)}`);
      const s = await sizes(w.page);
      expect(s.frame).toBeGreaterThan(900);
      expect(s.frame).toBe(s.client);
      expect(s.scroll).toBeLessThanOrEqual(s.client);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('shrinks the frame back when the window widens again', async () => {
      const w = await open(`#/artifacts/view/${enc(id)}`);
      const wide = (await sizes(w.page)).frame;
      await w.page.setViewportSize({ width: 560, height: 900 });
      await settled(w.page, wide);
      const narrow = (await sizes(w.page)).frame;
      expect(narrow).toBeGreaterThan(wide);
      await w.page.setViewportSize({ width: 1280, height: 900 });
      await settled(w.page, narrow);
      const back = await sizes(w.page);
      expect(back.frame).toBe(wide);
      expect(back.scroll).toBeLessThanOrEqual(back.client);
      await w.ctx.close();
    });

    it('falls back to a frame that scrolls on its own when the page never reports', async () => {
      // As if the script were blocked: the guard sees it already ran, and stays silent.
      const w = await open(`#/artifacts/view/${enc(id)}`, { init: 'window.__eklavyaEmbed = 1' });
      expect(await w.page.evaluate(() => document.getElementById('art-frame')!.style.height)).toBe('80vh');
      expect(await w.page.locator('#view .loader').count()).toBe(0);
      await w.ctx.close();
    });
  });

  describe('artifact tabs', () => {
    // Nine plain pages; the first two are taller than any window.
    const P: string[] = [];
    const title = (i: number) => `Tab page ${i}`;
    beforeAll(() => {
      if (!OPTS) return;
      for (let i = 1; i <= 9; i++) {
        const made = createArtifact({ title: title(i), description: 'a page' });
        if (i <= 2) fs.writeFileSync(made.path, fs.readFileSync(made.path, 'utf8').replace('<!-- CONTENT:', '<p>Read this line.</p>'.repeat(150) + '<!-- CONTENT:'));
        P[i] = made.id;
      }
      // A page that is still growing when it first reports its height.
      const late = createArtifact({ title: 'Late page', description: 'grows after it loads' });
      fs.writeFileSync(late.path, fs.readFileSync(late.path, 'utf8').replace('<!-- CONTENT:', '<p>Read this line.</p>'.repeat(40)
        + '<div id="later"></div><script>setTimeout(function(){document.getElementById("later").innerHTML="<p>And this one.</p>".repeat(150)},400)</script><!-- CONTENT:'));
      P[10] = late.id;
    });
    afterAll(() => {
      if (!OPTS) return;
      for (const id of P.slice(1)) fs.rmSync(path.join(process.env.EKLAVYA_HOME!, 'artifacts', id), { force: true });
    });

    const tabs = (page: Page) => page.$$eval('#view [role="tab"]', (t) => t.map((x) => (x.getAttribute('aria-selected') === 'true' ? '*' : '') + x.textContent!.trim()));
    const go = async (page: Page, id: string) => {
      await page.evaluate((h) => { location.hash = h; }, `#/artifacts/view/${encodeURIComponent(id)}`);
      await ready(page);
    };
    /**
     * The page records a tab's position from its scroll event, which fires on
     * the next frame: a tab switch that lands first keeps the old position.
     * `TABS` is a top-level const of the page's script, reached by name: the
     * wait polls inside the page, where its security policy refuses `eval`.
     */
    const recorded = (page: Page, id: string, y: number) => page.waitForFunction(
      ([id, y]) => Math.abs((TABS.scroll.get(id) ?? -1e9) - y) <= 1, [id, y] as const, { timeout: 5000 });
    const all = async (page: Page) => { await page.click('#view [role="tab"]:has-text("All artifacts")'); await ready(page); };

    it('opens every card in the dashboard, as tabs in order, with no duplicates', async () => {
      const w = await open('#/artifacts/dashboard');
      expect(await w.page.locator('#view .art a[target="_blank"]').count()).toBe(0);
      for (const i of [1, 2, 3]) {
        await w.page.click(`#view .art__open[href*="${enc(P[i]!)}"]`);
        await ready(w.page);
        if (i < 3) await all(w.page);
      }
      expect(await tabs(w.page)).toEqual(['All artifacts', title(1), title(2), '*' + title(3)]);
      expect(await w.page.locator('#view .page__back').count()).toBe(0);
      await all(w.page);
      await w.page.click(`#view .art__open[href*="${enc(P[2]!)}"]`);
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(1), '*' + title(2), title(3)]);
      expect(await w.page.getAttribute('#view [role="tablist"]', 'aria-label')).toBeTruthy();
      expect(await w.page.getAttribute('#view [role="tab"][aria-selected="true"]', 'aria-controls')).toBe('view');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('closes the active tab to its right neighbour, and a reload brings the same tabs back', async () => {
      const w = await open(`#/artifacts/view/${enc(P[1]!)}`);
      await go(w.page, P[2]!);
      await go(w.page, P[3]!);
      await w.page.click('#view [role="tab"]:has-text("Tab page 2")');
      await ready(w.page);
      await w.page.click(`#view button[aria-label="Close ${title(2)}"]`);
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(1), '*' + title(3)]);
      expect(await w.page.evaluate(() => location.hash)).toBe(`#/artifacts/view/${enc(P[3]!)}`);
      // The last one closes to its left neighbour; with none left, to All artifacts.
      await w.page.click(`#view button[aria-label="Close ${title(3)}"]`);
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', '*' + title(1)]);
      await go(w.page, P[3]!);
      await w.page.reload();
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(1), '*' + title(3)]);
      // A middle click closes a tab too.
      await w.page.click('#view [role="tab"]:has-text("Tab page 1")', { button: 'middle' });
      expect(await tabs(w.page)).toEqual(['All artifacts', '*' + title(3)]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('closes the least recently viewed tab without an open correction when a ninth opens', async () => {
      const w = await open(`#/artifacts/view/${enc(fix.other)}`);
      for (let i = 1; i <= 7; i++) await go(w.page, P[i]!);
      expect((await tabs(w.page)).length).toBe(9);
      await go(w.page, P[8]!);
      const now = await tabs(w.page);
      expect(now.length).toBe(9);
      expect(now).toContain('Queues, explained');
      expect(now).not.toContain(title(1));
      expect(now.at(-1)).toBe('*' + title(8));
      await w.ctx.close();
    }, 60000);

    it('scrolls the strip to the open tab on a phone', async () => {
      const w = await open(`#/artifacts/view/${enc(P[3]!)}`, { width: 560 });
      for (const i of [4, 5, 6, 7]) await go(w.page, P[i]!);
      const r = await w.page.evaluate(() => {
        const strip = document.querySelector('#view [role="tablist"]')!.getBoundingClientRect();
        const tab = document.querySelector('#view [role="tab"][aria-selected="true"]')!.getBoundingClientRect();
        return { strip: strip.right, tab: tab.right, left: tab.left, sl: strip.left };
      });
      expect(r.tab).toBeLessThanOrEqual(r.strip + 1);
      expect(r.left).toBeGreaterThanOrEqual(r.sl - 1);
      expect(await w.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(560);
      await w.ctx.close();
    }, 60000);

    it('still opens tabs when storage throws', async () => {
      const w = await open(`#/artifacts/view/${enc(P[4]!)}`, {
        init: 'Storage.prototype.getItem = () => { throw new Error("denied"); }; Storage.prototype.setItem = () => { throw new Error("denied"); };',
      });
      await go(w.page, P[5]!);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(4), '*' + title(5)]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('works from the keyboard: arrows, Home and End move, Enter opens, Delete closes', async () => {
      const w = await open(`#/artifacts/view/${enc(P[4]!)}`);
      await go(w.page, P[5]!);
      await go(w.page, P[6]!);
      const focused = () => w.page.evaluate(() => document.activeElement?.textContent?.trim());
      // One tab stop for the whole strip: the selected tab.
      expect(await w.page.$$eval('#view [role="tab"]', (t) => t.map((x) => (x as HTMLElement).tabIndex))).toEqual([-1, -1, -1, 0]);
      await w.page.focus('#view [role="tab"][aria-selected="true"]');
      await w.page.keyboard.press('ArrowLeft');
      expect(await focused()).toBe(title(5));
      await w.page.keyboard.press('Home');
      expect(await focused()).toBe('All artifacts');
      await w.page.keyboard.press('End');
      expect(await focused()).toBe(title(6));
      await w.page.keyboard.press('ArrowRight');
      expect(await focused()).toBe('All artifacts');
      await w.page.keyboard.press('ArrowRight');
      await w.page.keyboard.press('Enter');
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', '*' + title(4), title(5), title(6)]);
      await w.page.keyboard.press('ArrowRight');
      expect(await focused()).toBe(title(5));
      await w.page.keyboard.press(' ');
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(4), '*' + title(5), title(6)]);
      expect(await focused()).toBe(title(5));
      await w.page.keyboard.press('Delete');
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(4), '*' + title(6)]);
      expect(await focused()).toBe(title(6));
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('waits for a page that is still growing before taking you back to where you were', async () => {
      const w = await open(`#/artifacts/view/${enc(P[10]!)}`);
      await w.page.waitForFunction(() => document.documentElement.scrollHeight > 6000);
      const deep = await w.page.evaluate(() => {
        const y = document.documentElement.scrollHeight - innerHeight - 100;
        window.scrollTo({ top: y, behavior: 'instant' });
        return y;
      });
      await recorded(w.page, P[10]!, deep);
      await go(w.page, P[1]!);
      await go(w.page, P[10]!);
      await w.page.waitForFunction((y) => Math.abs(scrollY - y) <= 1, deep, { timeout: 5000 });
      await w.ctx.close();
    }, 60000);

    it('leaves focus alone after Enter on the tab that is already open', async () => {
      const w = await open(`#/artifacts/view/${enc(P[4]!)}`);
      await w.page.focus('#view [role="tab"][aria-selected="true"]');
      await w.page.keyboard.press('Enter');
      await w.page.click('#view [role="tab"]:has-text("All artifacts")');
      await ready(w.page);
      expect(await w.page.evaluate(() => document.activeElement === document.body)).toBe(true);
      await w.ctx.close();
    }, 60000);

    it('comes back to where you were reading when you switch back', async () => {
      const w = await open(`#/artifacts/view/${enc(P[1]!)}`);
      await go(w.page, P[2]!);
      const half = await w.page.evaluate(() => {
        const y = Math.round((document.documentElement.scrollHeight - innerHeight) / 2);
        window.scrollTo({ top: y, behavior: 'instant' });
        return y;
      });
      expect(half).toBeGreaterThan(500);
      await recorded(w.page, P[2]!, half);
      await w.page.click('#view [role="tab"]:has-text("Tab page 1")');
      await ready(w.page);
      await w.page.click('#view [role="tab"]:has-text("Tab page 2")');
      await ready(w.page);
      await w.page.waitForFunction((y) => Math.abs(scrollY - y) <= 1, half);
      // The strip stays on screen while you read.
      expect(await w.page.evaluate(() => document.querySelector('#view [role="tablist"]')!.getBoundingClientRect().top)).toBe(0);
      await w.ctx.close();
    }, 60000);
  });
});
