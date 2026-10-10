import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { openDb, type DB } from '../src/db.js';
import { startDashboard } from '../dist/dashboard.js';
import { tempDbPath, cleanup } from './helpers.js';

const options = process.env.EKLAVYA_TEST_BROWSER ? { executablePath:process.env.EKLAVYA_TEST_BROWSER } : fs.existsSync(chromium.executablePath()) ? {} :
  fs.existsSync('/Applications/Google Chrome.app') ? { channel:'chrome' } : null;
if (!options && process.env.CI) throw new Error('mascot-browser: no Chromium on CI');
let previousHome: string | undefined;
let browser: Browser, db: DB, file: string, server: Awaited<ReturnType<typeof startDashboard>>;

describe.skipIf(!options)('offline mascot studio in a real browser', () => {
  beforeAll(async () => {
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

  it('follows the website terminal through loading, encouragement and completion', async () => {
    const page = await browser.newPage();
    const publicDir = new URL('../../web/public/', import.meta.url);
    try {
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin !== new URL(server.url).origin) return route.abort();
        const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        // Only test-owned static requests are fulfilled; no network dependencies.
        if (name.includes('..')) return route.abort();
        const file = new URL(name, publicDir);
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return route.abort();
        const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : 'image/svg+xml';
        await route.fulfill({contentType:type,body:fs.readFileSync(file)});
      });
      await page.clock.install();
      await page.goto(server.url);
      await page.clock.runFor(15000);
      const companion = page.locator('[data-demo-mascot]');
      for (const option of ['2','1']) {
        await page.locator('[data-input]').press('Enter');
        expect(await companion.getAttribute('state')).toBe('loading');
        expect(await companion.locator('svg').getAttribute('data-expression')).toBe('excited');
        await page.clock.runFor(4600);
        expect(await companion.getAttribute('state')).toBe('review');
        await page.locator('[data-opt="' + option + '"]').click();
        await page.clock.runFor(500);
        expect(await companion.getAttribute('state')).toBe(option === '1' ? 'success' : 'tip');
        await page.clock.runFor(2500);
        expect(await companion.getAttribute('state')).toBe('complete');
        await page.clock.runFor(600);
        expect(await companion.getAttribute('state')).toBe('info');
      }
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
