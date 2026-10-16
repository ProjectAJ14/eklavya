// The daily card: once a local day, only on arrival at the Learning dashboard, never over something else.
// Each case opens its own browser context, so each has its own storage and its own "today".
import { describe, expect, it } from 'vitest';
import { OPTS, open } from './dashboard-browser-helpers.js';

declare const DAILY: any;
declare const DAILY_CARDS: any;
declare global { interface Window { EklavyaDaily: any } }
const NOW = { daily: true, init: 'window.__eklavyaDailyDelay = 0;' };
const KEY = 'eklavya-dash-daily';
const isOpen = (page: import('playwright-core').Page) => page.evaluate(() => (document.getElementById('daily') as HTMLDialogElement).open);
const memory = (page: import('playwright-core').Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), KEY);

describe.skipIf(!OPTS)('the daily card', () => {
  it('opens once on arrival, names its reason, and is remembered for the day', async () => {
    const w = await open('#/learning/dashboard', NOW);
    const { page } = w;
    await page.waitForSelector('#daily[open]');
    const card = await page.getAttribute('#daily', 'data-card');
    expect(['milestone', 'comeback', 'weekly', 'due', 'goals', 'ahead', 'checkin']).toContain(card);
    expect(await page.textContent('#daily .daily__why')).toMatch(/Shown once a day\.$/);
    expect(await page.getAttribute('#daily eklavya-mascot', 'state')).toBeTruthy();
    expect(await page.evaluate(() => document.activeElement?.className)).toContain('daily__btn--go'); // Enter takes the action
    const mem = await memory(page);
    expect(mem.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(mem.last[card!]).toBe(mem.day);
    await page.reload();
    await page.waitForFunction(() => document.documentElement.dataset.rendered === location.hash);
    await page.waitForTimeout(150);
    expect(await isOpen(page)).toBe(false);
    expect(w.errors).toEqual([]);
    expect(w.outbound).toEqual([]);
    await w.ctx.close();
  }, 60000);

  it('closes with Escape, with Not now and with the close button, and gives focus back', async () => {
    for (const how of ['Escape', '[data-daily-close].daily__btn', '.daily__x']) {
      const w = await open('#/learning/dashboard', NOW);
      await w.page.waitForSelector('#daily[open]');
      if (how === 'Escape') await w.page.keyboard.press('Escape');
      else await w.page.click('#daily ' + how);
      await w.page.waitForFunction(() => !(document.getElementById('daily') as HTMLDialogElement).open && document.getElementById('daily')!.innerHTML === '');
      await w.ctx.close();
    }
  }, 60000);

  it('does not open for an artifact the agent opened, and waits for the Learning dashboard', async () => {
    const w = await open('#/artifacts/dashboard', NOW);
    const { page } = w;
    await page.waitForTimeout(200);
    expect(await isOpen(page)).toBe(false);
    expect(await memory(page)).toBeNull();
    await page.click('nav.side__nav a[href^="#/artifacts"]').catch(() => {});
    await page.evaluate(() => { location.hash = '#/learning/dashboard'; });
    await page.waitForSelector('#daily[open]');
    await w.ctx.close();
  }, 60000);

  it('stays shut for a redraw, a tab and a second visit the same day', async () => {
    const w = await open('#/learning/dashboard', NOW);
    const { page } = w;
    await page.waitForSelector('#daily[open]');
    await page.keyboard.press('Escape');
    await page.evaluate(() => { location.hash = '#/learning/concepts'; });
    await page.waitForFunction(() => document.documentElement.dataset.rendered === '#/learning/concepts');
    await page.evaluate(() => { location.hash = '#/learning/dashboard'; });
    await page.waitForFunction(() => document.documentElement.dataset.rendered === '#/learning/dashboard');
    await page.waitForTimeout(200);
    expect(await isOpen(page)).toBe(false);
    await w.ctx.close();
  }, 60000);

  it('is switched off from Settings, in the Companion tab, and stays off, and can be switched back on', async () => {
    const w = await open('#/learning/dashboard', NOW);
    const { page } = w;
    await page.waitForSelector('#daily[open]');
    await page.keyboard.press('Escape');
    expect(await page.locator('aside [data-daily]').count()).toBe(0); // no longer in the sidebar
    await page.evaluate(() => { location.hash = '#/settings/dashboard/companion'; });
    await page.waitForSelector('[data-daily="off"]');
    expect(await page.getAttribute('[data-daily="on"]', 'aria-pressed')).toBe('true');
    await page.click('[data-daily="off"]');
    expect(await page.getAttribute('[data-daily="off"]', 'aria-pressed')).toBe('true');
    expect((await memory(page)).off).toBe(true);
    await page.click('[data-daily="on"]');
    expect((await memory(page)).off).toBe(false);
    await w.ctx.close();
    const off = await open('#/settings/dashboard/companion', { ...NOW, init: NOW.init + `localStorage.setItem('${KEY}', '{"off":true}');` });
    await off.page.waitForTimeout(200);
    expect(await isOpen(off.page)).toBe(false);
    expect(await off.page.getAttribute('[data-daily="off"]', 'aria-pressed')).toBe('true');
    await off.ctx.close();
  }, 60000);

  it('shows nothing when storage throws, because a card that cannot remember would greet every navigation', async () => {
    const dead = await open('#/learning/dashboard', { ...NOW, init: NOW.init + `Object.defineProperty(window, 'localStorage', { get() { throw new Error('no storage'); } });` });
    await dead.page.waitForTimeout(250);
    expect(await isOpen(dead.page)).toBe(false);
    await dead.ctx.close();
  }, 60000);

  it('puts the archer and a line on the streak chart, and keeps the line through a redraw', async () => {
    const w = await open('#/learning/dashboard');
    const { page } = w;
    const line = await page.textContent('.streak__talk .say');
    expect(line?.length).toBeGreaterThan(10);
    expect(await page.getAttribute('.streak__talk eklavya-mascot', 'state')).toMatch(/^(idle|success|complete)$/);
    await page.setViewportSize({ width: 700, height: 900 });
    await page.waitForTimeout(250);
    expect(await page.textContent('.streak__talk .say')).toBe(line);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await w.ctx.close();
  }, 60000);

  it('has an action that leads somewhere: a hash, or a concept sheet', async () => {
    const w = await open('#/learning/dashboard', NOW);
    const { page } = w;
    await page.waitForSelector('#daily[open]');
    const card = await page.getAttribute('#daily', 'data-card');
    const go = await page.getAttribute('#daily [data-daily-go]', 'data-daily-go');
    await page.click('#daily [data-daily-go]');
    await page.waitForFunction(() => !(document.getElementById('daily') as HTMLDialogElement).open);
    if (go?.startsWith('sheet:')) await page.waitForSelector('#sheet[open]');
    else if (go) expect(await page.evaluate(() => location.hash)).toBe(go);
    else expect(card).toBe('milestone');
    expect(w.errors).toEqual([]);
    await w.ctx.close();
  }, 60000);

  it('draws every card from real signals, in both grounds, without NaN or undefined', async () => {
    for (const ground of ['ink', 'paper'] as const) {
      const w = await open('#/learning/dashboard', { ground });
      const { page } = w;
      for (const id of ['milestone', 'comeback', 'weekly', 'due', 'goals', 'ahead', 'checkin']) {
        const text = await page.evaluate(async (card) => {
          const sig: any = DAILY.signals();
          sig.top ??= { slug: 'x', name: 'X', project: null, domain: 'd', tier: 2, score: 0.3, days: 2 };
          sig.due ||= 1;
          sig.lastWeek = { answers: 10, right: 7, prev: { answers: 10, right: 5 } };
          sig.weakest = 'a'; sig.strongest = 'b'; sig.daysAway = 4;
          sig.streak = { current: 14, best: 14, today: true };
          const d = document.getElementById('daily') as HTMLDialogElement;
          if (d.open) { d.close(); while (d.innerHTML !== '') await new Promise((r) => setTimeout(r, 5)); } // the close event clears the card on its own task
          const decision = { id: card, why: 'Test.' };
          DAILY.open(decision, sig, DAILY_CARDS[card](sig, decision));
          return d.textContent;
        }, id);
        expect(text, id).not.toMatch(/NaN|undefined|null/);
        if (id === 'weekly') expect(text).toContain('last week');
        expect(await page.isVisible('#daily .daily__btn--go'), id).toBe(true);
      }
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }
  }, 120000);

  it('does not remember a card it could not draw, and does not break the page', async () => {
    const w = await open('#/learning/dashboard', { daily: true, init: 'window.__eklavyaDailyDelay = 1e9;' });
    const { page } = w;
    const shown = await page.evaluate(() => {
      for (const id of Object.keys(DAILY_CARDS)) DAILY_CARDS[id] = () => { throw new Error('boom'); };
      DAILY.decide();
      return { open: (document.getElementById('daily') as HTMLDialogElement).open, mem: localStorage.getItem('eklavya-dash-daily') };
    });
    expect(shown.open).toBe(false);
    expect(shown.mem === null || JSON.parse(shown.mem).day === null).toBe(true);
    expect(w.errors.filter((e) => !/daily card/.test(e) && !/boom/.test(e))).toEqual([]);
    await w.ctx.close();
  }, 60000);

  it('does not repeat the streak line after a reload', async () => {
    const w = await open('#/learning/dashboard');
    const { page } = w;
    const seen = [await page.textContent('.streak__talk .say')];
    for (let i = 0; i < 4; i++) {
      await page.reload();
      await page.waitForFunction(() => document.documentElement.dataset.rendered === location.hash && document.querySelector('.streak__talk .say'));
      seen.push(await page.textContent('.streak__talk .say'));
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i], String(i)).not.toBe(seen[i - 1]);
    await w.ctx.close();
  }, 60000);

  it('works out its signals and decision in a few milliseconds', async () => {
    const w = await open('#/learning/dashboard', { daily: true, init: 'window.__eklavyaDailyDelay = 1e9;' });
    const ms = await w.page.evaluate(() => {
      const t0 = performance.now();
      for (let i = 0; i < 20; i++) window.EklavyaDaily.decide(DAILY.signals(), window.EklavyaDaily.normalize(null), { route: 'learning/dashboard', busy: false, hidden: false });
      return (performance.now() - t0) / 20;
    });
    expect(ms).toBeLessThan(50);
    await w.ctx.close();
  }, 60000);
});
