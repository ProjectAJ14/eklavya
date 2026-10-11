import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { openDb, type DB } from '../src/db.js';
import { startDashboard } from '../dist/dashboard.js';
import { tempDbPath, cleanup } from './helpers.js';

const options = process.env.EKLAVYA_TEST_BROWSER ? { executablePath:process.env.EKLAVYA_TEST_BROWSER } : fs.existsSync(chromium.executablePath()) ? {} :
  fs.existsSync('/Applications/Google Chrome.app') ? { channel:'chrome' } : null;
if (!options && process.env.CI) throw new Error('mascot-browser: no Chromium on CI');
let previousHome: string | undefined;
let browser: Browser, db: DB, file: string, server: Awaited<ReturnType<typeof startDashboard>>;

async function serveWebsite(page: Page, stars: number | null | 'offline' = 12345, declineAnalytics = true) {
  const publicDir = new URL('../../web/public/', import.meta.url);
  if (declineAnalytics) await page.addInitScript(() => localStorage.setItem('eklavya-analytics', 'denied'));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.href === 'https://api.github.com/repos/ProjectAJ14/eklavya') {
      if (stars === 'offline') return route.abort();
      if (stars === null) return route.fulfill({status:503,contentType:'application/json',body:'{"message":"unavailable"}'});
      return route.fulfill({contentType:'application/json',body:JSON.stringify({stargazers_count:stars})});
    }
    if (url.origin !== new URL(server.url).origin) return route.abort();
    const name = url.pathname.endsWith('/') ? `${url.pathname.slice(1)}index.html` : url.pathname.slice(1);
    // Only test-owned static requests are fulfilled; no network dependencies.
    if (name.includes('..')) return route.abort();
    const file = new URL(name, publicDir);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'image/svg+xml';
    await route.fulfill({contentType:type,body:fs.readFileSync(file)});
  });
}

async function expectReadable(page: Page, selector: string) {
  const ratios = await page.locator(selector).evaluateAll(elements => {
    const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
    const luminance = (rgb: number[]) => rgb.slice(0, 3).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    return elements.filter(element => element.getBoundingClientRect().width > 0).map(element => {
      const foreground = channels(getComputedStyle(element).color);
      let ancestor: Element | null = element;
      const layers: number[][] = [];
      while (ancestor) {
        const color = channels(getComputedStyle(ancestor).backgroundColor);
        layers.push(color);
        if ((color[3] ?? 1) === 1) break;
        ancestor = ancestor.parentElement;
      }
      let background = [255, 255, 255];
      for (const layer of layers.reverse()) {
        const alpha = layer[3] ?? 1;
        background = background.map((channel, i) => layer[i] * alpha + channel * (1 - alpha));
      }
      const front = luminance(foreground), back = luminance(background);
      return { text: element.textContent, ratio: (Math.max(front, back) + .05) / (Math.min(front, back) + .05) };
    });
  });
  expect(ratios.length).toBeGreaterThan(0);
  for (const {text, ratio} of ratios) expect(ratio, `${selector}: ${text}`).toBeGreaterThanOrEqual(4.5);
}

async function showWholeTerminal(page: Page) {
  await page.locator('[data-terminal]').evaluate(element => element.scrollIntoView({block:'center',behavior:'instant'}));
  await expectWholeTerminal(page);
}

async function expectWholeTerminal(page: Page) {
  await expect.poll(() => page.locator('[data-terminal]').evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth;
  })).toBe(true);
}

async function installPausedClock(page: Page) {
  const now = new Date('2026-10-11T12:00:00Z');
  await page.clock.install({time:now});
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
}

async function advanceToState(page: Page, state: string) {
  for (let elapsed = 0; elapsed <= 20000; elapsed += 200) {
    if (await page.locator('[data-terminal]').getAttribute('data-demo-state') === state) return;
    await page.clock.runFor(200);
  }
  expect(await page.locator('[data-terminal]').getAttribute('data-demo-state')).toBe(state);
}

async function showPartOfTerminal(page: Page) {
  await page.locator('[data-terminal]').evaluate(element => {
    const box = element.getBoundingClientRect();
    window.scrollTo({top:scrollY + box.top - innerHeight + box.height / 2,behavior:'instant'});
  });
  await expect.poll(() => page.locator('[data-terminal]').evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.top > 0 && box.top < innerHeight && box.bottom > innerHeight;
  })).toBe(true);
}

async function expectInsidePanel(page: Page, selector: string) {
  const visible = await page.locator(selector).evaluate(element => {
    const panel = document.querySelector('.quiz-panel__content')! as HTMLElement;
    const parent = panel.getBoundingClientRect(), box = element.getBoundingClientRect();
    const top = parent.top + panel.clientTop, left = parent.left + panel.clientLeft;
    return box.width > 0 && box.height > 0 && box.top >= top && box.left >= left &&
      box.bottom <= top + panel.clientHeight && box.right <= left + panel.clientWidth;
  });
  expect(visible, `${selector} should be inside the panel's visible scrollport`).toBe(true);
}

describe.skipIf(!options)('offline mascot studio in a real browser', () => {
  beforeAll(async () => {
    // Runtime CI does not build web/. Generate its source-backed panel asset without web dependencies.
    execFileSync(process.execPath, [new URL('../../web/scripts/demo-panel.mjs', import.meta.url).pathname]);
    file = tempDbPath('mascot-browser');
    previousHome = process.env.EKLAVYA_HOME; process.env.EKLAVYA_HOME = path.dirname(file);
    db = openDb(file);
    server = await startDashboard(db, { port:0 });
    browser = await chromium.launch(options!);
  });
  afterAll(async () => { await browser?.close(); server?.close(); db?.close(); if(file) cleanup(file); if (previousHome === undefined) delete process.env.EKLAVYA_HOME; else process.env.EKLAVYA_HOME = previousHome; });

  it('switches expressions and exposes compact faces without the bow', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL('/mascot.html',server.url).href);
      await expect.poll(() => page.locator('#expressions button').count()).toBe(13);
      await page.getByRole('button', { name:'Sad sad', exact:true }).click();
      expect(await page.locator('#preview svg').getAttribute('data-expression')).toBe('sad');
      expect(await page.locator('#preview title').textContent()).toBe('Eklavya, sad');
      await page.getByRole('button', { name:'Show face only' }).click();
      expect(await page.locator('#preview svg').getAttribute('data-variant')).toBe('face');
      expect(await page.locator('#preview .ek-mascot__bow').count()).toBe(0);
      expect(await page.locator('#expressions svg[aria-hidden="true"]').count()).toBe(13);
      await page.locator('#states').getByRole('button', {name:'error',exact:true}).click();
      expect(await page.locator('#state-preview svg').getAttribute('data-expression')).toBe('sad');
      expect(await page.locator('#state-copy').textContent()).toContain('Try again');
      await page.locator('#states').getByRole('button', {name:'loading',exact:true}).click();
      expect(await page.locator('#state-preview svg').getAttribute('data-variant')).toBe('loading');
      expect(await page.locator('#state-preview svg').getAttribute('data-expression')).toBe('excited');
    } finally { await page.close(); }
  });

  it('pauses the loader and respects reduced motion without hiding status text', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(new URL('/mascot.html',server.url).href);
      await page.getByRole('button', {name:'Play loading loop'}).click();
      expect(await page.locator('#preview svg').getAttribute('data-expression')).toBe('excited');
      const arrow = page.locator('#preview .ek-mascot__arrow');
      expect(await arrow.evaluate(e => getComputedStyle(e).animationName)).toBe('ek-release');
      await page.getByRole('button', {name:'Pause animations'}).click();
      expect(await arrow.evaluate(e => getComputedStyle(e).animationPlayState)).toBe('paused');
      await page.getByRole('button', {name:'Resume animations'}).click();
      await page.emulateMedia({ reducedMotion:'reduce' });
      expect(await arrow.evaluate(e => getComputedStyle(e).animationName)).toBe('none');
      expect(await page.getByRole('status').first().textContent()).toContain('Loading your history');
    } finally { await page.close(); }
  });

  it('uses curious empty and missing states, and a sad system error', async () => {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    try {
      await page.goto(server.url + '#/learning/concept/missing-concept');
      await page.locator('#view eklavya-mascot[state="notFound"] svg').waitFor();
      expect(await page.locator('#view svg').getAttribute('data-expression')).toBe('curious');
      await page.goto(server.url + '#/learning/sessions');
      await page.locator('#view .ek-mascot-message svg').first().waitFor();
      expect(await page.locator('#view .ek-mascot-message svg').first().getAttribute('data-expression')).toBe('curious');
      await page.route('**/api/state', route => route.fulfill({status:500,contentType:'application/json',body:'{"error":"unavailable"}'}));
      await page.reload();
      await page.locator('#view eklavya-mascot[state="error"] svg').waitFor();
      expect(await page.locator('#view').textContent()).toContain('Could not read the database');
    } finally { await page.close(); }
  });

  it('waits for the whole homepage terminal, then plays one session without taking focus', async () => {
    const page = await browser.newPage({viewport:{width:1280,height:640}});
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await serveWebsite(page);
      await installPausedClock(page);
      await page.goto(server.url);
      const terminal = page.locator('[data-terminal]');
      const panel = page.locator('[data-panel]');
      await expect.poll(() => terminal.getAttribute('data-demo-state')).toBe('idle');
      expect(await panel.isVisible()).toBe(false);
      expect(await terminal.locator('input, textarea, form').count()).toBe(0);
      expect(await page.locator('[data-question], [data-result]').locator('button, input, textarea, [role="button"]').count()).toBe(0);
      expect(await terminal.evaluate(element => element.getBoundingClientRect().top >= innerHeight)).toBe(true);
      await page.clock.runFor(60000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('idle');

      await showPartOfTerminal(page);
      await page.clock.runFor(30000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('idle');
      expect(await page.locator('[data-prompt]').textContent()).toBe('');

      const outside = page.locator('[data-ground="ink"]');
      await outside.evaluate(element => (element as HTMLElement).focus({preventScroll:true}));
      await showWholeTerminal(page);
      await advanceToState(page, 'typing');
      await page.clock.runFor(700);
      const partialPrompt = await page.locator('[data-prompt]').textContent();
      expect(partialPrompt!.length).toBeGreaterThan(0);
      expect(partialPrompt!.length).toBeLessThan('Add JWT auth to the Express API'.length);
      expect(await panel.isVisible()).toBe(false);

      await advanceToState(page, 'submitted');
      expect(await page.locator('[data-prompt]').textContent()).toBe('Add JWT auth to the Express API');
      expect(await page.locator('[data-enter]').evaluate(element => element.classList.contains('is-pressed'))).toBe(true);
      expect(await panel.isVisible()).toBe(false);
      await advanceToState(page, 'awaiting');
      expect(await panel.isVisible()).toBe(true);
      expect(await page.locator('[data-question]').isVisible()).toBe(true);
      expect(await page.locator('[data-step="3"]').isVisible()).toBe(true);
      expect(await page.locator('[data-step="4"]').isVisible()).toBe(false);
      await page.clock.runFor(1400);
      expect(await page.locator('[data-step="4"]').isVisible()).toBe(true);
      expect(await panel.isVisible()).toBe(true);

      await advanceToState(page, 'selected');
      expect(await page.locator('[data-option="1"]').getAttribute('data-selected')).toBe('true');
      expect(await page.locator('[data-option][data-selected="true"]').count()).toBe(1);
      await expectInsidePanel(page, '[data-option="1"]');
      await advanceToState(page, 'submitting');
      expect(await page.locator('[data-submit]').evaluate(element => element.classList.contains('is-pressed'))).toBe(true);
      await expectInsidePanel(page, '[data-submit]');
      await advanceToState(page, 'grading');
      expect(await page.locator('[data-grading]').isVisible()).toBe(true);
      expect(await page.locator('.quiz-actions').isVisible()).toBe(false);
      await advanceToState(page, 'feedback');
      expect(await page.locator('[data-result]').isVisible()).toBe(true);
      expect(await page.locator('[data-verdict]').textContent()).toBe('Correct');
      expect(await page.locator('[data-explanation]').textContent()).toContain('httpOnly');
      expect(await page.locator('[data-step="5"]').isVisible()).toBe(false);
      expect(await outside.evaluate(element => element === document.activeElement)).toBe(true);

      await advanceToState(page, 'acknowledging');
      expect(await panel.isVisible()).toBe(true);
      expect(await page.locator('[data-done]').evaluate(element => element.classList.contains('is-pressed'))).toBe(true);
      await expectInsidePanel(page, '[data-done]');
      await advanceToState(page, 'continuing');
      expect(await panel.isVisible()).toBe(false);
      await advanceToState(page, 'complete');
      expect(await page.locator('[data-step="5"]').isVisible()).toBe(true);
      expect(await page.locator('[data-task-done]').isVisible()).toBe(true);
      expect(await outside.evaluate(element => element === document.activeElement)).toBe(true);
      await page.clock.runFor(60000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('complete');
      expect(await panel.isVisible()).toBe(false);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('pauses when partly visible or hidden, and resumes from the same point', async () => {
    const page = await browser.newPage({viewport:{width:1280,height:640}});
    try {
      // The browser controls these read-only properties. Override only its visibility
      // signal; the viewport observer and layout remain real browser behavior.
      await page.addInitScript(() => {
        let hidden = false;
        Object.defineProperty(document, 'hidden', {get:() => hidden});
        Object.defineProperty(document, 'visibilityState', {get:() => hidden ? 'hidden' : 'visible'});
        (window as unknown as {setTestVisibility:(value: boolean) => void}).setTestVisibility = value => {
          hidden = value;
          document.dispatchEvent(new Event('visibilitychange'));
        };
      });
      await serveWebsite(page);
      await installPausedClock(page);
      await page.goto(server.url);
      await showWholeTerminal(page);
      await advanceToState(page, 'typing');
      await page.clock.runFor(700);
      const terminal = page.locator('[data-terminal]');
      const prompt = await page.locator('[data-prompt]').textContent();
      await showPartOfTerminal(page);
      await expect.poll(() => terminal.getAttribute('data-demo-paused')).toBe('true');
      await page.clock.runFor(30000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('typing');
      expect(await page.locator('[data-prompt]').textContent()).toBe(prompt);
      await page.evaluate(() => window.scrollTo({top:0,behavior:'instant'}));
      expect(await terminal.evaluate(element => element.getBoundingClientRect().top >= innerHeight)).toBe(true);
      await page.clock.runFor(30000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('typing');
      expect(await page.locator('[data-prompt]').textContent()).toBe(prompt);

      await showWholeTerminal(page);
      await advanceToState(page, 'awaiting');
      await page.evaluate(() => (window as unknown as {setTestVisibility:(value: boolean) => void}).setTestVisibility(true));
      expect(await terminal.getAttribute('data-demo-paused')).toBe('true');
      await page.clock.runFor(30000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('awaiting');
      expect(await page.locator('[data-step="4"]').isVisible()).toBe(false);
      await page.evaluate(() => (window as unknown as {setTestVisibility:(value: boolean) => void}).setTestVisibility(false));
      await advanceToState(page, 'selected');
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      expect(await terminal.getAttribute('data-demo-paused')).toBe('true');
      await page.clock.runFor(30000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('selected');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await advanceToState(page, 'grading');

      const pause = page.locator('[data-demo-pause]');
      await pause.evaluate(element => (element as HTMLElement).focus({preventScroll:true}));
      await page.keyboard.press('Enter');
      await showWholeTerminal(page);
      expect(await terminal.getAttribute('data-demo-paused')).toBe('true');
      expect(await pause.textContent()).toBe('Resume animation');
      expect(await pause.getAttribute('aria-pressed')).toBe('true');
      await page.clock.runFor(30000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('grading');
      await page.keyboard.press('Enter');
      await showWholeTerminal(page);
      await advanceToState(page, 'complete');
      expect(await page.locator('[data-panel]').isVisible()).toBe(false);
      expect(await pause.textContent()).toBe('Demo finished');
      expect(await pause.getAttribute('aria-disabled')).toBe('true');
      expect(await pause.getAttribute('aria-pressed')).toBeNull();
      expect(await pause.evaluate(element => element === document.activeElement)).toBe(true);
      await page.keyboard.press('Enter');
      expect(await terminal.getAttribute('data-demo-state')).toBe('complete');
    } finally { await page.close(); }
  });

  it('shows a finished, still transcript when reduced motion is requested', async () => {
    const page = await browser.newPage({viewport:{width:390,height:640},reducedMotion:'reduce'});
    try {
      await serveWebsite(page);
      await installPausedClock(page);
      await page.goto(server.url);
      const terminal = page.locator('[data-terminal]');
      await expect.poll(() => terminal.getAttribute('data-demo-state')).toBe('complete');
      expect(await page.locator('[data-panel]').isVisible()).toBe(false);
      expect(await page.locator('[data-step]:not([hidden])').count()).toBe(6);
      expect(await page.locator('[data-task-done]').isVisible()).toBe(true);
      expect(await page.locator('[data-demo-pause]').isVisible()).toBe(true);
      expect(await page.locator('[data-demo-pause]').getAttribute('aria-disabled')).toBe('true');
      expect(await page.locator('[data-demo-pause]').textContent()).toBe('Demo finished');
      await showWholeTerminal(page);
      await page.clock.runFor(60000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('complete');
      expect(await page.locator('[data-panel]').isVisible()).toBe(false);
      expect(await terminal.locator('input, textarea').count()).toBe(0);
    } finally { await page.close(); }
  });

  it('waits while the analytics banner covers the terminal, then resumes when it is dismissed', async () => {
    const page = await browser.newPage({viewport:{width:390,height:640}});
    try {
      await serveWebsite(page, 12345, false);
      await installPausedClock(page);
      await page.goto(new URL('/#demo',server.url).href);
      const terminal = page.locator('[data-terminal]');
      const banner = page.locator('#ek-consent');
      await banner.waitFor({state:'visible'});
      await expectWholeTerminal(page);
      const overlapsTerminal = () => terminal.evaluate(element => {
        const box = element.getBoundingClientRect();
        const cover = document.querySelector('#ek-consent')!.getBoundingClientRect();
        const width = Math.min(box.right, cover.right, innerWidth) - Math.max(box.left, cover.left, 0);
        const height = Math.min(box.bottom, cover.bottom, innerHeight) - Math.max(box.top, cover.top, 0);
        return width > 0 && height > 0;
      });
      expect(await overlapsTerminal()).toBe(true);
      expect(await page.evaluate(() => localStorage.getItem('eklavya-analytics'))).toBeNull();
      // The hash navigation uses the site's smooth scroll. Wait for its native
      // animation to finish before measuring whether dismissal moves the page.
      let lastPosition: number | undefined, stableSamples = 0;
      await expect.poll(async () => {
        const current = await page.evaluate(() => scrollY);
        stableSamples = current === lastPosition ? stableSamples + 1 : 0;
        lastPosition = current;
        return stableSamples;
      }, {interval:100,timeout:3000}).toBeGreaterThanOrEqual(3);
      const position = await page.evaluate(() => scrollY);
      await page.clock.runFor(60000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('idle');
      expect(await page.locator('[data-prompt]').textContent()).toBe('');

      await banner.getByRole('button', {name:'Decline',exact:true}).click();
      expect(await banner.count()).toBe(0);
      expect(await page.evaluate(() => localStorage.getItem('eklavya-analytics'))).toBe('denied');
      expect(await page.evaluate(() => scrollY)).toBe(position);
      await advanceToState(page, 'typing');
      await page.clock.runFor(700);
      const prompt = await page.locator('[data-prompt]').textContent();
      expect(prompt!.length).toBeGreaterThan(0);

      // Reopen the existing settings control without scrolling to the footer.
      await page.locator('[data-analytics-choice]').evaluate(element => (element as HTMLElement).click());
      await banner.waitFor({state:'visible'});
      expect(await overlapsTerminal()).toBe(true);
      expect(await page.evaluate(() => scrollY)).toBe(position);
      await expect.poll(() => terminal.getAttribute('data-demo-paused')).toBe('true');
      await page.clock.runFor(30000);
      expect(await terminal.getAttribute('data-demo-state')).toBe('typing');
      expect(await page.locator('[data-prompt]').textContent()).toBe(prompt);
      await banner.getByRole('button', {name:'Decline',exact:true}).click();
      expect(await page.evaluate(() => scrollY)).toBe(position);
      await advanceToState(page, 'complete');
      expect(await page.locator('[data-panel]').isVisible()).toBe(false);
    } finally { await page.close(); }
  });

  it('keeps the mascot hero and automated panel readable in both themes', async () => {
    const page = await browser.newPage({viewport:{width:1280,height:1000}});
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let heroBackground: string | undefined, terminalBackground: string | undefined;
    try {
      await serveWebsite(page);
      await installPausedClock(page);
      for (const ground of ['ink','paper']) {
        await page.goto(server.url);
        await page.locator(`[data-ground="${ground}"]`).click();
        expect(await page.locator('html').getAttribute('data-mode')).toBe(ground);
        expect(await page.locator('.hero eklavya-mascot svg').getAttribute('data-expression')).toBe('neutral');
        const heroFill = await page.locator('.hero').evaluate(element => getComputedStyle(element).backgroundColor);
        heroBackground ??= heroFill;
        expect(heroFill).toBe(heroBackground);
        await expectReadable(page, '.hero h1, .hero h1 em, .hero__lede, .hero__note, .hero .btn');
        const terminalFill = await page.locator('[data-terminal]').evaluate(element => getComputedStyle(element).backgroundColor);
        terminalBackground ??= terminalFill;
        expect(terminalFill).toBe(terminalBackground);
        await showWholeTerminal(page);
        await advanceToState(page, 'awaiting');
        await expectReadable(page, '.quiz-brand b, [data-topic], .quiz-stem, .quiz-option, .quiz-option__note, .quiz-hints, .terminal-dim');
        await advanceToState(page, 'selected');
        await expectReadable(page, '[data-submit]');
        await advanceToState(page, 'feedback');
        await expectReadable(page, '[data-verdict], [data-explanation], [data-auto-close], [data-done]');
      }
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('fits the full replay frame on narrow and short screens in both themes', async () => {
    const page = await browser.newPage();
    try {
      await serveWebsite(page);
      await installPausedClock(page);
      for (const ground of ['ink','paper']) {
        for (const width of [1280,900,560,390]) {
          await page.setViewportSize({width,height:640});
          await page.goto(server.url);
          await page.locator(`[data-ground="${ground}"]`).click();
          await showWholeTerminal(page);
          await advanceToState(page, 'awaiting');
          expect(await page.locator('[data-panel]').isVisible()).toBe(true);
          await showWholeTerminal(page);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await advanceToState(page, 'selected');
          await expectInsidePanel(page, '[data-option="1"]');
          await advanceToState(page, 'submitting');
          await expectInsidePanel(page, '[data-submit]');
          await advanceToState(page, 'acknowledging');
          await expectInsidePanel(page, '[data-done]');
          await advanceToState(page, 'complete');
        }
      }
    } finally { await page.close(); }
  });

  it('shows comma-formatted GitHub stars and keeps the link useful when the API fails', async () => {
    for (const count of [12345,null,'offline'] as const) {
      const page = await browser.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      try {
        await serveWebsite(page, count);
        const apiUrl = 'https://api.github.com/repos/ProjectAJ14/eklavya';
        const settled = count === 'offline' ?
          page.waitForEvent('requestfailed', request => request.url() === apiUrl) :
          page.waitForResponse(response => response.url() === apiUrl);
        await page.goto(server.url);
        await settled;
        const badge = page.locator('[data-stars]');
        const expected = count === 12345 ? '12,345' : 'Star on GitHub';
        await expect.poll(() => badge.textContent()).toContain(expected);
        expect(await badge.isVisible()).toBe(true);
        expect(await badge.locator('xpath=ancestor::a').getAttribute('href')).toBe('https://github.com/ProjectAJ14/eklavya');
        if (count === 12345) expect(await badge.locator('xpath=ancestor::a').getAttribute('aria-label')).toContain('12,345 stars');
        expect(errors).toEqual([]);
      } finally { await page.close(); }
    }
  });

  it('starts direct demo links without requiring the reader to center the terminal', async () => {
    const page = await browser.newPage({viewport:{width:1280,height:720}});
    try {
      await serveWebsite(page);
      await installPausedClock(page);
      for (const target of ['/#demo','/demo/']) {
        await page.goto(new URL(target,server.url).href);
        await expect.poll(() => page.url()).toBe(new URL('/#demo',server.url).href);
        expect(await page.locator('[data-terminal]').count()).toBe(1);
        await expectWholeTerminal(page);
        await advanceToState(page, 'complete');
        expect(await page.locator('[data-task-done]').isVisible()).toBe(true);
      }
    } finally { await page.close(); }
  });

  it('keeps the name and arrow scene on the homepage, with a still reduced-motion version', async () => {
    const page = await browser.newPage();
    try {
      await serveWebsite(page);
      await page.goto(new URL('/#legend',server.url).href);
      expect(page.url()).toBe(new URL('/#legend',server.url).href);
      expect(await page.getByRole('heading', {name:'The archer who taught himself',exact:true}).isVisible()).toBe(true);
      expect(await page.locator('#legend .eyebrow').textContent()).toBe('The name');
      expect(await page.locator('#legend .shot').getAttribute('aria-hidden')).toBe('true');
      await expect.poll(() => page.locator('#legend').evaluate(element => element.classList.contains('is-firing'))).toBe(true);
      expect(await page.locator('.shot__arrow').evaluate(element => getComputedStyle(element).animationName)).toBe('legendArrow');
      expect(await page.evaluate(() => {
        const ids = Array.from(document.querySelectorAll('[id]'), element => element.id);
        return ids.filter((id, index) => ids.indexOf(id) !== index);
      })).toEqual([]);
      await page.emulateMedia({reducedMotion:'reduce'});
      for (const part of ['.shot__arrow','.shot__bow','.shot__target','.shot__ripple']) {
        expect(await page.locator(part).first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
      }
      expect(await page.locator('.shot__arrow').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
      expect(await page.locator('#legend-title').isVisible()).toBe(true);
    } finally { await page.close(); }
  });

  it('fits both grounds on mobile and loads everything from loopback', async () => {
    const page = await browser.newPage({ viewport:{width:390,height:844} });
    const outbound: string[] = [], errors: string[] = [];
    page.on('request', r => { if (new URL(r.url()).origin !== new URL(server.url).origin) outbound.push(r.url()); });
    page.on('pageerror', e => errors.push(e.message));
    try {
      await page.goto(new URL('/mascot.html',server.url).href);
      await page.locator('#expressions button').last().waitFor();
      for (const ground of ['ink','paper']) {
        if (ground === 'paper') await page.getByRole('button', {name:'Switch to paper theme'}).click();
        expect(await page.locator('html').getAttribute('data-mode')).toBe(ground);
        for (const width of [1280, 900, 560, 390]) {
          await page.setViewportSize({width,height:844});
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
        expect(await page.locator('#preview svg').evaluate(e => getComputedStyle(e.querySelector('[fill="var(--mascot-coral)"]')!).fill)).toBe('rgb(239, 152, 117)');
      }
      expect(outbound).toEqual([]); expect(errors).toEqual([]);
    } finally { await page.close(); }
  });
});
