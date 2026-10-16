// The correction dialog closes itself 3 seconds after a right answer; the bar's face follows its state.
// Its own file: each case needs a missed question of its own, and the others count the ones waiting.
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { createArtifact } from '../dist/artifacts.js';
import { OPTS, enc, fix, open } from './dashboard-browser-helpers.js';

describe.skipIf(!OPTS)('the correction dialog counts down', () => {
  /** A fresh miss, its page open, the clock faked and paused, and the right answer picked. */
  async function corrected(opts: { reducedMotion?: boolean } = {}) {
    const art = createArtifact({ title: 'Countdown, explained', kind: 'explainer', concept: 'csrf', attempt: fix.missed() });
    const w = await open(`#/artifacts/view/${enc(art.id)}`);
    const { page } = w;
    await page.waitForSelector('#fix-open');
    if (opts.reducedMotion) await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    await page.click('#fix-open');
    await page.click('#fix-opts [data-pick="A lock"]');
    await page.waitForSelector('#fix-msg:has-text("Corrected.")');
    return w;
  }
  const label = (page: Page) => page.textContent('#fix-close');
  const isOpen = (page: Page) => page.evaluate(() => (document.getElementById('fix') as HTMLDialogElement).open);

  it('shows 3, 2, 1 on Close with the answer still in view, then closes and turns the face happy', async () => {
    const w = await corrected();
    const { page } = w;
    expect(await page.getAttribute('#fixbar eklavya-mascot', 'state')).toBe('warning');
    expect(await page.textContent('#fix-msg')).toContain('Closing in 3 seconds. Press Stay open to cancel.');
    expect(await page.textContent('#fix-opts [data-pick="A lock"]')).toContain('Right answer');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('fix-stay');
    // The message is read out once; the ticks change only Close.
    await page.evaluate(() => {
      (window as any).__msg = 0;
      new MutationObserver(() => { (window as any).__msg++; }).observe(document.getElementById('fix-msg')!, { childList: true, subtree: true, characterData: true });
    });
    expect(await label(page)).toBe('Closing in 3…');
    await page.clock.runFor(1000);
    expect(await label(page)).toBe('Closing in 2…');
    await page.clock.runFor(1000);
    expect(await label(page)).toBe('Closing in 1…');
    expect(await isOpen(page)).toBe(true);
    await page.clock.runFor(1000);
    expect(await isOpen(page)).toBe(false);
    expect(await page.evaluate(() => (window as any).__msg)).toBe(0);
    await page.waitForFunction(() => /Corrected on try/.test(document.getElementById('fixbar')?.textContent ?? ''));
    expect(await page.getAttribute('#fixbar eklavya-mascot', 'state')).toBe('success');
    expect(await page.getAttribute('#fixbar', 'class')).toContain('is-done');
    expect(await label(page)).toBe('Close');
    expect(w.errors).toEqual([]);
    await w.ctx.close();
  }, 60000);

  it('stays open when asked: Close reads Close again and nothing closes later', async () => {
    const w = await corrected();
    const { page } = w;
    await page.clock.runFor(1000);
    await page.click('#fix-stay');
    expect(await label(page)).toBe('Close');
    expect(await page.isVisible('#fix-stay')).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('fix-close');
    await page.clock.runFor(10_000);
    expect(await isOpen(page)).toBe(true);
    expect(await label(page)).toBe('Close');
    await page.click('#fix-close');
    expect(await isOpen(page)).toBe(false);
    await w.ctx.close();
  }, 60000);

  it('closes at once on Escape, and no timer is left to fire after', async () => {
    const w = await corrected();
    const { page } = w;
    await page.clock.runFor(1000);
    await page.keyboard.press('Escape');
    expect(await isOpen(page)).toBe(false);
    // The dialog's close event is queued a task after it closes.
    await page.waitForFunction(() => document.getElementById('fix-close')!.textContent === 'Close');
    await page.clock.runFor(10_000);
    expect(w.errors).toEqual([]);
    await w.ctx.close();
  }, 60000);

  it('holds the count while the tab is hidden, so the dialog never closes unseen', async () => {
    const w = await corrected();
    const { page } = w;
    const visibility = (hidden: boolean) => page.evaluate((h) => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
    await page.clock.runFor(1000);
    await visibility(true);
    await page.clock.runFor(10_000);
    expect(await isOpen(page)).toBe(true);
    expect(await label(page)).toBe('Closing in 2…');
    await visibility(false);
    await page.clock.runFor(1000);
    expect(await label(page)).toBe('Closing in 1…');
    await page.clock.runFor(1000);
    expect(await isOpen(page)).toBe(false);
    await w.ctx.close();
  }, 60000);

  it('drops the fill under reduced motion and keeps the number ticking', async () => {
    const w = await corrected({ reducedMotion: true });
    const { page } = w;
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('fix-close')!, '::before').display)).toBe('none');
    await page.clock.runFor(1000);
    expect(await label(page)).toBe('Closing in 2…');
    await w.ctx.close();
  }, 60000);

  it('has the fill moving otherwise, and Stay open ahead of Close in the tab order', async () => {
    const w = await corrected();
    const { page } = w;
    expect(await page.evaluate(() => getComputedStyle(document.getElementById('fix-close')!, '::before').animationName)).toBe('fix-fill');
    const order = await page.evaluate(() => [...document.querySelectorAll('.fix__foot button')].map((b) => b.id));
    expect(order).toEqual(['fix-stay', 'fix-close']);
    await w.ctx.close();
  }, 60000);
});
