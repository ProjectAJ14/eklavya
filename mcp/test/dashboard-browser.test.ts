// Split by feature so Vitest's file sharding can divide the browser work.
import { describe, expect, it } from 'vitest';
import { OPTS, base, enc, fx, open, pickOption, pickProject, projValue, ready, screen } from './dashboard-browser-helpers.js';
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
});
