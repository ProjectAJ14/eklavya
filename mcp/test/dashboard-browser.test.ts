/**
 * The dashboard in a real browser: the routes, the workflow control, the
 * sidebar, the drawer and the network promise, exercised the way a reader
 * does rather than read out of the page's source.
 *
 * Needs a Chromium. `EKLAVYA_TEST_BROWSER` names one explicitly; otherwise
 * Playwright's own install is used (`npx playwright-core install
 * chromium`, which CI runs), and failing that the system
 * Chrome. With none of them the suite is skipped locally with a warning — and
 * fails on CI, where a skipped browser suite would be a silently green one.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { openDb, type DB } from '../src/db.js';
// The built server, so the page under test is the one `npm run build` ships.
import { startDashboard } from '../dist/dashboard.js';
import { createArtifact } from '../dist/artifacts.js';
import { seedFixture, type Fixture } from './dashboard-fixture.js';

function launchOptions(): Parameters<typeof chromium.launch>[0] | null {
  const explicit = process.env.EKLAVYA_TEST_BROWSER;
  if (explicit) return { executablePath: explicit };
  try {
    if (fs.existsSync(chromium.executablePath())) return {};
  } catch { /* not installed */ }
  if (process.platform === 'darwin' && fs.existsSync('/Applications/Google Chrome.app')) return { channel: 'chrome' };
  return null;
}

const OPTS = launchOptions();
if (!OPTS) {
  if (process.env.CI) throw new Error('dashboard-browser: no Chromium available on CI');
  console.warn('dashboard-browser: no Chromium found, skipping the browser suite');
}

let home = '';
let db: DB;
let fx: Fixture;
let base = '';
let close = () => {};
let browser: Browser;
const savedHome = process.env.EKLAVYA_HOME;

beforeAll(async () => {
  if (!OPTS) return;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-dash-browser-'));
  process.env.EKLAVYA_HOME = path.join(home, 'home');
  db = openDb(path.join(home, 'knowledge.db'));
  fx = seedFixture(db, path.join(home, 'root'));
  createArtifact({ title: 'Why CSRF needs SameSite', description: 'an explainer', kind: 'explainer', concept: 'csrf' });
  const srv = await startDashboard(db as any, { port: 0 });
  base = srv.url;
  close = srv.close;
  browser = await chromium.launch({ headless: true, ...OPTS });
}, 60000);

afterAll(async () => {
  if (!OPTS) return;
  await browser?.close();
  close();
  db?.close();
  if (savedHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = savedHome;
  fs.rmSync(home, { recursive: true, force: true });
});

interface Watched { page: Page; ctx: BrowserContext; errors: string[]; outbound: string[] }

async function open(
  hash: string,
  opts: { width?: number; height?: number; init?: string; ground?: 'ink' | 'paper' } = {},
): Promise<Watched> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 } });
  if (opts.ground) await ctx.addInitScript((g) => localStorage.setItem('eklavya-ground', g), opts.ground);
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const outbound: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith('http') && u.origin !== new URL(base).origin) outbound.push(r.url());
  });
  await page.goto(base + '/' + hash);
  await ready(page);
  return { page, ctx, errors, outbound };
}

/** The page has booted and any fill it queued has landed. */
async function ready(page: Page) {
  await page.waitForFunction(() => document.documentElement.dataset.rendered === location.hash
    && !document.querySelector('#view .empty')?.textContent?.startsWith('Loading')
    && !document.querySelector('#view .empty')?.textContent?.startsWith('Looking'));
  await page.waitForLoadState('networkidle');
}

const screen = (page: Page) => page.evaluate(() => ({
  hash: location.hash,
  h1: document.querySelector('#view h1')?.textContent?.trim() ?? null,
  crumb: [...document.querySelectorAll('#crumb span')].map((s) => s.textContent),
  active: document.querySelector('#nav [aria-current="page"]')?.getAttribute('data-nav') ?? null,
  wf: document.querySelector('#wf-main span')?.textContent ?? null,
  items: [...document.querySelectorAll('#nav a[data-nav]')].map((a) => a.getAttribute('data-nav')),
}));

const enc = encodeURIComponent;

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

    it('carries the query and decodes encoded identifiers', async () => {
      const id = fx.repo.mixed;
      const w = await open(`#/concepts/due?project=${enc(id)}`);
      expect((await screen(w.page)).hash).toBe(`#/learning/concepts/due?project=${enc(id)}`);
      expect(await w.page.inputValue('#proj')).toBe(id);
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
      expect(await w.page.inputValue('#proj')).toBe('');
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
      await w.page.selectOption('#proj', fx.repo.mixed);
      await w.page.waitForFunction((id) => location.hash === `#/memory/timeline?project=${encodeURIComponent(id)}`, fx.repo.mixed);
      await ready(w.page);
      await w.page.selectOption('#mtag', 'auth');
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
      expect(await w.page.inputValue('#proj')).toBe(fx.repo.mixed);
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

  describe('artifacts', () => {
    it('searches as you type, and opens a page in a new tab that cannot read the dashboard', async () => {
      const w = await open('#/artifacts/dashboard');
      const link = w.page.locator('#view a[target="_blank"]');
      expect(await link.count()).toBe(1);
      expect(await link.getAttribute('href')).toMatch(/^\/artifacts\/.+\.html$/);
      expect(await link.getAttribute('rel')).toBe('noopener');

      await w.page.fill('#aq', 'no such page');
      expect(await link.count()).toBe(0);
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('aq');
      await w.page.fill('#aq', 'samesite');
      expect(await link.count()).toBe(1);

      const href = await link.getAttribute('href');
      const tab = await w.ctx.newPage();
      await tab.goto(base + href);
      expect(await tab.locator('h1').textContent()).toBe('Why CSRF needs SameSite');
      const read = await tab.evaluate(() => fetch('/api/state').then(() => 'read', () => 'blocked'));
      expect(read).toBe('blocked');
      await w.ctx.close();
    });
  });

  describe('every screen', () => {
    it('makes no outbound request, logs no error, and fits the width', async () => {
      const hashes = ['#/learning/dashboard', '#/learning/projects', '#/memory/dashboard', '#/memory/timeline',
        '#/memory/sessions', '#/memory/projects', '#/memory/health', `#/memory/entry/${fx.entries.mixed}`,
        '#/artifacts/dashboard', '#/artifacts/dashboard/explainer', '#/artifacts/projects'];
      for (const width of [1280, 900, 560, 390]) {
        for (const ground of ['ink', 'paper'] as const) {
          const w = await open(hashes[0]!, { width, ground });
          for (const h of hashes) {
            await w.page.goto(base + '/' + h); await ready(w.page);
            const fits = await w.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
            expect(fits, `${h} at ${width} on ${ground}`).toBe(true);
          }
          expect(w.outbound).toEqual([]);
          expect(w.errors).toEqual([]);
          await w.ctx.close();
        }
      }
    }, 120000);

    // The page is served under a Content-Security-Policy. A directive too tight
    // for what the page really uses -- its inline script, inline styles, the
    // `data:` favicon, its own fetches -- breaks rendering with nothing but a
    // console line, so every violation is collected and must be none.
    it('renders fully under its security policy, with no violation', async () => {
      const w = await open('#/learning/dashboard', {
        init: `window.__csp = []; document.addEventListener('securitypolicyviolation',
          (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));`,
      });
      const res = await w.page.reload(); await ready(w.page);
      expect(res?.headers()['content-security-policy']).toContain("default-src 'self'");
      for (const h of ['#/learning/dashboard', '#/learning/concepts', '#/memory/timeline', `#/memory/entry/${fx.entries.mixed}`]) {
        await w.page.goto(base + '/' + h); await ready(w.page);
        expect(await w.page.evaluate(() => document.querySelector('#view h1')?.textContent?.trim()), h).toBeTruthy();
      }
      expect(await w.page.evaluate(() => (window as any).__csp)).toEqual([]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('escapes an apostrophe along with the other four', async () => {
      const w = await open('#/learning/dashboard');
      // `esc` is a top-level const of the page's own script.
      expect(await w.page.evaluate(() => (0, eval)('esc')(`<a title='x' href="y">&</a>`)))
        .toBe('&lt;a title=&#39;x&#39; href=&quot;y&quot;&gt;&amp;&lt;/a&gt;');
      await w.ctx.close();
    });
  });

  describe('projects', () => {
    it('lists every project in the selector, whatever recorded it', async () => {
      const w = await open('#/learning/dashboard');
      const options = await w.page.$$eval('#proj option', (o) => o.map((x) => x.textContent));
      for (const name of ['logged', 'memory-only', 'pending', 'answered', 'mixed', 'client/api', 'server/api',
        'retired (checkout gone)', 'No repository', 'Unattributed']) {
        expect(options, name).toContain(name);
      }
      // Worktrees fold into their checkout; they are not projects of their own.
      expect(options.filter((o) => o?.startsWith('mixed'))).toEqual(['mixed']);
      await w.ctx.close();
    });

    it('shows a project with no answers honestly, in both workflows', async () => {
      const w = await open(`#/learning/projects?project=${enc(fx.repo.logged)}`);
      expect(await w.page.textContent('#view')).toMatch(/No assessments yet/);
      await w.page.goto(base + `/#/learning/dashboard?project=${enc(fx.repo.logged)}`); await ready(w.page);
      expect(await w.page.textContent('#view')).toMatch(/No assessments yet/);
      await w.page.goto(base + `/#/memory/projects`); await ready(w.page);
      expect(await w.page.textContent('#view')).toMatch(/pending/);
      await w.ctx.close();
    });
  });
});
