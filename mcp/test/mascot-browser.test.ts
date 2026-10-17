import fs from 'node:fs';
import path from 'node:path';
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
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html' : name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.jpg') ? 'image/jpeg' : 'image/svg+xml';
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

async function installPausedClock(page: Page) {
  const now = new Date('2026-10-11T12:00:00Z');
  await page.clock.install({time:now});
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
}

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

  it('keeps the mascot hero readable in both themes', async () => {
    const page = await browser.newPage({viewport:{width:1280,height:1000}});
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    let heroBackground: string | undefined;
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
      }
      expect(errors).toEqual([]);
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

  it('embeds the launch film at #demo, keeps /demo/ redirecting, and needs no replay script', async () => {
    const page = await browser.newPage({viewport:{width:1280,height:720}});
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await serveWebsite(page);
      for (const target of ['/#demo','/demo/']) {
        await page.goto(new URL(target,server.url).href);
        await expect.poll(() => page.url()).toBe(new URL('/#demo',server.url).href);
        const video = page.locator('video#demo');
        expect(await video.count()).toBe(1);
        expect(await video.getAttribute('controls')).not.toBeNull();
        expect(await video.getAttribute('autoplay')).toBeNull();
        expect(await video.getAttribute('poster')).toBe('/demo/eklavya-launch.jpg');
        expect(await page.locator('[data-terminal]').count()).toBe(0);
      }
      for (const asset of ['demo/eklavya-launch.mp4','demo/eklavya-launch.jpg'])
        expect(fs.statSync(new URL(`../../web/public/${asset}`, import.meta.url)).size, asset).toBeGreaterThan(10000);
      expect(errors).toEqual([]);
    } finally { await page.close(); }
  });

  it('keeps both arrow scenes decorative, pauses the hero loop, and honors reduced motion', async () => {
    const page = await browser.newPage();
    try {
      await page.addInitScript(() => Object.defineProperty(document, 'hasFocus', {value:() => false}));
      await serveWebsite(page);
      await page.goto(server.url);
      const hero = page.locator('[data-hero-shot]');
      const arrow = hero.locator('.hero__shot-arrow');
      expect(await hero.getAttribute('aria-hidden')).toBe('true');
      expect(await hero.locator('.hero__shot-bow, .hero__shot-arrow, .hero__shot-target').count()).toBe(3);
      expect(await page.evaluate(() => document.hidden)).toBe(false);
      await expect.poll(() => hero.getAttribute('data-hero-playing')).toBe('false');
      expect(await arrow.evaluate(element => getComputedStyle(element).animationPlayState)).toBe('paused');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect.poll(() => hero.getAttribute('data-hero-playing')).toBe('true');
      expect(await arrow.evaluate(element => getComputedStyle(element).animationIterationCount)).toBe('infinite');
      expect(await arrow.evaluate(element => getComputedStyle(element).animationPlayState)).toBe('running');
      const opacity = await hero.evaluate(element => Number(getComputedStyle(element).opacity));
      expect(opacity).toBeGreaterThan(0);
      expect(opacity).toBeLessThan(.5);
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {configurable:true,get:() => true});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(await hero.getAttribute('data-hero-playing')).toBe('false');
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', {configurable:true,get:() => false});
        document.dispatchEvent(new Event('visibilitychange'));
      });
      expect(await hero.getAttribute('data-hero-playing')).toBe('true');
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      expect(await hero.getAttribute('data-hero-playing')).toBe('false');
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      expect(await hero.getAttribute('data-hero-playing')).toBe('true');
      await page.goto(new URL('/#legend',server.url).href);
      await expect.poll(() => hero.getAttribute('data-hero-playing')).toBe('false');
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
      expect(await arrow.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
      expect(await hero.getAttribute('data-hero-playing')).toBe('false');
      expect(await page.locator('.shot__arrow').evaluate(element => getComputedStyle(element).opacity)).toBe('1');
      expect(await page.locator('#legend-title').isVisible()).toBe(true);
    } finally { await page.close(); }
  });

  it('gives only the hero mascot green eyes that follow a mouse and stay centered for touch or reduced motion', async () => {
    const page = await browser.newPage({viewport:{width:1280,height:900}});
    let touch: Page | undefined;
    try {
      await serveWebsite(page);
      await page.goto(server.url);
      const pupils = page.locator('[data-hero-mascot] .hero-eye__pupil');
      const centered = ['translate(0 0)','translate(0 0)'];
      const positions = () => pupils.evaluateAll(elements => elements.map(element => element.getAttribute('transform')));
      await expect.poll(() => pupils.count()).toBe(2);
      await expect.poll(positions).toEqual(centered);
      // An ordinary instance shares the page's styles but has no hero opt-in.
      await page.locator('footer').evaluate(element => {
        const mascot = document.createElement('eklavya-mascot');
        mascot.setAttribute('state', 'info');
        mascot.setAttribute('data-test-footer-mascot', '');
        element.appendChild(mascot);
      });
      const ordinary = page.locator('[data-test-footer-mascot]');
      const ordinaryMarkup = await ordinary.innerHTML();
      const ordinaryFill = await ordinary.locator('.ek-mascot__face > rect').first().evaluate(element => getComputedStyle(element).fill);
      for (const ground of ['ink','paper']) {
        await page.locator(`[data-ground="${ground}"]`).click();
        const brand = await page.locator('.hero h1 em').evaluate(element => getComputedStyle(element).color);
        expect(await page.locator('[data-hero-mascot] .hero-eye').evaluateAll(elements => elements.map(element => getComputedStyle(element).fill))).toEqual([brand,brand]);
        expect(ordinaryFill).not.toBe(brand);
        await page.mouse.move(2,2);
        await expect.poll(positions).not.toEqual(centered);
        const first = await positions();
        await page.mouse.move(1278,898);
        await expect.poll(positions).not.toEqual(first);
        expect(await pupils.evaluateAll(elements => {
          const eyes = document.querySelectorAll('[data-hero-mascot] .hero-eye');
          return elements.every((element, index) => {
            const pupil = element.getBoundingClientRect(), eye = eyes[index].getBoundingClientRect();
            return pupil.left >= eye.left && pupil.right <= eye.right && pupil.top >= eye.top && pupil.bottom <= eye.bottom;
          });
        })).toBe(true);
      }
      await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointerout', {pointerType:'mouse',relatedTarget:null})));
      expect(await positions()).toEqual(centered);
      await page.mouse.move(2,2);
      await expect.poll(positions).not.toEqual(centered);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      expect(await positions()).toEqual(centered);
      await page.mouse.move(1278,898);
      expect(await positions()).toEqual(centered);
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await page.mouse.move(2,2);
      await expect.poll(positions).not.toEqual(centered);
      await page.evaluate(() => document.dispatchEvent(new PointerEvent('pointermove', {pointerType:'touch',clientX:1278,clientY:898,bubbles:true})));
      expect(await positions()).toEqual(centered);
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.mouse.move(1278,898);
      expect(await positions()).toEqual(centered);
      expect(await ordinary.innerHTML()).toBe(ordinaryMarkup);
      expect(await ordinary.locator('.ek-mascot__face > rect').first().evaluate(element => getComputedStyle(element).fill)).toBe(ordinaryFill);
      expect(await ordinary.locator('.hero-eye, .hero-eye__pupil').count()).toBe(0);

      touch = await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
      await serveWebsite(touch);
      await touch.goto(server.url);
      const touchPupils = touch.locator('[data-hero-mascot] .hero-eye__pupil');
      await expect.poll(() => touchPupils.count()).toBe(2);
      expect(await touch.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false);
      await touch.touchscreen.tap(10,10);
      await touch.mouse.move(388,842);
      expect(await touchPupils.evaluateAll(elements => elements.map(element => element.getAttribute('transform')))).toEqual(centered);
    } finally { await page.close(); await touch?.close(); }
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
