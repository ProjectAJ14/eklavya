// Split by feature so Vitest's file sharding can divide the browser work.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { OPTS, base, enc, fix, fx, home, open, pickOption, ready } from './dashboard-browser-helpers.js';
declare function render(): void;

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('settings', () => {
    it('saves a user setting, overrides it for a project and inherits it back, from the keyboard', async () => {
      const userFile = path.join(home, 'home', 'config.json');
      const w = await open('#/settings/user');
      await pickOption(w.page, '#set-cadence', 'end');
      await w.page.waitForSelector('[data-msg="cadence"].here:has-text("saved")');
      expect(await w.page.getAttribute('[data-msg="cadence"] eklavya-mascot', 'state')).toBe('success');
      expect(JSON.parse(fs.readFileSync(userFile, 'utf8')).cadence).toBe('end');
      // Focus stays on the control that was just used, rather than jumping to the top.
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('set-cadence-combo');

      await w.page.goto(base + '/' + `#/settings/project?project=${enc(fx.repo.mixed)}`); await ready(w.page);
      expect(await w.page.textContent('#view')).toContain('inherited from user settings');
      await pickOption(w.page, '#set-cadence', 'as-you-go');
      await w.page.waitForSelector('[data-unset="cadence"]');
      // A global-only key is shown, not editable, on a project.
      await w.page.goto(base + '/' + `#/settings/project/this-machine?project=${enc(fx.repo.mixed)}`); await ready(w.page);
      expect(await w.page.isDisabled('#set-telemetry')).toBe(true);
      await w.page.goto(base + '/' + `#/settings/project?project=${enc(fx.repo.mixed)}`); await ready(w.page);
      await w.page.focus('[data-unset="cadence"]');
      await w.page.keyboard.press('Enter');
      await w.page.waitForSelector('[data-msg="cadence"]:has-text("inherited")');
      expect(await w.page.inputValue('#set-cadence')).toBe('end');

      // An out-of-range number is refused in the page, under the field, before any request.
      await w.page.goto(base + '/' + `#/settings/project/pacing?project=${enc(fx.repo.mixed)}`); await ready(w.page);
      const posts: string[] = [];
      w.page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()); });
      await w.page.fill('#set-max_questions_per_task', '99');
      await w.page.press('#set-max_questions_per_task', 'Enter');
      await w.page.waitForSelector('#set-max_questions_per_task-e:visible');
      expect(await w.page.getAttribute('#set-max_questions_per_task-e eklavya-mascot', 'state')).toBe('validation');
      expect((await w.page.textContent('#set-max_questions_per_task-e'))?.trim()).toBe('max_questions_per_task is a whole number from 1 to 10.');
      expect(await w.page.getAttribute('#set-max_questions_per_task', 'aria-invalid')).toBe('true');
      expect(await w.page.getAttribute('#set-max_questions_per_task', 'aria-describedby')).toContain('set-max_questions_per_task-e');
      expect(await w.page.inputValue('#set-max_questions_per_task')).toBe('99'); // the typed value stays
      expect(posts).toEqual([]);
      // Only the server knows the combination: its refusal lands in the same place.
      await w.page.goto(base + '/' + `#/settings/project?project=${enc(fx.repo.mixed)}`); await ready(w.page);
      await w.page.uncheck('#set-quiz-enabled');
      await w.page.waitForSelector('[data-msg="quiz.enabled"]:has-text("saved")');
      await w.page.check('#set-quiz-enforced');
      await w.page.waitForSelector('#set-quiz-enforced-e:visible');
      expect(await w.page.textContent('#set-quiz-enforced-e')).toMatch(/no effect while quiz.enabled is false/);
      // A refused switch is put back to what is on disk, not left showing a value nobody saved.
      expect(await w.page.isChecked('#set-quiz-enforced')).toBe(false);

      await w.page.goto(base + '/#/settings/user'); await ready(w.page);
      await w.page.click('[data-unset="cadence"]');
      await w.page.waitForSelector('[data-msg="cadence"]:has-text("inherited")');
      expect(JSON.parse(fs.readFileSync(userFile, 'utf8')).cadence).toBeUndefined();
      // The one refusal above is a 400 the browser logs; nothing else may be.
      expect(w.errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
      await w.ctx.close();
    }, 60000);
  });

  describe('tips', { timeout: 12000 }, () => {
    /** Test-only tips: `window.__eklavyaTestTips` stands in for TIPS when set. */
    const tips = (list: object[]) => `window.__eklavyaTestTips = ${JSON.stringify(list)};`;
    const ONE = { id: 't-one', where: ['learning/dashboard'], el: '#wf-caret', title: 'One', text: 'The first tip.', side: 'right' };
    const TWO = { id: 't-two', where: ['learning/dashboard'], el: '#view details.about > summary', title: 'Two', text: 'The second tip.' };
    const bubble = '.driver-popover.coach';
    const beacons = (page: Page) => page.$$eval('.driver-hint:not(.driver-hint-hidden)', (b) => b.map((x) => x.getAttribute('aria-label')));
    const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('eklavya-dash-tips') ?? 'null'));
    const bubbles = (page: Page) => page.locator(bubble).count();
    /** Under the block's 12s, so a stall fails on the step that stalled. */
    const WAIT = { timeout: 5000 };

    it('opens the first tip by itself once, and marks every other tip with a beacon', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.textContent(bubble)).toContain('Tip: The first tip.');
      expect(await w.page.getAttribute(`${bubble}`, 'role')).toBe('dialog');
      expect(await beacons(w.page)).toEqual(['One', 'Two']);
      // Opening by itself does not take focus from the reader.
      expect(await w.page.evaluate(() => document.activeElement === document.body)).toBe(true);
      expect((await stored(w.page)).opened).toEqual(['t-one']);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('shows the companion in the bubble: a wink by default, a tip\'s own state when it names one', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([{ ...ONE, state: 'new' }]) });
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.getAttribute(`${bubble} eklavya-mascot`, 'state')).toBe('new');
      expect(await w.page.locator(`${bubble} svg[data-expression="surprised"]`).count()).toBe(1);
      await w.ctx.close();
      const d = await open('#/learning/dashboard', { tips: true, init: tips([ONE]) });
      await d.page.waitForSelector(bubble, WAIT);
      expect(await d.page.locator(`${bubble} svg[data-expression="wink"]`).count()).toBe(1);
      await d.ctx.close();
    });

    it('keeps the companion gallery out of the sidebar and in Settings', async () => {
      const w = await open('#/settings/dashboard/companion');
      await w.page.waitForSelector('#settings .sw__tab[aria-current="page"]');
      expect(await w.page.locator('a[href="/mascot.html"]').count()).toBe(1);
      expect(await w.page.locator('#side a[href="/mascot.html"]').count()).toBe(0);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('Got it dismisses for good', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.click(`${bubble} .driver-popover-next-btn`);
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual(['Two']);
      expect((await stored(w.page)).done).toEqual(['t-one']);
      await w.page.reload(); await ready(w.page);
      // The next tip opens by itself now; the dismissed one never comes back.
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.textContent(bubble)).toContain('The second tip.');
      expect(await beacons(w.page)).toEqual(['Two']);
      await w.ctx.close();
    });

    it('× and Escape close the bubble and keep the beacon, which reopens it', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.keyboard.press('Escape');
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual(['One', 'Two']);
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('One');
      // Enter on the focused beacon reopens it, focus goes in, and the × closes it back to the beacon.
      await w.page.keyboard.press('Enter');
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Close');
      await w.page.keyboard.press('Tab');
      expect(await w.page.evaluate(() => document.activeElement?.textContent)).toBe('Got it');
      await w.page.click(`${bubble} .coach__x`);
      expect(await bubbles(w.page)).toBe(0);
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('One');
      // Only the screen's first tip opens by itself, once: the second stays a beacon.
      await w.page.reload(); await ready(w.page);
      await w.page.waitForTimeout(900);
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual(['One', 'Two']);
      await w.page.click('.driver-hint[aria-label="One"]');
      await w.page.waitForSelector(bubble, WAIT);
      expect(await stored(w.page)).toMatchObject({ off: false, done: [], opened: ['t-one'] });
      await w.ctx.close();
    });

    it('using the feature dismisses its tip', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.click('#view details.about > summary');
      expect(await w.page.evaluate(() => (document.querySelector('#view details.about') as HTMLDetailsElement).open)).toBe(true);
      expect(await beacons(w.page)).toEqual(['One']);
      expect((await stored(w.page)).done).toEqual(['t-two']);
      await w.ctx.close();
    });

    it('closes the bubble on navigation, and never shows two', async () => {
      const THREE = { id: 't-three', where: ['learning/concepts'], el: '#chips', title: 'Three', text: 'The third tip.' };
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO, THREE]) });
      await w.page.waitForSelector(bubble, WAIT);
      // Opening another closes the first: one bubble at a time.
      await w.page.keyboard.press('Escape');
      await w.page.click('.driver-hint[aria-label="Two"]');
      expect(await w.page.textContent(bubble)).toContain('The second tip.');
      await w.page.evaluate("TIP.hints.open('t-one')");
      expect(await bubbles(w.page)).toBe(1);
      expect(await w.page.textContent(bubble)).toContain('The first tip.');
      await w.page.click('#nav a[data-nav="concepts"]');
      await w.page.waitForFunction(() => document.documentElement.dataset.rendered === '#/learning/concepts', null, WAIT);
      expect(await bubbles(w.page)).toBe(0);
      await w.page.waitForSelector(bubble, WAIT);
      expect(await bubbles(w.page)).toBe(1);
      expect(await w.page.textContent(bubble)).toContain('The third tip.');
      expect(await beacons(w.page)).toEqual(['Three']);
      await w.ctx.close();
    });

    it('the sidebar switch hides every tip, and on starts them over', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.click(`${bubble} .driver-popover-next-btn`);
      await w.page.click('[data-tips="off"]');
      expect(await w.page.getAttribute('[data-tips="off"]', 'aria-pressed')).toBe('true');
      expect(await beacons(w.page)).toEqual([]);
      for (const h of ['#/learning/concepts', '#/learning/dashboard']) {
        await w.page.goto(base + '/' + h); await ready(w.page);
        await w.page.waitForTimeout(700);
        expect(await beacons(w.page), h).toEqual([]);
        expect(await bubbles(w.page), h).toBe(0);
      }
      expect(await w.page.getAttribute('[data-tips="off"]', 'aria-pressed')).toBe('true');
      await w.page.click('[data-tips="on"]');
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.textContent(bubble)).toContain('The first tip.');
      expect(await beacons(w.page)).toEqual(['One', 'Two']);
      await w.ctx.close();
    });

    it('shows nothing when storage throws, and treats malformed storage as fresh', async () => {
      const w = await open('#/learning/dashboard', {
        tips: true, init: tips([ONE]) + `Storage.prototype.getItem = function () { throw new DOMException('denied', 'SecurityError'); };`,
      });
      await w.page.waitForTimeout(900);
      expect(await beacons(w.page)).toEqual([]);
      expect(await bubbles(w.page)).toBe(0);
      await w.page.click('[data-tips="on"]');
      expect(await beacons(w.page)).toEqual([]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
      const m = await open('#/learning/dashboard', { tips: true, init: tips([ONE]) + `localStorage.setItem('eklavya-dash-tips', '{nope');` });
      await m.page.waitForSelector(bubble, WAIT);
      expect(m.errors).toEqual([]);
      await m.ctx.close();
    });

    it('shows no tip over the correction dialog', async () => {
      const w = await open(`#/artifacts/view/${enc(fix.other)}`, {
        tips: true, init: tips([{ id: 't-tabs', where: ['artifacts/view'], el: '#view [role="tablist"]', title: 'Tabs', text: 'Open pages.' }]),
      });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.waitForSelector('#fix-open', WAIT);
      await w.page.click('#fix-open');
      expect(await w.page.evaluate(() => (document.getElementById('fix') as HTMLDialogElement).open)).toBe(true);
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual([]);
      await w.page.keyboard.press('Escape');
      await expect.poll(() => beacons(w.page)).toEqual(['Tabs']);
      await w.ctx.close();
    });

    // The registry guard: what makes "add a row to TIPS" safe. A typo in a
    // selector, a page that does not exist or a reused id fails here.
    it('every tip in TIPS is well formed and points at a real feature on its pages', async () => {
      const w = await open('#/learning/dashboard', { tips: true });
      const list = await w.page.evaluate('TIPS.map((t) => ({ ...t, when: !!t.when }))') as { id: string; where: string[]; el: string; title: string; text: string; side?: string; when: boolean }[];
      const pages = await w.page.evaluate('Object.fromEntries(Object.entries(WORKFLOWS).map(([k, W]) => [k, Object.keys(W.pages)]))') as Record<string, string[]>;
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
      // A detail page needs a parameter to open.
      const PARAM: Record<string, string> = { 'artifacts/view': enc(fix.other) };
      for (const t of list) {
        expect(t.id, t.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(t.title.length, t.id).toBeLessThanOrEqual(32);
        expect(t.text.length, t.id).toBeLessThanOrEqual(140);
        expect(t.text, t.id).not.toMatch(/click here|\p{Extended_Pictographic}/iu);
        expect(['top', 'right', 'bottom', 'left', undefined], t.id).toContain(t.side);
        expect(t.where.length, t.id).toBeGreaterThan(0);
        for (const where of t.where) {
          const [wf, pg] = where.split('/');
          expect(pages[wf!] ?? [], `${t.id}: ${where}`).toContain(pg);
          await w.page.goto(`${base}/#/${where}${PARAM[where] ? '/' + PARAM[where] : ''}`); await ready(w.page);
          if (t.when && !(await w.page.evaluate(`TIPS.find((t) => t.id === ${JSON.stringify(t.id)}).when()`))) continue;
          const rendered = await w.page.evaluate((sel) => !!document.querySelector(sel)?.getClientRects().length, t.el);
          expect(rendered, `${t.id}: ${t.el} on ${where}`).toBe(true);
        }
      }
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('on a phone, leaves out tips whose feature is in the closed drawer', async () => {
      const w = await open('#/learning/dashboard', { tips: true, width: 560, height: 800 });
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.textContent(bubble)).toContain('Every page explains');
      expect(await beacons(w.page)).toEqual(['How this works']);
      // Closing the drawer slides the rail away; its features stay out while it moves.
      await w.page.keyboard.press('Escape');
      await w.page.click('#menu');
      await w.page.keyboard.press('Escape');
      await w.page.waitForTimeout(900);
      expect(await beacons(w.page)).toEqual(['How this works']);
      expect(await bubbles(w.page)).toBe(0);
      await w.ctx.close();
    });

    it('waits behind the drawer, and fits a phone', async () => {
      // The drawer opens before the first render: opened after `open()` returns,
      // it races the tip's own 600ms timer, and a tip that already opened by
      // itself rightly stays a beacon once the drawer closes.
      const w = await open('#/learning/dashboard', {
        tips: true, width: 560, height: 800,
        init: tips([TWO]) + `document.addEventListener('DOMContentLoaded', () => document.getElementById('menu').click());`,
      });
      expect(await w.page.getAttribute('#menu', 'aria-expanded')).toBe('true');
      await w.page.waitForTimeout(900);
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual([]);
      await w.page.keyboard.press('Escape');
      await w.page.waitForSelector(bubble, WAIT);
      const r = await w.page.$eval(bubble, (b) => { const x = b.getBoundingClientRect(); return { l: x.left, r: x.right, w: innerWidth }; });
      expect(r.l).toBeGreaterThanOrEqual(8);
      expect(r.r).toBeLessThanOrEqual(r.w - 8);
      await w.ctx.close();
    });
  });
});
