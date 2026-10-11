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

async function serveWebsite(page: Page) {
  const publicDir = new URL('../../web/public/', import.meta.url);
  await page.addInitScript(() => localStorage.setItem('eklavya-analytics', 'denied'));
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
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

  it('keeps the mascot hero and the quiz replay readable on both grounds', async () => {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let heroBackground: string | undefined, terminalBackground: string | undefined;
    try {
      await serveWebsite(page);
      await page.clock.install();
      for (const ground of ['ink','paper']) {
        await page.goto(server.url);
        await page.locator(`[data-ground="${ground}"]`).click();
        expect(await page.locator('html').getAttribute('data-mode')).toBe(ground);
        expect(await page.locator('.hero eklavya-mascot svg').getAttribute('data-expression')).toBe('neutral');
        const heroFill = await page.locator('.hero').evaluate(e => getComputedStyle(e).backgroundColor);
        if (!heroBackground) heroBackground = heroFill;
        expect(heroFill).toBe(heroBackground);
        await expectReadable(page, '.hero h1, .hero h1 em, .hero__lede, .hero__note, .hero .btn');

        await page.goto(new URL('/demo/',server.url).href);
        expect(await page.locator('html').getAttribute('data-mode')).toBe(ground);
        const terminalFill = await page.locator('[data-terminal]').evaluate(e => getComputedStyle(e).backgroundColor);
        if (!terminalBackground) terminalBackground = terminalFill;
        expect(terminalFill).toBe(terminalBackground);
        await page.locator('[data-prompt]').press('Enter');
        await page.clock.runFor(3300);
        expect(await page.locator('[data-question]').isVisible()).toBe(true);
        await expectReadable(page, '.quiz-brand b, [data-topic], .quiz-stem, .quiz-option, .quiz-option__note, .quiz-hints, .terminal-dim');

        await page.locator('[data-option="2"]').click();
        expect(await page.locator('[data-option="2"]').getAttribute('aria-pressed')).toBe('true');
        expect(await page.locator('[data-result]').isVisible()).toBe(false);
        await expectReadable(page, '[data-submit]');
        await page.locator('[data-submit]').click();
        expect(await page.locator('[data-result]').isVisible()).toBe(true);
        expect(await page.locator('[data-verdict]').textContent()).toBe('Needs another look');
        await expectReadable(page, '[data-verdict], [data-correct-answer], [data-explanation], [data-auto-close], [data-done]');

        // The real 15-second result timer may close the pane, but must leave outside focus alone.
        const outside = page.locator(`[data-ground="${ground}"]`);
        await outside.focus();
        await page.clock.runFor(15000);
        expect(await page.locator('[data-panel]').isVisible()).toBe(false);
        expect(await outside.evaluate(e => e === document.activeElement)).toBe(true);

        await page.locator('[data-replay]').click();
        await page.clock.runFor(3300);
        await page.locator('[data-option="1"]').click();
        await page.locator('[data-submit]').click();
        expect(await page.locator('[data-verdict]').textContent()).toBe('Correct');
        await expectReadable(page, '[data-verdict], [data-done]');
        await page.locator('[data-done]').click();
        expect(await page.locator('[data-panel]').isVisible()).toBe(false);
        expect(await page.locator('[data-prompt]').evaluate(e => e === document.activeElement)).toBe(true);
      }
      expect(errors).toEqual([]);
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
