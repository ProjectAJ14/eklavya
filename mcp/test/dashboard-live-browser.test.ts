// Split by feature so Vitest's file sharding can divide the browser work.
//
// Phase 4 of #171, the page half: an open dashboard is live, and never moves the reader. The server says
// that something changed (`GET /api/events`, tested in dashboard-events.test.ts); the page reads the new
// payload and draws the screen it is on again in place. Every test here writes to the database the way
// another process would (a hook, the MCP server, the CLI: this process shares the file with the server the
// page talks to) and then holds the page to the rule: the new row shows, and nothing the reader was in the
// middle of moves, loses its place or is reloaded.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { afterEach, describe, expect, it } from 'vitest';
import { startDashboard } from '../dist/dashboard.js';
import { insertFeedback } from '../src/feedback.js';
import { insertEntry } from '../src/memory/store.js';
import { gradeConcept, recordRetry } from '../src/store.js';
import { OPTS, db, enc, fix, fx, home, isStream, open, probeTransition, ready } from './dashboard-browser-helpers.js';

// Globals of the page under test (a script's `let` and `const` are reachable by name from `evaluate`, not from `window`).
declare const S: { cursor: string; feedback: { notify: boolean } };
declare const LIVE: { es: EventSource | null; delay: number; heard: string; busy: boolean; more: boolean };
declare function liveReopen(): void;
declare function liveClose(): void;
declare function adoptState(s: unknown, inv: unknown): void;

const HEIGHT = 420;

/**
 * What `eklavya` writes when a hook logs a missed answer: one attempt, ten days old, on a concept with no history.
 * It is due, so it is one more row on the Review list and one more in the sidebar's count. Returns what the list shows.
 */
let written = 0;
function writeDue(repo: string | null = null): { name: string; slug: string } {
  const c = db.prepare('SELECT id, slug, name FROM concepts WHERE id NOT IN (SELECT concept_id FROM attempts) ORDER BY id LIMIT 1')
    .get() as { id: number; slug: string; name: string };
  gradeConcept(db, {
    conceptId: c.id, sessionId: `s-live-${++written}`, question: `Why does ${c.slug} matter here?`, answer: 'not sure', grade: 1,
    difficulty: 2, feedback: null, outcome: 'answered', format: null, options: null, repo, level: null,
    now: new Date(Date.now() - 10 * 86400000),
  });
  return { name: c.name, slug: c.slug };
}

const reviewCount = (page: Page) => page.$eval('#nav a[data-nav="review"] i', (i) => Number(i.textContent));
/** The page has read the payload that goes with a cursor other than `from`, and drawn it. */
const adopted = (page: Page, from: string, timeout = 3000) => page.waitForFunction((c) => S.cursor !== c, from, { timeout });
const cursor = (page: Page) => page.evaluate(() => S.cursor);
/** The path and query of every request to the API the page makes from now on, the stream aside. */
function watch(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/') && !isStream(r.url())) seen.push(u.pathname + u.search); });
  return seen;
}
/** The same for the stream itself: one request each time the page opens one. */
function watchStream(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => { if (isStream(r.url())) seen.push(r.url()); });
  return seen;
}

const configFile = () => path.join(home, 'home', 'config.json');
/** What `eklavya config set` does to the user's file, from outside the page. */
function configure(cfg: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg));
}
afterEach(() => {
  if (!OPTS) return;
  fs.rmSync(configFile(), { force: true });
  db.exec('DELETE FROM feedback_items');
});

/** Scrolls the reader down (the page's own scroll is smooth, so an instant one is asked for) and says how far. */
async function scrollTo(page: Page, y: number): Promise<number> {
  await page.evaluate((to) => window.scrollTo({ top: to, behavior: 'instant' }), y);
  return page.evaluate(() => window.scrollY);
}

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('live updates', () => {
    it('shows work written elsewhere on the Review list and in the sidebar within two seconds, with no reload and one read', async () => {
      const w = await open('#/learning/review', { height: 700 });
      const { page } = w;
      const asked = watch(page);
      const before = await reviewCount(page);
      const was = await cursor(page);
      const row = writeDue();
      const wrote = Date.now();
      await page.waitForFunction((n) => Number(document.querySelector('#nav a[data-nav="review"] i')!.textContent) === n, before + 1, { timeout: 2000 });
      expect(Date.now() - wrote, 'the new row showed within two seconds').toBeLessThan(2000);
      expect(await page.textContent('#view table')).toContain(row.name);
      expect(await page.evaluate(() => performance.getEntriesByType('navigation').length), 'no reload').toBe(1);
      expect(await cursor(page)).not.toBe(was);
      // One read of each, for the one change: the rest is drawn from them.
      await page.waitForTimeout(300);
      expect(asked.filter((a) => a === '/api/state')).toHaveLength(1);
      expect(asked.filter((a) => a === '/api/projects')).toHaveLength(1);
      // Still the Review page the reader was on, drawn for the URL, with nothing waiting.
      expect(await page.evaluate(() => location.hash)).toBe('#/learning/review');
      expect(await page.locator('#view .loader').count()).toBe(0);
      expect(w.errors).toEqual([]);
      expect(w.outbound).toEqual([]);
      await w.ctx.close();
    }, 30000);

    it('touches nothing on a page whose new data changed nothing it shows', async () => {
      // Settings shows nothing an answer changes, and Review nothing a note of feedback does (it is off, so not even a badge).
      // The page's own markup is left alone, where it is the same; a chart is the one thing drawn again.
      for (const [hash, write] of [
        ['#/settings/dashboard/pacing', () => writeDue()],
        ['#/learning/review', () => insertFeedback(db, {
          session_id: 's-live-quiet', project: fx.repo.mixed, event_id: null, prompt: 'a quiet one', model: 'sonnet',
          review: { worked: 'A goal.', gaps: [] } as never, better: 'Better [here].', tips: ['Tip.'],
        })],
      ] as const) {
        const w = await open(hash, { height: HEIGHT });
        const { page } = w;
        await page.evaluate(() => {
          const w = window as any;
          w.__moves = [];
          new MutationObserver((records) => { for (const r of records) w.__moves.push(`${r.type}:${(r.target as Element).id || (r.target as Element).nodeName}`); })
            .observe(document.getElementById('view')!, { childList: true, subtree: true, characterData: true });
        });
        const was = await cursor(page);
        write();
        await adopted(page, was);
        await page.waitForTimeout(500);
        // A chart is drawn from the data, which the markup around it does not carry, so it is drawn again in its own element.
        const moves = (await page.evaluate(() => (window as any).__moves as string[])).filter((m) => !/^childList:c-/.test(m));
        expect(moves, hash).toEqual([]);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }
    }, 60000);

    it('is gone: no #stale, no poll, no refresh notice, and nothing that reloads the page', async () => {
      const w = await open('#/learning/dashboard');
      for (const h of ['#/learning/dashboard', '#/memory/dashboard', '#/artifacts/dashboard', '#/feedback/dashboard', '#/settings/dashboard']) {
        await w.page.evaluate((hash) => { location.hash = hash; }, h);
        await ready(w.page);
        expect(await w.page.locator('#stale').count(), h).toBe(0);
        expect(await w.page.evaluate(() => document.body.innerText), h).not.toMatch(/New activity since this page loaded/);
      }
      // The page never asks `/api/cursor`: the server tells it.
      const asked = watch(w.page);
      writeDue();
      await adopted(w.page, await cursor(w.page));
      expect(asked).not.toContain('/api/cursor');
      expect(await w.page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
      await w.ctx.close();
    }, 30000);

    it('draws every page again, in place, and none of them breaks, loses its place or shows a loader', async () => {
      const w = await open('#/learning/dashboard', { height: HEIGHT });
      const { page } = w;
      const routes = [
        '#/learning/dashboard', '#/learning/concepts', '#/learning/concepts/due', '#/learning/concept/csrf', '#/learning/review/skipped', '#/learning/sessions',
        '#/learning/session/s-mixed', '#/learning/session/s-mem', '#/learning/projects', '#/learning/domains', '#/learning/domain/web-auth',
        '#/memory/dashboard', '#/memory/timeline', '#/memory/timeline/decision', `#/memory/entry/${fx.entries.mixed}`, '#/memory/sessions',
        '#/memory/session/s-mixed', '#/memory/projects', '#/memory/reuse', '#/memory/health',
        '#/artifacts/dashboard', '#/artifacts/dashboard/explainer', `#/artifacts/view/${enc(fix.other)}`, '#/artifacts/projects',
        '#/feedback/dashboard', '#/feedback/history', '#/settings/dashboard', '#/settings/dashboard/memory', `#/settings/project?project=${enc(fx.repo.mixed)}`,
        `#/learning/dashboard?project=${enc(fx.repo.mixed)}`, `#/memory/timeline?project=${enc(fx.repo.memoryOnly)}`,
      ];
      for (const hash of routes) {
        await page.evaluate((h) => { location.hash = h; }, hash);
        await ready(page);
        await scrollTo(page, 120);
        const shown = await page.evaluate(() => ({ h1: document.querySelector('#view h1')?.textContent ?? null, scroll: window.scrollY, text: document.getElementById('view')!.textContent!.length }));
        const was = await cursor(page);
        // In the scope the page is in too: a write that this screen shows, and one it does not.
        writeDue(hash.includes('project=') ? (hash.includes('memory-only') ? fx.repo.memoryOnly : fx.repo.mixed) : null);
        await adopted(page, was);
        await ready(page);
        await page.waitForTimeout(150);
        const after = await page.evaluate(() => ({
          h1: document.querySelector('#view h1')?.textContent ?? null, scroll: window.scrollY, rendered: document.documentElement.dataset.rendered,
          hash: location.hash, loaders: document.querySelectorAll('#view .loader').length, failed: document.querySelectorAll('#view [data-failed]').length,
        }));
        expect(after, hash).toMatchObject({ h1: shown.h1, scroll: shown.scroll, rendered: hash, hash, loaders: 0, failed: 0 });
      }
      expect(w.errors).toEqual([]);
      expect(w.outbound).toEqual([]);
      expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
      await w.ctx.close();
    }, 180000);

    describe('what the reader is in the middle of', () => {
      it('keeps the caret and the text in the search box through the redraw', async () => {
        const w = await open('#/learning/concepts', { height: HEIGHT });
        const { page } = w;
        await page.focus('#q');
        await page.keyboard.type('re');
        await page.keyboard.press('ArrowLeft');
        const at = await page.evaluate(() => { const i = document.getElementById('q') as HTMLInputElement; return [i.value, i.selectionStart, i.selectionEnd]; });
        expect(at).toEqual(['re', 1, 1]);
        const before = await reviewCount(page);
        const was = await cursor(page);
        writeDue();
        await page.waitForFunction((n) => Number(document.querySelector('#nav a[data-nav="review"] i')!.textContent) === n, before + 1, { timeout: 3000 });
        expect(await cursor(page)).not.toBe(was);
        expect(await page.evaluate(() => { const i = document.activeElement as HTMLInputElement; return [i.id, i.value, i.selectionStart, i.selectionEnd]; }))
          .toEqual(['q', 're', 1, 1]);
        // And typing goes on where the caret was.
        await page.keyboard.type('x');
        expect(await page.inputValue('#q')).toBe('rxe');
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 30000);

      it('does not redraw a Settings field being edited, and updates the row around it', async () => {
        const w = await open('#/settings/dashboard/pacing', { height: HEIGHT });
        const { page } = w;
        const field = '#set-max_questions_per_task';
        const source = () => page.textContent(`.set:has(${field}) .set__src`);
        expect(await source()).toContain('default');
        await page.focus(field);
        await page.fill(field, '7');
        // Held to see that it is the very element afterwards: the value, the focus and the node.
        await page.evaluate((f) => { (window as any).__field = document.querySelector(f); }, field);
        const typed = await page.evaluate((f) => { const i = document.querySelector(f) as HTMLInputElement; return [i.value, document.activeElement === i]; }, field);
        expect(typed).toEqual(['7', true]);

        // An unrelated write: the page reads again, and the field and the line beside it are as they were.
        const was = await cursor(page);
        writeDue();
        await adopted(page, was);
        await page.waitForTimeout(400);
        expect(await page.evaluate((f) => ({ value: (document.querySelector(f) as HTMLInputElement).value, focus: document.activeElement === document.querySelector(f), same: (window as any).__field === document.querySelector(f) }), field))
          .toEqual({ value: '7', focus: true, same: true });
        expect(await source(), 'the row says what it said until the save').toContain('default');

        // A change from the terminal to another setting lands around the field: that tab's count moves, this row does not.
        const tab = page.locator('.sw__tab', { hasText: 'Questions' });
        expect(await tab.locator('i').count()).toBe(0);
        const then = await cursor(page);
        configure({ cadence: 'end' });
        await adopted(page, then);
        await page.waitForFunction(() => /1/.test(document.querySelector('.sw__tab[data-focus="tab:questions"] i')?.textContent ?? ''), null, { timeout: 3000 });
        expect(await page.evaluate((f) => ({ value: (document.querySelector(f) as HTMLInputElement).value, focus: document.activeElement === document.querySelector(f), same: (window as any).__field === document.querySelector(f) }), field))
          .toEqual({ value: '7', focus: true, same: true });
        expect(await source(), 'still unsaved').toContain('default');

        // The save is the reader's: Enter, and the row says so.
        await page.keyboard.press('Enter');
        await page.waitForFunction((f) => /set by you/.test(document.querySelector(`.set:has(${f}) .set__src`)?.textContent ?? ''), field, { timeout: 5000 });
        expect(await page.inputValue(field)).toBe('7');
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);

      it('stays on the tab the reader chose, and shows the new file on it, when the page is drawn again after a tab was pressed', async () => {
        const w = await open('#/settings/dashboard', { height: HEIGHT });
        const { page } = w;
        // A tab is drawn from what the page already holds: no request, and nothing is read for the screen afterwards.
        await page.click('.sw__tab[data-focus="tab:pacing"]');
        await page.waitForSelector('#set-max_questions_per_task');
        const was = await cursor(page);
        configure({ max_questions_per_task: 5 });
        await adopted(page, was);
        await page.waitForFunction(() => /set by you/.test(document.querySelector('.set:has(#set-max_questions_per_task) .set__src')?.textContent ?? ''), null, { timeout: 3000 });
        expect(await page.getAttribute('.sw__tab[data-focus="tab:pacing"]', 'aria-current')).toBe('page');
        expect(await page.getAttribute('.sw__tab[data-focus="tab:questions"]', 'aria-current')).toBeNull();
        expect(await page.inputValue('#set-max_questions_per_task')).toBe('5');
        expect(await page.evaluate(() => location.hash)).toBe('#/settings/dashboard/pacing');
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 30000);

      it('does not redraw a Settings choice that is open, nor the list that belongs to it', async () => {
        const w = await open('#/settings/dashboard', { height: 700 });
        const { page } = w;
        await page.click('#set-cadence-combo');
        expect(await page.evaluate(() => !document.getElementById('sel-menu')!.hidden)).toBe(true);
        await page.evaluate(() => { (window as any).__combo = document.getElementById('set-cadence-combo'); });
        const was = await cursor(page);
        configure({ difficulty: 'hard' });
        await adopted(page, was);
        await page.waitForTimeout(400);
        // The page was drawn again from the new file; the choice the reader has open is the same button, still open.
        expect(await page.evaluate(() => ({ same: (window as any).__combo === document.getElementById('set-cadence-combo'), open: !document.getElementById('sel-menu')!.hidden }))).toEqual({ same: true, open: true });
        await page.keyboard.press('Escape');
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 30000);

      it('leaves the framed page loaded, and the correction open, when something unrelated is written', async () => {
        const w = await open(`#/artifacts/view/${enc(fix.other)}`, { height: 700 });
        const { page } = w;
        await page.click('#fix-open');
        await page.click('#fix-opts [data-pick="A queue"]');
        await page.waitForSelector('#fix-msg:has-text("Still incorrect")');
        const armed = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; });
        expect(await armed()).toBe(true);
        await page.evaluate(() => {
          const w = window as any;
          w.__frame = document.getElementById('art-frame');
          w.__bar = document.getElementById('fixbar');
          w.__loads = 0;
          w.__frame.addEventListener('load', () => { w.__loads++; });
        });
        const was = await cursor(page);
        writeDue();
        await adopted(page, was);
        await page.waitForTimeout(500);
        expect(await page.evaluate(() => {
          const w = window as any;
          return {
            frame: w.__frame === document.getElementById('art-frame') && w.__frame.isConnected,
            loads: w.__loads,
            bar: w.__bar === document.getElementById('fixbar'),
            barClass: document.getElementById('fixbar')!.className,
            dialog: (document.getElementById('fix') as HTMLDialogElement).open,
            wrong: document.querySelector('#fix-opts [data-pick="A queue"]')?.getAttribute('data-wrong'),
          };
        })).toEqual({ frame: true, loads: 0, bar: true, barClass: 'fixbar is-open', dialog: true, wrong: '1' });
        // The reader may still leave only by saying so, and the pick in front of them still works.
        expect(await armed()).toBe(true);
        await page.click('#fix-opts [data-pick="A lock"]');
        await page.waitForSelector('#fix-msg:has-text("Corrected.")');
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);

      it('puts off the rows of the tab the reader is using, brings up the strip and the heading, and catches up when they let go', async () => {
        const w = await open('#/settings/dashboard/pacing', { height: HEIGHT });
        const { page } = w;
        const field = '#set-max_questions_per_task';
        const other = '#set-min_minutes_between_quizzes';
        const source = (f: string) => page.textContent(`.set:has(${f}) .set__src`);
        await page.focus(field);
        const was = await cursor(page);
        // `eklavya config set min_minutes_between_quizzes 45`, from a terminal, while the reader has a field.
        configure({ min_minutes_between_quizzes: 45 });
        await adopted(page, was);
        // The tab's count and the heading's count are brought up around the field; the rows wait.
        await page.waitForFunction(() => /1 set here/.test(document.querySelector('.sw__pane .counts')?.textContent ?? ''), null, { timeout: 3000 });
        expect(await page.locator('.sw__tab[data-focus="tab:pacing"] i').textContent()).toBe('1');
        expect(await source(other), 'the row is drawn when the reader lets go of the field').toContain('default');
        expect(await page.evaluate((f) => document.activeElement === document.querySelector(f), field)).toBe(true);
        // They let go (a click on the heading, say; a Tab would land on the next field, and that is in use too): what
        // was put off is drawn, with nothing else asked of the page.
        await page.click('.sw__pane h1');
        await page.waitForFunction((f) => /set by you/.test(document.querySelector(`.set:has(${f}) .set__src`)?.textContent ?? ''), other, { timeout: 3000 });
        expect(await page.inputValue(other)).toBe('45');
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);

      it('redraws only the tab strip and the bar when the page was corrected elsewhere, and not the frame', async () => {
        // The question is answered from the terminal while the explainer is open.
        const attempt = fix.missed();
        const art = await import('../dist/artifacts.js').then((m) => m.createArtifact({ title: 'Locks again, explained', kind: 'explainer', concept: 'csrf', attempt }));
        const w = await open(`#/artifacts/view/${enc(art.id)}`, { height: 700 });
        const { page } = w;
        expect(await page.textContent('#fixbar')).toContain('You missed this one');
        expect(await page.locator('#view [role="tab"][aria-selected="true"] .tab__dot.is-open').count()).toBe(1);
        await page.evaluate(() => {
          const w = window as any;
          w.__frame = document.getElementById('art-frame');
          w.__tabs = document.querySelector('#view .tabs');
          w.__loads = 0;
          w.__frame.addEventListener('load', () => { w.__loads++; });
        });
        const r = await probeTransition(page, async () => {
          recordRetry(db, attempt, 'A lock', new Date());
          await page.waitForFunction(() => /Corrected on try/.test(document.getElementById('fixbar')?.textContent ?? ''), null, { timeout: 4000 });
        }, { keep: '#art-frame' });
        expect(r).toMatchObject({ keptSelector: true, sawLoader: false, requests: expect.arrayContaining(['/api/state', '/api/projects']) });
        expect(await page.evaluate(() => ({
          frame: (window as any).__frame === document.getElementById('art-frame'),
          loads: (window as any).__loads,
          tabs: (window as any).__tabs === document.querySelector('#view .tabs'),
        }))).toEqual({ frame: true, loads: 0, tabs: true });
        expect(await page.locator('#view [role="tab"][aria-selected="true"] .tab__dot.is-done').count()).toBe(1);
        expect(await page.evaluate(() => document.getElementById('fixbar')!.className)).toContain('is-done');
        // The prompt that guarded an open correction is down: nothing is open any more.
        expect(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); dispatchEvent(e); return e.defaultPrevented; })).toBe(false);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);

      it('tells the framed page the ground when it changes, and does not load it again to do so', async () => {
        const w = await open(`#/artifacts/view/${enc(fix.other)}`, { height: 700, ground: 'ink' });
        const { page } = w;
        const framed = () => page.frames().find((f) => f.url().includes('?embed'))!;
        const mode = () => framed().evaluate(() => document.documentElement.getAttribute('data-mode'));
        expect(await mode(), 'the page it frames was told the ground when it loaded').toBe('ink');
        await page.evaluate(() => {
          const w = window as any;
          w.__frame = document.getElementById('art-frame');
          w.__loads = 0;
          w.__frame.addEventListener('load', () => { w.__loads++; });
        });
        await page.click('[data-ground="paper"]');
        await page.waitForFunction(() => document.documentElement.getAttribute('data-mode') === 'paper');
        await expect.poll(mode, { timeout: 3000 }).toBe('paper');
        expect(await page.evaluate(() => ({ same: (window as any).__frame === document.getElementById('art-frame'), loads: (window as any).__loads }))).toEqual({ same: true, loads: 0 });
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 30000);

      it('does not move the scroll, closes no fold, and keeps an open row open', async () => {
        const w = await open('#/memory/timeline', { height: HEIGHT });
        const { page } = w;
        await page.waitForSelector('#mem-rows [data-entry]');
        // "How this works" and a row of the timeline, both opened by the reader.
        await page.click('#view details.about > summary');
        await page.locator('#mem-rows [data-entry] > summary').first().click();
        const keyed = await page.$eval('#mem-rows [data-entry][open]', (d) => (d as HTMLElement).dataset.entry!);
        const at = await scrollTo(page, 150);
        expect(at, 'the page is tall enough to have a place to lose').toBeGreaterThan(0);
        const rows = await page.locator('#mem-rows [data-entry]').count();
        const r = await probeTransition(page, async () => {
          insertEntry(db, {
            project: fx.repo.mixed, sessionId: 's-live-entry', type: 'discovery', title: 'The live stream is one cursor', tags: ['auth'],
            eventIds: [], occurredAt: new Date().toISOString(), narrative: 'The page reads the payload when the cursor moves.',
            facts: [], files: [], generator: 'local-extract-v1', confidence: 0.7,
          });
          await page.waitForFunction(() => document.getElementById('mem-rows')!.textContent!.includes('The live stream is one cursor'), null, { timeout: 4000 });
        });
        expect(r.requests).toEqual(expect.arrayContaining(['/api/state', '/api/projects']));
        expect(r.sawLoader, 'a loader replaced what the reader was reading').toBe(false);
        expect(r.scrollAfter).toBe(at);
        expect(await page.locator('#mem-rows [data-entry]').count()).toBe(rows + 1);
        expect(await page.$eval('#view details.about', (d) => (d as HTMLDetailsElement).open), 'the fold the reader opened is still open').toBe(true);
        expect(await page.$eval(`#mem-rows [data-entry="${keyed}"]`, (d) => (d as HTMLDetailsElement).open), 'the row the reader opened is still open').toBe(true);
        expect(await page.locator('#mem-rows [data-entry][open]').count()).toBe(1);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);

      it('keeps the place on a long list of rows that grows', async () => {
        const w = await open('#/learning/concepts', { height: HEIGHT });
        const { page } = w;
        const at = await scrollTo(page, 300);
        expect(at).toBe(300);
        const r = await probeTransition(page, async () => {
          const was = await cursor(page);
          writeDue();
          await adopted(page, was);
        });
        expect(r).toMatchObject({ scrollBefore: 300, scrollAfter: 300, headKept: false });
        expect(await page.evaluate(() => window.scrollY)).toBe(300);
        await w.ctx.close();
      }, 30000);

      it('puts the heatmap back where the reader paged it to', async () => {
        const w = await open('#/learning/dashboard', { width: 640, height: 900 });
        const { page } = w;
        await page.waitForSelector('#heat-prev:not([hidden])');
        await page.click('#heat-prev');
        const paged = await page.evaluate(() => (0, eval)('HEAT_OFF'));
        expect(paged).toBeGreaterThan(0);
        const was = await cursor(page);
        writeDue();
        await adopted(page, was);
        await page.waitForTimeout(300);
        expect(await page.evaluate(() => (0, eval)('HEAT_OFF'))).toBe(paged);
        await w.ctx.close();
      }, 30000);
    });

    describe('what a write the page made itself does', () => {
      it('is drawn from the response, and the event that follows replaces nothing the reader is on', async () => {
        const w = await open('#/settings/dashboard/pacing', { height: HEIGHT });
        const { page } = w;
        const field = '#set-max_questions_per_task';
        try {
          await page.focus(field);
          await page.fill(field, '9');
          const asked = watch(page);
          const was = await cursor(page);
          await page.keyboard.press('Enter');
          await page.waitForSelector('[data-msg="max_questions_per_task"].here:has-text("saved")');
          // The server saw the write and told the page; the page read the payload once.
          await adopted(page, was);
          await page.waitForTimeout(500);
          expect(asked.filter((a) => a === '/api/state')).toHaveLength(1);
          expect(await page.inputValue(field)).toBe('9');
          expect(await page.textContent(`.set:has(${field}) .set__src`)).toContain('set by you');
          expect(await page.evaluate((f) => document.activeElement === document.querySelector(f), field)).toBe(true);
          expect(w.errors).toEqual([]);
        } finally {
          await page.click('[data-unset="max_questions_per_task"]').catch(() => {});
          await w.ctx.close();
        }
      }, 60000);

      it('shows the feedback badge, in place, when an item is ready', async () => {
        configure({ feedback: { enabled: true } });
        const w = await open('#/learning/dashboard', { height: HEIGHT });
        const { page } = w;
        expect(await page.isHidden('#wf-badge')).toBe(true);
        const was = await cursor(page);
        insertFeedback(db, {
          session_id: 's-live-fb', project: fx.repo.mixed, event_id: null, prompt: 'make it faster', model: 'sonnet',
          review: { worked: 'A goal.', gaps: [] } as never, better: 'Make it faster than [the baseline].', tips: ['Say how fast.'],
        });
        await adopted(page, was);
        await page.waitForFunction(() => !document.getElementById('wf-badge')!.hidden);
        expect(await page.textContent('#wf-badge')).toBe('1');
        expect(await page.getAttribute('#wf-caret', 'aria-label')).toBe('Switch workflow, 1 feedback unread');
        await w.ctx.close();
      }, 30000);
    });

    describe('a burst', () => {
      it('is one more read when it arrives while a read is out, not one for each change', async () => {
        const w = await open('#/learning/review', { height: HEIGHT });
        const { page } = w;
        await page.evaluate(() => {
          const w = window as any;
          w.__adopts = [];
          const real = adoptState;
          w.adoptState = (s: any, inv: unknown) => { w.__adopts.push(s.cursor); return real(s, inv); };
        });
        // The first answer reaches the page late: it is read at once and held, so what it carries is old by then.
        let release = () => {};
        const gate = new Promise<void>((r) => { release = r; });
        let held = false;
        const asked = watch(page);
        await page.route('**/api/state', async (route) => {
          if (held) return route.continue();
          held = true;
          const reply = await route.fetch();
          await gate;
          await route.fulfill({ response: reply });
        });
        const was = await cursor(page);
        writeDue();
        await page.waitForFunction(() => LIVE.busy, null, { timeout: 3000 });
        // Three more changes while that read is out.
        for (let i = 0; i < 3; i++) {
          const heard = await page.evaluate(() => LIVE.heard);
          writeDue();
          await page.waitForFunction((h) => LIVE.heard !== h, heard, { timeout: 3000 });
        }
        const newest = await page.evaluate(() => LIVE.heard);
        release();
        await page.waitForFunction((c) => S.cursor === c, newest, { timeout: 5000 });
        await page.waitForTimeout(500);
        await page.unroute('**/api/state');
        // The held read, then one for everything that happened since: two, not four.
        expect(asked.filter((a) => a === '/api/state')).toHaveLength(2);
        expect(asked.filter((a) => a === '/api/projects')).toHaveLength(2);
        const adopts = await page.evaluate(() => (window as any).__adopts as string[]);
        expect(adopts).toHaveLength(2);
        expect(adopts[0]).not.toBe(was);
        expect(adopts[1]).toBe(newest);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);
    });

    describe('a hidden tab', () => {
      /** Headless Chromium does not hide a tab another one is in front of, so the page is told what a browser tells it. */
      const visibility = (page: Page, state: 'hidden' | 'visible') => page.evaluate((v) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);

      it('makes no request at all while it is hidden, and catches up in one read when it is back', async () => {
        const w = await open('#/learning/review', { height: HEIGHT });
        const { page } = w;
        const closed: string[] = [];
        page.on('requestfailed', (r) => { if (isStream(r.url())) closed.push(r.failure()?.errorText ?? ''); });
        await visibility(page, 'hidden');
        const asked: string[] = [];
        page.on('request', (r) => asked.push(new URL(r.url()).pathname));
        const before = await reviewCount(page);
        const was = await cursor(page);
        // Work lands for as long as the floor and the debounce could take to say so, twice over.
        writeDue();
        await page.waitForTimeout(2500);
        writeDue();
        await page.waitForTimeout(2500);
        expect(asked, 'a hidden tab asks for nothing').toEqual([]);
        expect(await page.evaluate(() => LIVE.es)).toBeNull();
        expect(closed, 'the stream was closed, not left open').toHaveLength(1);
        expect(await cursor(page)).toBe(was);
        expect(await reviewCount(page)).toBe(before);

        // Back in view: one stream, one read of each, and the sidebar is right.
        const reads: string[] = [];
        page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) reads.push(u.pathname); });
        await visibility(page, 'visible');
        await page.waitForFunction((n) => Number(document.querySelector('#nav a[data-nav="review"] i')!.textContent) === n, before + 2, { timeout: 3000 });
        await page.waitForTimeout(400);
        expect(reads.filter((p) => p === '/api/events')).toHaveLength(1);
        expect(reads.filter((p) => p === '/api/state')).toHaveLength(1);
        expect(reads.filter((p) => p === '/api/projects')).toHaveLength(1);
        expect(await page.evaluate(() => LIVE.es?.readyState)).toBe(1);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }, 60000);

      it('does not open a stream for a tab that loads hidden, and opens it when it is shown', async () => {
        const w = await open('#/learning/review', {
          height: HEIGHT,
          init: `Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => window.__vis ?? 'hidden' });`,
        });
        const { page } = w;
        expect(await page.evaluate(() => LIVE.es)).toBeNull();
        const streams = watchStream(page);
        await page.evaluate(() => { (window as any).__vis = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
        await page.waitForFunction(() => LIVE.es?.readyState === 1);
        expect(streams).toHaveLength(1);
        await w.ctx.close();
      }, 30000);
    });

    describe('the stream', () => {
      /** A raw connection that holds one of the server's streams open until it is destroyed, the way a `curl` would. */
      const holdStream = (url: string) => new Promise<http.ClientRequest>((resolve, reject) => {
        const req = http.get(`${url}/api/events`, (res) => { res.resume(); resolve(req); });
        req.on('error', reject);
      });

      it('is opened again, after a pause, when the server refuses it, and the pause grows and resets', async () => {
        const srv = await startDashboard(db as any, { port: 0, live: { maxStreams: 1 } });
        const taken = await holdStream(srv.url);
        const w = await open('#/learning/review', { height: HEIGHT, base: srv.url });
        const { page } = w;
        try {
          // The 33rd of 32 in miniature: an answer that is not a stream, which the browser does not retry.
          await page.waitForFunction(() => LIVE.es === null && LIVE.delay === 10000, null, { timeout: 5000 });
          const reads = watch(page);
          const streams = watchStream(page);
          taken.destroy();
          // It is the page that asks again, once its first pause is up (five seconds) and the cap has room.
          await page.waitForFunction(() => LIVE.es?.readyState === 1, null, { timeout: 9000 });
          expect(streams).toHaveLength(1);
          expect(await page.evaluate(() => LIVE.delay), 'the pause starts again from the minimum once a stream opens').toBe(5000);
          // And it is live: work written now shows.
          const before = await reviewCount(page);
          writeDue();
          await page.waitForFunction((n) => Number(document.querySelector('#nav a[data-nav="review"] i')!.textContent) === n, before + 1, { timeout: 3000 });
          expect(reads.filter((a) => a === '/api/state')).toHaveLength(1);
          // The browser logged the refusal, and nothing else was wrong.
          expect(w.errors).toEqual([expect.stringMatching(/503/)]);
        } finally {
          taken.destroy();
          await w.ctx.close();
          await srv.close();
        }
      }, 60000);

      it('waits longer each time it is refused, never longer than a minute, and not at all while hidden', async () => {
        const w = await open('#/learning/review', { height: HEIGHT });
        const { page } = w;
        const delays = await page.evaluate(() => {
          liveClose();
          const out: number[] = [];
          LIVE.delay = 5000;
          for (let i = 0; i < 6; i++) { out.push(LIVE.delay); liveReopen(); }
          liveClose();
          return out;
        });
        expect(delays).toEqual([5000, 10000, 20000, 40000, 60000, 60000]);
        // Hidden, a refused stream is not asked for again (and nothing is waiting to).
        await page.evaluate(() => {
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
          LIVE.delay = 5000;
          liveReopen();
        });
        expect(await page.evaluate(() => LIVE.delay), 'no pause was started').toBe(5000);
        await w.ctx.close();
      }, 30000);

      it('is picked up again by the browser when the server restarts on the same port, and the page keeps what it has meanwhile', async () => {
        const first = await startDashboard(db as any, { port: 0 });
        const port = Number(new URL(first.url).port);
        let second: Awaited<ReturnType<typeof startDashboard>> | null = null;
        const w = await open('#/learning/review', { height: HEIGHT, base: first.url });
        const { page } = w;
        try {
          await page.waitForFunction(() => LIVE.es?.readyState === 1);
          const shown = () => page.evaluate(() => ({ view: document.getElementById('view')!.innerHTML, nav: document.getElementById('nav')!.innerHTML, text: document.body.innerText }));
          const before = await shown();
          await first.close();
          // The server is gone: the browser keeps asking by itself, and the page says nothing and changes nothing.
          await page.waitForFunction(() => LIVE.es?.readyState === 0, null, { timeout: 5000 });
          await page.waitForTimeout(1500);
          const gone = await shown();
          expect(gone.view).toBe(before.view);
          expect(gone.nav).toBe(before.nav);
          expect(gone.text).not.toMatch(/reconnect|offline|live|stale|refresh/i);
          expect(await page.locator('#stale').count()).toBe(0);

          second = await startDashboard(db as any, { port });
          await page.waitForFunction(() => LIVE.es?.readyState === 1, null, { timeout: 15000 });
          // Work that landed while it was away shows the moment it is back, and so does what lands after.
          const count = await reviewCount(page);
          writeDue();
          await page.waitForFunction((n) => Number(document.querySelector('#nav a[data-nav="review"] i')!.textContent) === n, count + 1, { timeout: 4000 });
          expect(await page.evaluate(() => performance.getEntriesByType('navigation').length)).toBe(1);
        } finally {
          await w.ctx.close();
          await second?.close();
        }
      }, 60000);

      it('catches up on what landed while the server was away, in one read, when it comes back', async () => {
        const first = await startDashboard(db as any, { port: 0 });
        const port = Number(new URL(first.url).port);
        let second: Awaited<ReturnType<typeof startDashboard>> | null = null;
        const w = await open('#/learning/review', { height: HEIGHT, base: first.url });
        const { page } = w;
        try {
          await page.waitForFunction(() => LIVE.es?.readyState === 1);
          const count = await reviewCount(page);
          await first.close();
          await page.waitForFunction(() => LIVE.es?.readyState === 0, null, { timeout: 5000 });
          writeDue();
          writeDue();
          const reads = watch(page);
          second = await startDashboard(db as any, { port });
          await page.waitForFunction((n) => Number(document.querySelector('#nav a[data-nav="review"] i')!.textContent) === n, count + 2, { timeout: 15000 });
          expect(reads.filter((a) => a === '/api/state')).toHaveLength(1);
        } finally {
          await w.ctx.close();
          await second?.close();
        }
      }, 60000);
    });
  });
});
