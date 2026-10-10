// Split by feature so Vitest's file sharding can divide the browser work.
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { acknowledgeFeedback, insertFeedback } from '../src/feedback.js';
import { OPTS, PAGE_HEAD, base, db, enc, fix, footerBounces, fx, notAPage, open, pageProblem, pickOption, pickProject, probeTable, probeTransition, projValue, ready, screen, type ProbeReport, type Want } from './dashboard-browser-helpers.js';
declare function render(): void;

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('legacy links land on the intended screen', () => {
    const cases = (): [string, string, { wf: string; active: string | null; h1?: RegExp }][] => {
      const e = fx.entries.mixed;
      return [
        ['', '#/learning/dashboard', { wf: 'Learning', active: 'dashboard', h1: /getting better/ }],
        ['#/', '#/learning/dashboard', { wf: 'Learning', active: 'dashboard' }],
        ['#/overview', '#/learning/dashboard', { wf: 'Learning', active: 'dashboard' }],
        ['#/concepts', '#/learning/concepts', { wf: 'Learning', active: 'concepts', h1: /^Concepts$/ }],
        ['#/concepts/mastered', '#/learning/concepts/mastered', { wf: 'Learning', active: 'concepts' }],
        ['#/concept/csrf', '#/learning/concept/csrf', { wf: 'Learning', active: 'concepts', h1: /CSRF|Cross/i }],
        ['#/review', '#/learning/review', { wf: 'Learning', active: 'review', h1: /Review queue/ }],
        ['#/review/skipped', '#/learning/review/skipped', { wf: 'Learning', active: 'review' }],
        ['#/sessions', '#/learning/sessions', { wf: 'Learning', active: 'sessions', h1: /^Sessions$/ }],
        ['#/session/s-mixed', '#/learning/session/s-mixed', { wf: 'Learning', active: 'sessions', h1: /^mixed$/ }],
        // A memory-only session keeps what the old link showed.
        ['#/session/s-mem', '#/learning/session/s-mem', { wf: 'Learning', active: 'sessions', h1: /^memory-only$/ }],
        ['#/projects', '#/learning/projects', { wf: 'Learning', active: 'projects', h1: /^Projects$/ }],
        ['#/domains', '#/learning/domains', { wf: 'Learning', active: 'domains', h1: /^Domains$/ }],
        ['#/domain/web-auth', '#/learning/domain/web-auth', { wf: 'Learning', active: 'domains', h1: /^web-auth$/ }],
        ['#/memory', '#/memory/timeline', { wf: 'Memory', active: 'timeline', h1: /^Timeline$/ }],
        ['#/memory/decision', '#/memory/timeline/decision', { wf: 'Memory', active: 'timeline' }],
        [`#/entry/${e}`, `#/memory/entry/${e}`, { wf: 'Memory', active: 'timeline', h1: /SameSite=Lax/ }],
        ['#/reuse', '#/memory/reuse', { wf: 'Memory', active: 'reuse', h1: /Context reuse/ }],
        ['#/health', '#/memory/health', { wf: 'Memory', active: 'health', h1: /^Health$/ }],
        ['#/artifacts', '#/artifacts/dashboard', { wf: 'Artifacts', active: 'dashboard', h1: /^Artifacts$/ }],
        ['#/artifacts/projects', '#/artifacts/projects', { wf: 'Artifacts', active: 'projects', h1: /^Projects$/ }],
        ['#/feedback', '#/feedback/dashboard', { wf: 'Feedback', active: 'dashboard', h1: /^Feedback$/ }],
        ['#/feedback/history', '#/feedback/history', { wf: 'Feedback', active: 'history', h1: /^History$/ }],
        ['#/settings', '#/settings/dashboard', { wf: 'Settings', active: 'dashboard', h1: /^User settings$/ }],
        ['#/settings/user', '#/settings/user', { wf: 'Settings', active: 'dashboard', h1: /^User settings$/ }],
        ['#/settings/dashboard/memory', '#/settings/dashboard/memory', { wf: 'Settings', active: 'dashboard', h1: /^User settings$/ }],
        ['#/settings/project', '#/settings/project', { wf: 'Settings', active: 'dashboard', h1: /^Project settings$/ }],
      ];
    };

    it('redirects every legacy form to its canonical route and renders it', async () => {
      const w = await open('#/learning/dashboard');
      for (const [legacy, canonical, want] of cases()) {
        await w.page.goto(base + '/' + legacy);
        await ready(w.page);
        const s = await screen(w.page);
        expect(s.hash, legacy).toBe(canonical);
        expect(s.wf, legacy).toBe(want.wf);
        expect(s.active, legacy).toBe(want.active);
        if (want.h1) expect(s.h1, legacy).toMatch(want.h1);
      }
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('keeps the filter a legacy link carried', async () => {
      const w = await open('#/concepts/mastered');
      expect(await w.page.getAttribute('[data-state="mastered"]', 'aria-pressed')).toBe('true');
      await w.page.goto(base + '/#/review/skipped'); await ready(w.page);
      expect(await w.page.getAttribute('[data-tab="skipped"]', 'aria-pressed')).toBe('true');
      await w.page.goto(base + '/#/memory/decision'); await ready(w.page);
      expect(await w.page.inputValue('#mtype')).toBe('decision');
      // The timeline really is filtered, not just the select.
      const rows = await w.page.$$eval('#mem-rows [data-entry]', (r) => r.length);
      expect(rows).toBe(1);
      await w.ctx.close();
    });

    it('draws the timeline one line per entry, sessions folded, detail on click', async () => {
      const w = await open('#/learning/dashboard');
      const at = (daysAgo: number, h: number) => {
        const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, 0, 0, 0); return d.toISOString();
      };
      const row = (id: number, kind: string, title: string, occurred: string, session: string | null) => ({
        id, kind, title, type: 'discovery', occurred_at: occurred, session_id: session, project: fx.repo.mixed,
        snippet: `${title} snippet`, narrative_length: 99, event_count: 2, tags: [], deleted_at: null, superseded_by: null,
      });
      await w.page.route('**/api/memory?*', (route) => route.fulfill({ json: { total: 4, page: 1, pages: 1, per: 25, rows: [
        row(1, 'session_summary', 'Session: Reviewed the docs', at(0, 12), 's1'),
        row(2, 'observation', 'Found a stale default', at(0, 11), 's1'),
        row(3, 'observation', 'Fixed the recall cap', at(0, 10), 's1'),
        row(4, 'observation', 'An older standalone entry', at(5, 9), 's2'),
      ] } }));
      await w.page.evaluate(() => { location.hash = '#/memory/timeline'; });
      await w.page.waitForSelector('#mem-rows .tl');
      // Two days, and the empty stretch between them said out loud.
      expect(await w.page.$$eval('#mem-rows .tl-day h2', (h) => h.length)).toBe(2);
      expect(await w.page.textContent('#mem-rows > .tl > .tl-gap')).toMatch(/^Nothing from /);
      // The session's observations fold under its summary, closed.
      const session = w.page.locator('#mem-rows .tl-session');
      expect(await session.locator('[data-entry]').count()).toBe(2);
      expect(await session.getAttribute('open')).toBeNull();
      expect(await session.locator(':scope > summary .tl-type').textContent()).toContain('2 observations');
      // Detail is one click away, and opening it leads to the full entry.
      const lone = w.page.locator('#mem-rows [data-entry="4"]');
      await lone.locator('summary').click();
      expect(await lone.getAttribute('open')).not.toBeNull();
      await lone.locator('.link').click();
      await w.page.waitForFunction(() => location.hash === '#/memory/entry/4');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('folds secondary detail, draws a hidden chart on open and remembers it', async () => {
      const w = await open('#/learning/concept/csrf');
      // The page leads with its answer: explanation and secondary cards are closed.
      expect(await w.page.getAttribute('#view details.about', 'open')).toBeNull();
      const heat = w.page.locator('details[data-fold="concept:grades"]');
      expect(await heat.getAttribute('open')).toBeNull();
      // A chart inside a closed fold has no width to measure, so it waits.
      expect(await w.page.$eval('#c-grades', (s) => s.childElementCount)).toBe(0);
      await heat.locator('summary').focus();
      await w.page.keyboard.press('Enter');
      await w.page.waitForFunction(() => document.getElementById('c-grades')!.childElementCount > 0);
      // Opened once, it stays open across a reload and a re-render.
      await w.page.reload(); await ready(w.page);
      expect(await heat.getAttribute('open')).not.toBeNull();
      expect(await w.page.$eval('#c-grades', (s) => s.childElementCount)).toBeGreaterThan(0);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('carries the query and decodes encoded identifiers', async () => {
      const id = fx.repo.mixed;
      const w = await open(`#/concepts/due?project=${enc(id)}`);
      expect((await screen(w.page)).hash).toBe(`#/learning/concepts/due?project=${enc(id)}`);
      expect(await projValue(w.page)).toBe(id);
      await w.page.goto(base + '/#/domain/web%2Dauth'); await ready(w.page);
      expect((await screen(w.page)).h1).toBe('web-auth');
      await w.page.goto(base + '/#/learning/session/' + enc('s-mixed')); await ready(w.page);
      expect((await screen(w.page)).h1).toBe('mixed');
      await w.ctx.close();
    });

    it('turns the remembered project into the canonical URL once', async () => {
      const w = await open('#/learning/dashboard', { init: `localStorage.setItem('eklavya-dash-project', ${JSON.stringify(fx.repo.mixed)})` });
      await w.page.goto(base + '/#/overview'); await ready(w.page);
      expect((await screen(w.page)).hash).toBe(`#/learning/dashboard?project=${enc(fx.repo.mixed)}`);
      // A canonical link without a project means all projects.
      await w.page.goto(base + '/#/learning/dashboard'); await ready(w.page);
      expect(await projValue(w.page)).toBe('');
      await w.ctx.close();
    });

    it('rewrites a legacy link in place, with no extra history entry', async () => {
      const w = await open('#/learning/domains');
      const before = await w.page.evaluate(() => history.length);
      await w.page.evaluate(() => { location.hash = '#/reuse'; });
      await w.page.waitForFunction(() => location.hash === '#/memory/reuse');
      expect(await w.page.evaluate(() => history.length)).toBe(before + 1);
      await w.page.goBack(); await ready(w.page);
      expect((await screen(w.page)).hash).toBe('#/learning/domains');
      await w.ctx.close();
    });

    it('says so for an unknown route or a malformed parameter, without throwing', async () => {
      const w = await open('#/nowhere');
      expect((await screen(w.page)).h1).toBe('No page here');
      await w.page.goto(base + '/#/memory/timeline/%E0%A4%A'); await ready(w.page);
      expect((await screen(w.page)).h1).toBe('This link is malformed');
      await w.page.goto(base + '/#/learning/bogus'); await ready(w.page);
      expect((await screen(w.page)).h1).toBe('No page here');
      // Names every object inherits must not pass for a workflow, a page or a legacy route.
      for (const h of ['#/constructor', '#/toString/dashboard', '#/learning/constructor', '#/learning/__proto__']) {
        await w.page.goto(base + '/' + h); await ready(w.page);
        expect((await screen(w.page)).h1, h).toBe('No page here');
      }
      await w.page.goto(base + '/#/learning/concept/no-such-slug'); await ready(w.page);
      expect(await w.page.textContent('#view')).toMatch(/No concept called/);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });
  });

  describe('the workflow control', () => {
    it('opens the active Dashboard from the name, and switches from the caret', async () => {
      const w = await open('#/learning/concepts');
      await w.page.click('#wf-main');
      await w.page.waitForFunction(() => location.hash === '#/learning/dashboard');

      await w.page.click('#wf-caret');
      expect(await w.page.getAttribute('#wf-caret', 'aria-expanded')).toBe('true');
      expect(await w.page.isVisible('#wf-menu')).toBe(true);
      expect(await w.page.getAttribute('[data-wf="learning"]', 'aria-checked')).toBe('true');
      expect(await w.page.getAttribute('[data-wf="memory"]', 'aria-checked')).toBe('false');

      await w.page.click('[data-wf="memory"]');
      await ready(w.page);
      const s = await screen(w.page);
      expect(s).toMatchObject({ wf: 'Memory', active: 'dashboard' });
      expect(s.items).toEqual(['dashboard', 'timeline', 'sessions', 'projects', 'reuse', 'health']);
      expect(s.crumb[0]).toBe('Memory');
      expect(await w.page.isHidden('#wf-menu')).toBe(true);
      // The wordmark now goes to this workflow's Dashboard.
      expect(await w.page.getAttribute('#brand', 'href')).toBe('#/memory/dashboard');
      // A switch is a navigation: Back returns to Learning.
      await w.page.goBack(); await ready(w.page);
      expect(await screen(w.page)).toMatchObject({ wf: 'Learning', active: 'dashboard' });
      await w.ctx.close();
    });

    it('works from the keyboard, and Escape and outside clicks close it', async () => {
      const w = await open('#/learning/dashboard');
      await w.page.focus('#wf-caret');
      await w.page.keyboard.press('Enter');
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('data-wf'))).toBe('learning');
      await w.page.keyboard.press('Escape');
      expect(await w.page.isHidden('#wf-menu')).toBe(true);
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('wf-caret');

      await w.page.keyboard.press('ArrowDown');
      await w.page.keyboard.press('ArrowDown');
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('data-wf'))).toBe('memory');
      await w.page.keyboard.press('Enter');
      await w.page.waitForFunction(() => location.hash === '#/memory/dashboard');
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('wf-caret');

      await w.page.click('#wf-caret');
      await w.page.mouse.click(900, 600);
      expect(await w.page.isHidden('#wf-menu')).toBe(true);
      await w.ctx.close();
    });

    it('keeps the picker inside the viewport on a short window and on a phone', async () => {
      for (const [width, height] of [[1280, 320], [390, 844], [390, 420]]) {
        const w = await open('#/learning/dashboard', { width, height });
        if (width < 900) { await w.page.click('#menu'); await w.page.waitForTimeout(250); }
        await w.page.click('#wf-caret');
        const box = (await w.page.locator('#wf-menu').boundingBox())!;
        expect(box.x, `${width}x${height}`).toBeGreaterThanOrEqual(0);
        expect(box.y, `${width}x${height}`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${width}x${height}`).toBeLessThanOrEqual(width);
        expect(box.y + box.height, `${width}x${height}`).toBeLessThanOrEqual(height);
        await w.ctx.close();
      }
      // Three browser contexts in a row: ~3.5s alone, past vitest's 5s default
      // under the full suite's load. The bounds are what this test checks.
    }, 20000);
  });

  describe('the URL is the authority', () => {
    it('rebuilds a detail page and its highlight on load, refresh and Back/Forward', async () => {
      const e = fx.entries.memoryOnly;
      const w = await open(`#/memory/entry/${e}`);
      expect(await screen(w.page)).toMatchObject({ wf: 'Memory', active: 'timeline' });
      await w.page.reload(); await ready(w.page);
      expect(await screen(w.page)).toMatchObject({ wf: 'Memory', active: 'timeline' });

      // A session opened from Memory keeps Memory's navigation.
      await w.page.click('text=that session');
      await w.page.waitForFunction(() => location.hash.startsWith('#/memory/session/'));
      await ready(w.page);
      expect(await screen(w.page)).toMatchObject({ wf: 'Memory', active: 'sessions' });

      await w.page.goto(base + '/#/learning/session/s-mixed'); await ready(w.page);
      expect(await screen(w.page)).toMatchObject({ wf: 'Learning', active: 'sessions' });
      await w.page.goBack(); await ready(w.page);
      expect(await screen(w.page)).toMatchObject({ wf: 'Memory', active: 'sessions' });
      await w.page.goForward(); await ready(w.page);
      expect(await screen(w.page)).toMatchObject({ wf: 'Learning', active: 'sessions', h1: 'mixed' });
      await w.ctx.close();
    });

    it('keeps the project and the ground across a switch, and drops screen filters', async () => {
      const w = await open('#/memory/timeline', { ground: 'paper' });
      await pickProject(w.page, fx.repo.mixed);
      await w.page.waitForFunction((id) => location.hash === `#/memory/timeline?project=${encodeURIComponent(id)}`, fx.repo.mixed);
      await ready(w.page);
      await pickOption(w.page, '#mtag', 'auth');
      await w.page.waitForFunction(() => location.hash.includes('tag=auth'));
      await ready(w.page);
      expect(await w.page.$$eval('#mem-rows [data-entry]', (r) => r.length)).toBe(2);
      // Refresh keeps both.
      await w.page.reload(); await ready(w.page);
      expect(await w.page.inputValue('#mtag')).toBe('auth');

      await w.page.click('#wf-caret');
      await w.page.click('[data-wf="learning"]');
      await w.page.waitForFunction(() => location.hash.startsWith('#/learning/dashboard'));
      await ready(w.page);
      const hash = (await screen(w.page)).hash;
      expect(hash).toBe(`#/learning/dashboard?project=${enc(fx.repo.mixed)}`);
      expect(await projValue(w.page)).toBe(fx.repo.mixed);
      expect(await w.page.getAttribute('html', 'data-mode')).toBe('paper');
      await w.ctx.close();
    });

    it('never lets a late response paint over the other workflow', async () => {
      const w = await open('#/learning/dashboard');
      await w.page.route('**/api/memory?*', async (route) => {
        await new Promise((r) => setTimeout(r, 600));
        await route.continue();
      });
      await w.page.evaluate(() => { location.hash = '#/memory/timeline'; });
      await w.page.waitForFunction(() => location.hash === '#/memory/timeline');
      await w.page.evaluate(() => { location.hash = '#/learning/dashboard'; });
      await w.page.waitForTimeout(900);
      const s = await screen(w.page);
      expect(s).toMatchObject({ wf: 'Learning', active: 'dashboard', h1: 'Am I actually getting better?' });
      expect(await w.page.$('#mem-rows')).toBeNull();
      await w.ctx.close();
    });
  });

  describe('sidebar groups', () => {
    it('start open, collapse independently per workflow, and persist', async () => {
      const w = await open('#/learning/dashboard');
      await w.page.click('#tog-learning-history');
      expect(await w.page.isHidden('#grp-learning-history')).toBe(true);
      expect(await w.page.isVisible('#grp-learning-learn')).toBe(true);
      expect(await w.page.evaluate(() => localStorage.getItem('eklavya-dash-nav-collapsed:learning'))).toBe('["history"]');
      await w.page.reload(); await ready(w.page);
      expect(await w.page.isHidden('#grp-learning-history')).toBe(true);
      // Dashboard stays visible whatever is collapsed.
      expect(await w.page.isVisible('#nav a[data-nav="dashboard"]')).toBe(true);
      // The other workflow's groups are its own.
      await w.page.goto(base + '/#/memory/dashboard'); await ready(w.page);
      expect(await w.page.isVisible('#grp-memory-memory')).toBe(true);
      expect(await w.page.isVisible('#grp-memory-insights')).toBe(true);
      // A direct link into a collapsed group reveals it.
      await w.page.goto(base + '/#/learning/projects'); await ready(w.page);
      expect(await w.page.isVisible('#grp-learning-history')).toBe(true);
      expect((await screen(w.page)).active).toBe('projects');
      // ...and a collapse made on that page still takes effect immediately.
      await w.page.click('#tog-learning-history');
      expect(await w.page.isHidden('#grp-learning-history')).toBe(true);
      await w.ctx.close();
    });

    it('survives malformed and unavailable storage', async () => {
      const bad = await open('#/learning/dashboard', {
        init: `localStorage.setItem('eklavya-dash-nav-collapsed:learning', '{not json')`,
      });
      expect(await bad.page.isVisible('#grp-learning-learn')).toBe(true);
      expect(bad.errors).toEqual([]);
      await bad.ctx.close();

      const none = await open('#/learning/dashboard', {
        init: `Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });`,
      });
      expect((await screen(none.page)).h1).toBe('Am I actually getting better?');
      await none.page.click('#tog-learning-learn');
      expect(await none.page.isHidden('#grp-learning-learn')).toBe(true);
      await none.page.click('#wf-caret');
      await none.page.click('[data-wf="memory"]');
      await none.page.waitForFunction(() => location.hash === '#/memory/dashboard');
      expect(none.errors).toEqual([]);
      await none.ctx.close();
    });
  });

  describe('phones', () => {
    it('put the same navigation in a modal drawer that holds and restores focus', async () => {
      const w = await open('#/learning/dashboard', { width: 390, height: 844 });
      expect(await w.page.isVisible('#menu')).toBe(true);
      expect(await w.page.evaluate(() => (document.getElementById('side') as any).inert)).toBe(true);

      await w.page.click('#menu');
      expect(await w.page.getAttribute('#side', 'role')).toBe('dialog');
      expect(await w.page.getAttribute('#side', 'aria-modal')).toBe('true');
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('side-close');
      // Tab never leaves the drawer.
      for (let i = 0; i < 30; i++) await w.page.keyboard.press('Tab');
      expect(await w.page.evaluate(() => document.getElementById('side')!.contains(document.activeElement))).toBe(true);
      await w.page.keyboard.press('Shift+Tab');
      expect(await w.page.evaluate(() => document.getElementById('side')!.contains(document.activeElement))).toBe(true);

      await w.page.keyboard.press('Escape');
      expect(await w.page.evaluate(() => (document.getElementById('side') as any).inert)).toBe(true);
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('menu');

      // Following a link closes it.
      await w.page.click('#menu');
      await w.page.click('#nav a[data-nav="review"]');
      await w.page.waitForFunction(() => location.hash === '#/learning/review');
      expect(await w.page.evaluate(() => document.getElementById('side')!.classList.contains('is-open'))).toBe(false);

      // The scrim dismisses it too.
      await w.page.click('#menu');
      await w.page.mouse.click(370, 400);
      expect(await w.page.evaluate(() => (document.getElementById('side') as any).inert)).toBe(true);

      // Switching workflow from inside the drawer lands on the other Dashboard, drawer closed.
      await w.page.click('#menu');
      await w.page.click('#wf-caret');
      await w.page.click('[data-wf="memory"]');
      await w.page.waitForFunction(() => location.hash === '#/memory/dashboard');
      expect(await w.page.evaluate(() => document.getElementById('side')!.classList.contains('is-open'))).toBe(false);
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('menu');
      await w.ctx.close();
    });

    it('never hides the desktop sidebar from assistive technology', async () => {
      const w = await open('#/learning/dashboard', { width: 390, height: 844 });
      await w.page.click('#menu');
      await w.page.setViewportSize({ width: 1280, height: 900 });
      await w.page.waitForTimeout(100);
      const side = await w.page.evaluate(() => {
        const s = document.getElementById('side') as any;
        return { inert: s.inert, hidden: s.getAttribute('aria-hidden'), role: s.getAttribute('role'), main: (document.getElementById('main') as any).inert };
      });
      expect(side).toEqual({ inert: false, hidden: null, role: null, main: false });
      await w.ctx.close();
    });
  });

  /**
   * What a reader sees between a click and a settled page, recorded for every
   * page (`probeTransition`). Today's loaders, collapses and refetches are the
   * defects, so none of them is asserted here: the rows are evidence, printed
   * as a table when EKLAVYA_PROBE_REPORT is set. What is asserted is that the
   * probe can see each thing it reports, that it waits for the page to settle,
   * that each row is the page its route names (a wrong parameter is a not-found
   * screen, which settles like any other), and that nothing throws. The phases
   * that remove a defect assert its absence from these same recordings.
   */
  describe('the page-transition probe', () => {
    const navigate = (page: Page, hash: string) => () => page.evaluate((h) => { location.hash = h; }, hash);

    it('sees a loader, a collapse, a moving footer, requests, a scroll and a replaced element', async () => {
      const w = await open('#/learning/concepts', { height: 600 });
      const { page } = w;

      // The control: an action that does nothing reports nothing.
      const still = await probeTransition(page, async () => {}, { keep: '#nav' });
      expect(still).toMatchObject({
        hash: '#/learning/concepts', sawLoader: false, footerBounced: false, requests: [],
        headKept: true, keptSelector: true, scrollBefore: 0, scrollAfter: 0,
      });
      expect(still.minHeight).toBe(still.finalHeight);
      expect(still.beforeHeight).toBe(still.finalHeight);
      expect(still.finalHeight).toBeGreaterThan(300);
      expect(still.footerBefore).toBe(still.footerFinal);

      // A loader inserted and removed inside one task is never painted, and is still seen.
      const flash = await probeTransition(page, () => page.evaluate(() => {
        const l = document.createElement('div');
        l.className = 'loader';
        document.getElementById('view')!.append(l);
        l.remove();
      }));
      expect(flash.sawLoader).toBe(true);
      // So is one nested in what a fill wrote, which stays for a few frames.
      const shown = await probeTransition(page, () => page.evaluate(async () => {
        const box = document.createElement('div');
        box.innerHTML = '<section><p class="loader">Loading</p></section>';
        document.getElementById('view')!.append(box);
        await new Promise((r) => setTimeout(r, 40));
        box.remove();
      }));
      expect(shown.sawLoader).toBe(true);

      // A view squeezed and let go: the lowest height is reported, the footer rises and returns.
      const squeezed = await probeTransition(page, () => page.evaluate(async () => {
        const v = document.getElementById('view')!;
        v.style.height = '40px';
        await new Promise((r) => setTimeout(r, 60));
        v.style.height = '';
      }));
      expect(squeezed.minHeight).toBeLessThanOrEqual(60);
      expect(squeezed.finalHeight).toBe(still.finalHeight);
      expect(squeezed.heights).toContain(squeezed.minHeight);
      expect(squeezed.footerMin).toBeLessThan(squeezed.footerBefore - 100);
      expect(squeezed.footerFinal).toBe(squeezed.footerBefore);
      expect(squeezed.footerBounced).toBe(true);
      expect(squeezed.sawLoader).toBe(false);

      // The head replaced by an equal copy is a different element; one left alone is the same.
      const swapped = await probeTransition(page, () => page.evaluate((sel) => {
        const h = document.querySelector(sel)!;
        h.replaceWith(h.cloneNode(true));
      }, PAGE_HEAD), { keep: '#view h1' });
      expect(swapped.headKept).toBe(false);
      expect(swapped.keptSelector).toBe(false);
      // The next probe holds the new head. A selector that matches nothing has nothing to lose.
      expect((await probeTransition(page, async () => {})).headKept).toBe(true);
      expect((await probeTransition(page, async () => {}, { keep: '#nothing-here' })).keptSelector).toBeNull();

      // Requests are the /api/* ones, path and query, in order; a stylesheet is not one.
      // The scroll is the window's (the page's own is smooth, so an instant one is asked for).
      const fetched = await probeTransition(page, () => page.evaluate(async () => {
        // The body is read: a request whose body nobody reads is never reported finished.
        for (const url of ['/api/cursor', '/tokens.css', '/api/memory?per=1&page=1']) await (await fetch(url)).text();
        window.scrollTo({ top: 200, behavior: 'instant' });
      }));
      expect(fetched.requests).toEqual(['/api/cursor', '/api/memory?per=1&page=1']);
      expect(fetched).toMatchObject({ scrollBefore: 0, scrollAfter: 200, sawLoader: false });

      // A real navigation: the probe waits for the URL's screen and reports where it ended.
      const nav = await probeTransition(page, navigate(page, '#/learning/review'));
      expect(nav.hash).toBe('#/learning/review');
      expect(nav.scrollBefore).toBe(200);
      expect(nav.finalHeight).toBeGreaterThan(0);

      // Nothing is left sampling behind a probe.
      expect(await page.evaluate(() => '__probe' in window)).toBe(false);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('tells a footer that bounced from one that moved once, and ignores rounding', () => {
      expect(footerBounces([900])).toBe(false);
      expect(footerBounces([900, 901, 900])).toBe(false);
      // One move up, or one move down, is a page of a different length.
      expect(footerBounces([2000, 900])).toBe(false);
      expect(footerBounces([900, 2000])).toBe(false);
      // Up, and back down: a page that collapsed and re-grew.
      expect(footerBounces([2000, 700, 700, 900])).toBe(true);
      // Down and then up is the other order, and not a bounce.
      expect(footerBounces([700, 2000, 900])).toBe(false);
    });

    // The probe returns when the page has settled, not when the action is done: each thing it waits
    // for has a control that holds it back and fails if the probe returns first.

    it('waits for a fill that arrives late, and reports the page as drawn', async () => {
      const w = await open('#/learning/concepts', { height: 600 });
      const { page } = w;
      // The timeline's rows are one request, held back for 400 ms. A probe that returned as soon as
      // the hash was set would report the loader's height and no rows.
      await page.route('**/api/memory?*', async (route) => {
        await new Promise((r) => setTimeout(r, 400));
        await route.continue();
      });
      const late = await probeTransition(page, navigate(page, '#/memory/timeline'));
      expect(await page.$('#mem-rows .tl'), 'the rows are drawn when the probe returns').not.toBeNull();
      expect(late.hash).toBe('#/memory/timeline');
      expect(late.sawLoader).toBe(true);
      expect(late.requests).toEqual([expect.stringMatching(/^\/api\/memory\?/)]);
      await page.unroute('**/api/memory?*');
      // Its heights are the settled page's: a second probe of the page as it stands reports the same.
      const settled = await probeTransition(page, async () => {});
      expect(settled).toMatchObject({ sawLoader: false, requests: [] });
      expect(late.finalHeight).toBe(settled.finalHeight);
      expect(late.footerFinal).toBe(settled.footerFinal);
      expect(late.minHeight).toBeLessThanOrEqual(late.finalHeight);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 30000);

    it('waits for a loader that is still up, with no request behind it', async () => {
      const w = await open('#/learning/concepts', { height: 600 });
      const loading = await probeTransition(w.page, () => w.page.evaluate(() => {
        const l = document.createElement('div');
        l.className = 'loader';
        document.getElementById('view')!.append(l);
        setTimeout(() => l.remove(), 400);
      }));
      expect(loading.sawLoader).toBe(true);
      expect(await w.page.$('#view .loader'), 'the loader is gone when the probe returns').toBeNull();
      await w.ctx.close();
    }, 30000);

    it('waits out the quiet window, and for a slow request that begins inside it', async () => {
      const w = await open('#/learning/concepts', { height: 600 });
      const { page } = w;
      // One begun 250 ms after the first finished, with the page asked to be quiet for 500 ms, and
      // itself slow (800 ms): the probe has to see it begin, and wait for it to be read.
      await page.route('**/api/memory?per=1*', async (route) => {
        await new Promise((r) => setTimeout(r, 800));
        await route.continue();
      });
      const chained = await probeTransition(page, () => page.evaluate(async () => {
        await (await fetch('/api/cursor')).text();
        setTimeout(() => {
          fetch('/api/memory?per=1&page=1').then((r) => r.text()).then(() => { (window as any).__chained = 'read'; });
        }, 250);
      }), { quiet: 500 });
      expect(chained.requests).toEqual(['/api/cursor', '/api/memory?per=1&page=1']);
      expect(await page.evaluate(() => (window as any).__chained), 'the slow request is read when the probe returns').toBe('read');
      await w.ctx.close();
    }, 30000);

    it('waits for the screen to be drawn for the URL it settled on', async () => {
      const w = await open('#/learning/concepts', { height: 600 });
      // The URL changes, and the page is told of it 300 ms later: until then the screen is the old one,
      // with nothing loading and no request open to say it is not finished. (`replaceState` changes the
      // URL without the event that makes the page draw for it.)
      const held = await probeTransition(w.page, () => w.page.evaluate(() => {
        history.replaceState(history.state, '', '#/learning/domains');
        setTimeout(() => window.dispatchEvent(new HashChangeEvent('hashchange')), 300);
      }));
      expect(held.hash).toBe('#/learning/domains');
      expect(await w.page.evaluate(() => document.documentElement.dataset.rendered), 'the screen is drawn for the URL when the probe returns').toBe('#/learning/domains');
      expect((await screen(w.page)).h1).toBe('Domains');
      await w.ctx.close();
    }, 30000);

    it('waits for a scroll on its way, and reports where it ended', async () => {
      const w = await open('#/learning/concepts', { height: 600 });
      const { page } = w;
      // The page's own scroll is smooth, so a scroll that is asked for is still moving when the action returns.
      expect(await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight), 'the catalogue is long enough to scroll').toBeGreaterThan(1200);
      const scrolled = await probeTransition(page, () => page.evaluate(() => window.scrollTo({ top: 1200 })));
      expect(scrolled.scrollBefore).toBe(0);
      expect(scrolled.scrollAfter).toBe(1200);
      await w.ctx.close();
    }, 30000);

    it('reads a screen as a page only when it is the one its route names', () => {
      const csrf = { h1: 'CSRF', text: '← Concepts CSRF csrf · web-auth · T3 judgement Forcing a browser to send a request' };
      expect(notAPage(csrf)).toBeNull();
      expect(notAPage(csrf, { h1: /^CSRF$/ })).toBeNull();
      // A page, but not the one asked for; or none with a heading at all.
      expect(notAPage(csrf, { h1: /^Domains$/ })).toBe('its heading is "CSRF", not /^Domains$/');
      expect(notAPage({ h1: null, text: 'Some words' })).toBe('it has no heading');
      expect(notAPage({ h1: null, text: 'Some words' }, { h1: /^CSRF$/ })).toBe('it has no heading');
      // The viewer has no heading, so the words on it have to say which page it is.
      expect(notAPage({ h1: null, text: 'All artifacts Queues, explained Open in new browser tab' }, { has: /Queues, explained/ })).toBeNull();
      expect(notAPage({ h1: null, text: 'All artifacts Locks, explained' }, { has: /Queues, explained/ })).toBe('it never says /Queues, explained/');
      expect(notAPage({ h1: 'Feedback item', text: 'Feedback item fix the login bug' }, { h1: /^Feedback item$/, has: /login/ })).toBeNull();
      // What the dashboard says in place of a page, each of its sentences, with or without a heading.
      for (const said of [
        'No page here Nothing answers to x.', 'This link is malformed', 'Could not load: 404 Not Found',
        'No concept called x. Back to concepts.', 'No concepts in x for this scope.', 'No session x in this scope.', 'No observation 7.',
      ]) {
        expect(notAPage({ h1: null, text: said }), said).toMatch(/^it says "/);
        expect(notAPage({ h1: 'Feedback item', text: `Feedback item How this works ${said}` }, { h1: /^Feedback item$/ }), said).toMatch(/^it says "/);
      }
      // Words that merely begin alike are not: an empty list, a count of none.
      expect(notAPage({ h1: 'Sessions', text: 'Sessions No sessions in this scope yet. No observations yet.' })).toBeNull();
    });

    it('flags the screen a wrong parameter lands on, and not the page a right one does', async () => {
      const w = await open('#/learning/domains', { height: 600 });
      // Each of these settles, has a height and a canonical URL, and is not a page.
      const wrong: [string, RegExp][] = [
        ['#/learning/concept/zzz-nope', /^it says "No concept called"$/],
        ['#/learning/domain/zzz-nope', /^it says "No concepts in zzz-nope for this scope"$/],
        ['#/learning/session/zzz-nope', /^it says "No session zzz-nope in this scope"$/],
        ['#/memory/session/zzz-nope', /^it says "No session zzz-nope in this scope"$/],
        // A failed fill: the server answers 404, and the page's fill says it could not load.
        ['#/memory/entry/99999', /^it says "Could not load"$/],
        ['#/feedback/item/99999', /^it says "Could not load"$/],
        ['#/artifacts/view/nope%2Fnope.html', /^it says "No page here"$/],
        ['#/learning/concept/%E0%A4%A', /^it says "This link is malformed"$/],
      ];
      for (const [route, problem] of wrong) {
        // A failed fill is an error response whose body the page never reads: the probe must not wait for it.
        await probeTransition(w.page, navigate(w.page, route), { timeout: 5000 });
        expect(await pageProblem(w.page), route).toMatch(problem);
      }
      // The observation page says so when the answer holds none.
      await w.page.route('**/api/memory/entry?*', (route) => route.fulfill({ json: {} }));
      await probeTransition(w.page, navigate(w.page, '#/memory/entry/1'));
      expect(await pageProblem(w.page)).toBe('it says "No observation 1."');
      await w.page.unroute('**/api/memory/entry?*');
      // And a right parameter is a page, for the heading it names.
      await probeTransition(w.page, navigate(w.page, '#/learning/concept/csrf'));
      expect(await pageProblem(w.page, { h1: /^CSRF$/ })).toBeNull();
      expect(await pageProblem(w.page, { h1: /^web-auth$/ })).toBe('its heading is "CSRF", not /^web-auth$/');
      // The two failed fills are the browser's own console errors, and the only ones.
      expect(w.errors).toEqual([expect.stringMatching(/status of 404/), expect.stringMatching(/status of 404/)]);
      await w.ctx.close();
    }, 60000);

    it('records one row for every page of the registry, from a first visit and from a second', async () => {
      const w = await open('#/learning/domains', { height: 600 });
      // An acknowledged item, so the history lists a row and an item page has an id; gone when this test is.
      const fb = insertFeedback(db, {
        session_id: 's-probe', project: fx.repo.mixed, event_id: null, prompt: 'fix the login bug', model: 'sonnet',
        review: { worked: 'You named the bug.', gaps: [{ area: 'context', missing: 'No file named.' }] } as never,
        better: 'Fix the login bug in [the file].', tips: ['Name the file.'],
      })!;
      acknowledgeFeedback(db, fb);
      const rows: [string, ProbeReport][] = [];
      try {
        const registry = await w.page.evaluate('Object.entries(WORKFLOWS).flatMap(([wf, W]) => Object.entries(W.pages).map(([page, p]) => ({ wf, page, detail: !!p.parent })))') as { wf: string; page: string; detail: boolean }[];
        expect(registry.length).toBeGreaterThan(20);
        // A detail page needs a parameter to open, and a say in what the page it opens is: a wrong
        // parameter is a not-found screen, which resolves, settles and has a height like any page, so
        // only what the screen says tells the two apart. A new detail page fails here until it has both.
        // The two Settings scopes are detail pages of Preferences that take none.
        const detail: Record<string, { id: string } & Want> = {
          'learning/concept': { id: 'csrf', h1: /^CSRF$/ },
          'learning/session': { id: 's-mixed', h1: /^mixed$/ },
          'learning/domain': { id: 'web-auth', h1: /^web-auth$/ },
          'memory/entry': { id: String(fx.entries.mixed), h1: /SameSite=Lax/ },
          'memory/session': { id: 's-mixed', h1: /^mixed$/ },
          // The viewer has no heading: its tab bar names the page.
          'artifacts/view': { id: fix.other, has: /Queues, explained/ },
          'feedback/item': { id: String(fb), h1: /^Feedback item$/, has: /fix the login bug/ },
        };
        const routes: [route: string, want: Want][] = registry.map(({ wf, page, detail: isDetail }) => {
          const d = detail[`${wf}/${page}`];
          if (isDetail && wf !== 'settings') expect(d, `${wf}/${page} is a detail page: give it a parameter and what it shows`).toBeDefined();
          // The project settings page names a project, and the fixture has a checkout for this one.
          const q = wf === 'settings' && page === 'project' ? `?project=${enc(fx.repo.mixed)}` : '';
          return [`#/${wf}/${page}${d === undefined ? '' : '/' + enc(d.id)}${q}`, d ?? {}];
        });
        // Variants a reader reaches that no registry key names: a session only memory knows (looked up,
        // not in the payload), a typed timeline, a Settings tab.
        routes.push(
          [`#/learning/session/${enc('s-mem')}`, { h1: /^memory-only$/ }],
          ['#/memory/timeline/decision', { h1: /^Timeline$/ }],
          ['#/settings/dashboard/memory', { h1: /^User settings$/ }],
        );
        // Never the page already on screen: that would be no navigation at all.
        routes.forEach(([r], i) => expect(r, 'two routes in a row').not.toBe(routes[i - 1]?.[0]));

        for (const pass of [1, 2]) {
          for (const [route, want] of routes) {
            const r = await probeTransition(w.page, navigate(w.page, route));
            rows.push([`${pass} ${route}`, r]);
            // It is the page its route names, not what the dashboard says in place of one: the
            // canonical URL, the heading (or text) it was given, no not-found sentence, no failed fill.
            expect(r.hash, route).toBe(route);
            expect(await pageProblem(w.page, want), route).toBeNull();
            expect(r.finalHeight, route).toBeGreaterThan(0);
            expect(r.minHeight, route).toBeLessThanOrEqual(r.finalHeight);
            if (pass === 1) {
              // A first visit may fetch, and may show a loader, but it may not collapse. The page being left sets one
              // end of the view's height (`beforeHeight`) and the page being drawn the other (`finalHeight`): either may
              // be the taller, and a page that goes straight from one to the other is not a collapse. What is one is a
              // view that goes below both while it waits, because the box it holds for what is coming is smaller than
              // what comes: the footer jumps up, then down. That is what "never drops below the room the shell reserved"
              // is, read off the probe. A few pixels are rounding (a scrollbar, a border).
              expect(r.minHeight, `${route} collapsed while it loaded`).toBeGreaterThanOrEqual(Math.min(r.beforeHeight, r.finalHeight) - 4);
              expect(r.footerBounced, `${route}: the footer moved up and back down`).toBe(false);
            } else {
              // A revisit is drawn from what the page already holds: nothing is asked for, and no loader is drawn, not
              // even for a frame (the probe inspects every mutation batch, so a loader added and removed in one task counts).
              expect(r.requests, `${route} asked the server for a page it had seen`).toEqual([]);
              expect(r.sawLoader, `${route} drew a loader for a page it had seen`).toBe(false);
            }
          }
        }
      } finally {
        db.prepare('DELETE FROM feedback_items WHERE id = ?').run(fb);
        // Printed even when a row fails, so the rows before it are not lost.
        if (process.env.EKLAVYA_PROBE_REPORT) {
          const scrub = (s: string) => s.replaceAll(enc(fx.root), '<root>').replaceAll(fx.root, '<root>')
            .replaceAll(enc(fix.other), '<artifact>').replaceAll(fix.other, '<artifact>');
          console.log(`\nEKLAVYA_PROBE_REPORT navigation (pass 1 is a first visit, pass 2 a revisit)\n${probeTable(rows, scrub)}\n`);
        }
      }
      expect(w.errors).toEqual([]);
      expect(w.outbound).toEqual([]);
      await w.ctx.close();
    }, 180000);

    it('records an adjustment: a tab, a chip, a select, a pager and a Settings tab, with the reader part-way down the page', async () => {
      const w = await open('#/learning/domains', { height: 600 });
      const rows: [string, ProbeReport][] = [];
      const cases: { name: string; from: string; to: string; act: () => Promise<unknown>; keep?: string; then?: () => Promise<unknown> }[] = [
        { name: 'a Review tab', from: '#/learning/review', to: '#/learning/review/skipped', act: () => w.page.click('[data-tab="skipped"]') },
        { name: 'a concept chip', from: '#/learning/concepts', to: '#/learning/concepts/due', act: () => w.page.click('[data-state="due"]') },
        { name: 'a Timeline tag', from: '#/memory/timeline', to: '#/memory/timeline?tag=auth', act: () => pickOption(w.page, '#mtag', 'auth') },
        // A pager changes no URL: it is `T.concepts.page`, and the catalogue is long enough to have one.
        {
          name: 'a pager', from: '#/learning/concepts', to: '#/learning/concepts',
          act: () => w.page.click('[data-pager="concepts"][aria-label="Next page"]'),
          then: async () => expect(await w.page.textContent('[data-pager="concepts"][aria-current="true"]')).toBe('2'),
        },
        { name: 'a Settings tab', from: '#/settings/dashboard', to: '#/settings/dashboard/memory', act: () => w.page.click('.sw__tab[href$="/memory"]'), keep: '#settings .sw' },
      ];
      for (const c of cases) {
        await w.page.goto(base + '/' + c.from);
        await ready(w.page);
        await w.page.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
        const r = await probeTransition(w.page, c.act, { keep: c.keep });
        rows.push([c.name, r]);
        expect(r.hash, c.name).toBe(c.to);
        expect(r.finalHeight, c.name).toBeGreaterThan(0);
        await c.then?.();
      }
      if (process.env.EKLAVYA_PROBE_REPORT) {
        console.log(`\nEKLAVYA_PROBE_REPORT adjustment (scrolled 300px first, where the page is tall enough)\n${probeTable(rows)}\n`);
      }
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 120000);
  });
});
