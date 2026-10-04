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
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright-core';
import { openDb, type DB } from '../src/db.js';
// The built server, so the page under test is the one `npm run build` ships.
import { startDashboard } from '../dist/dashboard.js';
import { createArtifact } from '../dist/artifacts.js';
import { seedFixture, type Fixture } from './dashboard-fixture.js';
import { gradeConcept } from '../src/store.js';

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
/** Two explainers for missed questions with an answer key: ids in the gallery, and their attempts. */
const fix = { open: '', other: '', attempt: 0, missed: () => 0 };
const KEY = { options: ['A cache', 'A lock', 'A queue', 'A log'], notes: ['keeps reads', 'serialises writers', 'orders work', 'appends history'] };
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
  fix.missed = () => gradeConcept(db, {
    conceptId: (db.prepare(`SELECT id FROM concepts WHERE slug = 'csrf'`).get() as { id: number }).id,
    sessionId: 's-fix', question: 'What stops two writers clobbering a row?', answer: 'A cache', grade: 1, difficulty: 2,
    feedback: null, outcome: 'answered', format: 'mcq', options: KEY.options, correct: 'A lock', optionNotes: KEY.notes,
    repo: null, level: null, now: new Date(),
  }).attemptId;
  fix.attempt = fix.missed();
  fix.open = createArtifact({ title: 'Locks, explained', kind: 'explainer', concept: 'csrf', attempt: fix.attempt }).id;
  fix.other = createArtifact({ title: 'Queues, explained', kind: 'explainer', concept: 'csrf', attempt: fix.missed() }).id;
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
  opts: { width?: number; height?: number; init?: string; ground?: 'ink' | 'paper'; tips?: boolean } = {},
): Promise<Watched> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 } });
  // Tips are switched off unless a test is about them, so a bubble never sits on what a test clicks.
  if (!opts.tips) await ctx.addInitScript(() => { try { localStorage.getItem('eklavya-dash-tips') ?? localStorage.setItem('eklavya-dash-tips', '{"off":true}'); } catch { /* the framed page */ } });
  // Init scripts run in every frame, and the viewer's sandboxed frame has no storage.
  if (opts.ground) await ctx.addInitScript((g) => { try { localStorage.setItem('eklavya-ground', g); } catch { /* the framed page */ } }, opts.ground);
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  track(page);
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
    && !document.querySelector('.booting, #view .loader'));
  // Not `waitForLoadState('networkidle')`: once the explainer viewer's
  // sandboxed frame has been attached, Playwright never reports the page idle
  // again, with nothing in flight. The page's own count of open requests does.
  const open = inflight.get(page);
  if (!open) return page.waitForLoadState('networkidle');
  for (let quiet = 0, waited = 0; quiet < 500; waited += 50) {
    if (waited > 30000) throw new Error(`still loading: ${[...open].map((r) => r.url()).join(', ')}`);
    await new Promise((r) => setTimeout(r, 50));
    quiet = open.size ? 0 : quiet + 50;
  }
}

/** Requests each page has open, for `ready()`. */
const inflight = new WeakMap<Page, Set<Request>>();
function track(page: Page) {
  const open = new Set<Request>();
  inflight.set(page, open);
  page.on('request', (r) => open.add(r));
  page.on('requestfinished', (r) => open.delete(r));
  page.on('requestfailed', (r) => open.delete(r));
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

/** The project selector is a button plus a listbox; its value is `data-value`. */
const projValue = (page: Page) => page.getAttribute('#proj', 'data-value');
async function pickProject(page: Page, id: string) {
  await page.click('#proj');
  await page.click(`#proj-menu [role="option"][data-value="${id.replace(/"/g, '\\"')}"]`);
}

/** A native <select> is hidden behind a combo; drive the combo the way a reader would. */
async function pickOption(page: Page, sel: string, value: string) {
  const i = await page.$eval(sel, (s, v) => [...(s as HTMLSelectElement).options].findIndex((o) => o.value === v), value);
  if (i < 0) throw new Error(`${sel} has no option ${value}`);
  await page.click(`${sel}-combo`);
  await page.click(`#sel-menu [role="option"][data-i="${i}"]`);
}

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
        ['#/settings', '#/settings/dashboard', { wf: 'Settings', active: 'dashboard', h1: /^Settings$/ }],
        ['#/settings/user', '#/settings/user', { wf: 'Settings', active: 'user', h1: /^User settings$/ }],
        ['#/settings/project', '#/settings/project', { wf: 'Settings', active: 'project', h1: /^Project settings$/ }],
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
      const w = await open('#/learning/dashboard');
      // The page leads with its answer: explanation and secondary cards are closed.
      expect(await w.page.getAttribute('#view details.about', 'open')).toBeNull();
      const heat = w.page.locator('details[data-fold="learn:heat"]');
      expect(await heat.getAttribute('open')).toBeNull();
      // A chart inside a closed fold has no width to measure, so it waits.
      expect(await w.page.$eval('#c-heat', (s) => s.childElementCount)).toBe(0);
      await heat.locator('summary').focus();
      await w.page.keyboard.press('Enter');
      await w.page.waitForFunction(() => document.getElementById('c-heat')!.childElementCount > 0);
      // Opened once, it stays open across a reload and a re-render.
      await w.page.reload(); await ready(w.page);
      expect(await heat.getAttribute('open')).not.toBeNull();
      expect(await w.page.$eval('#c-heat', (s) => s.childElementCount)).toBeGreaterThan(0);
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

  describe('artifacts', () => {
    it('searches as you type, and opens a page here, or in a new tab that cannot read the dashboard', async () => {
      const w = await open('#/artifacts/dashboard');
      const link = w.page.locator('#view .art:not(:has(.tag)) .art__open');
      expect(await link.count()).toBe(1);
      expect(await link.getAttribute('href')).toMatch(/^#\/artifacts\/view\/.+\.html$/);
      expect(await link.getAttribute('target')).toBeNull();
      // The card's thumbnail loads, and follows the ground when it changes.
      const img = link.locator('img[data-thumb]');
      await img.evaluate((i: HTMLImageElement) => i.decode());
      expect(await img.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0);
      await w.page.evaluate(() => (window as any).eklavyaGround.set('paper'));
      expect(await img.getAttribute('src')).toContain('thumb=paper');
      await w.page.evaluate(() => (window as any).eklavyaGround.set('ink'));

      await w.page.fill('#aq', 'no such page');
      expect(await link.count()).toBe(0);
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('aq');
      await w.page.fill('#aq', 'samesite');
      expect(await link.count()).toBe(1);

      await link.click();
      await ready(w.page);
      const out = w.page.locator('#view .viewer__bar a');
      expect(await out.textContent()).toContain('Open in new browser tab');
      expect(await out.getAttribute('target')).toBe('_blank');
      expect(await out.getAttribute('rel')).toBe('noopener');
      const href = await out.getAttribute('href');
      expect(href).toMatch(/^\/artifacts\/.+\.html$/);
      const tab = await w.ctx.newPage();
      await tab.goto(base + href);
      expect(await tab.locator('h1').textContent()).toBe('Why CSRF needs SameSite');
      const read = await tab.evaluate(() => fetch('/api/state').then(() => 'read', () => 'blocked'));
      expect(read).toBe('blocked');
      await w.ctx.close();
    });
  });

  describe('correcting a missed answer', () => {
    const armed = (page: Page) => page.evaluate(() => {
      const e = new Event('beforeunload', { cancelable: true });
      dispatchEvent(e);
      return e.defaultPrevented;
    });

    it('frames the explainer sandboxed, corrects it in the modal and flips the bar and the gallery', async () => {
      const w = await open('#/artifacts/dashboard/to-correct');
      const card = w.page.locator(`#view a[href*="${enc(fix.open)}"]`);
      expect(await w.page.locator('#view .art').count()).toBe(2);
      expect(await w.page.textContent('#view')).toContain('To correct');
      await card.click();
      await ready(w.page);
      expect(await w.page.evaluate(() => location.hash)).toBe(`#/artifacts/view/${enc(fix.open)}`);
      const frame = w.page.locator('#art-frame');
      expect(await frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
      // The page reported its own height (ready() waits for it), so the two scroll as one document.
      expect(await frame.evaluate((f: HTMLIFrameElement) => f.style.height)).toMatch(/^\d+px$/);
      expect(await w.page.textContent('#fixbar')).toContain('Not now? It stays under To correct.');
      expect(await armed(w.page)).toBe(true);

      const barHeight = () => w.page.evaluate(() => document.getElementById('fixbar')!.getBoundingClientRect().height);
      const openHeight = await barHeight();
      await w.page.click('#fix-open');
      expect(await w.page.evaluate(() => (document.getElementById('fix') as HTMLDialogElement).open)).toBe(true);
      const labels = await w.page.$$eval('#fix-opts .fix__opt', (b) => b.map((x) => (x as HTMLElement).dataset.pick));
      expect([...labels].sort()).toEqual([...KEY.options].sort());
      expect(await w.page.textContent('#fix-opts')).toContain('serialises writers');
      // The options are keyboard-walkable: an arrow moves focus to the next one.
      const first = await w.page.evaluate(() => (document.activeElement as HTMLElement).dataset.pick);
      await w.page.keyboard.press('ArrowDown');
      expect(await w.page.evaluate(() => (document.activeElement as HTMLElement).dataset.pick)).not.toBe(first);

      await w.page.click('#fix-opts [data-pick="A queue"]');
      await w.page.waitForSelector('#fix-msg:text("Still incorrect. Please correct your answer.")');
      expect(await w.page.isDisabled('#fix-opts [data-pick="A queue"]')).toBe(true);
      expect(await w.page.textContent('#fix-opts [data-pick="A queue"]')).toContain('Not this one');
      expect(await w.page.isDisabled('#fix-opts [data-pick="A lock"]')).toBe(false);

      await w.page.focus('#fix-opts [data-pick="A lock"]');
      await w.page.keyboard.press('Enter');
      await w.page.waitForSelector('#fix-msg:text("Corrected. Your stats now count this as answered.")');
      expect(await w.page.textContent('#fix-opts [data-pick="A lock"]')).toContain('Right answer');
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('fix-close');
      // The rest of the page was drawn from the old payload, and says so.
      expect(await w.page.isHidden('#stale')).toBe(false);
      expect(await armed(w.page)).toBe(false);
      await w.page.keyboard.press('Enter');
      await w.page.waitForFunction(() => /Corrected on try 2 · /.test(document.getElementById('fixbar')?.textContent ?? ''));
      // The bar changes state in place: same height, so nothing under or above it moves.
      expect(await barHeight()).toBe(openHeight);
      expect(db.prepare('SELECT picked, correct FROM attempt_retries WHERE attempt_id = ? ORDER BY id').all(fix.attempt))
        .toEqual([{ picked: 'A queue', correct: 0 }, { picked: 'A lock', correct: 1 }]);

      // Its tab's dot turned with it.
      expect(await w.page.locator('#view [role="tab"][aria-selected="true"] .tab__dot.is-done').count()).toBe(1);
      await w.page.click('#view [role="tab"]:has-text("All artifacts")');
      await ready(w.page);
      expect(await w.page.textContent(`#view .art:has(a[href*="${enc(fix.open)}"])`)).toContain('Corrected');
      expect(w.errors).toEqual([]);
      expect(w.outbound).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('asks before leaving only while a correction is open, and Escape is "not now"', async () => {
      const w = await open(`#/artifacts/view/${enc(fix.other)}`);
      expect(await armed(w.page)).toBe(true);
      await w.page.click('#fix-open');
      await w.page.keyboard.press('Escape');
      expect(await w.page.evaluate(() => (document.getElementById('fix') as HTMLDialogElement).open)).toBe(false);
      expect(await w.page.textContent('#fixbar')).toContain('Correct your answer');
      expect(await armed(w.page)).toBe(true);
      await w.page.goto(base + '/#/artifacts/dashboard'); await ready(w.page);
      expect(await armed(w.page)).toBe(false);
      // A page with no attempt behind it gets no bar and no prompt.
      const plain = (await w.page.getAttribute('#view .art:not(:has(.tag)) .art__open', 'href'))!;
      await w.page.goto(base + '/' + plain); await ready(w.page);
      expect(await w.page.locator('#fixbar').count()).toBe(0);
      expect(await armed(w.page)).toBe(false);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });
  });

  describe('the correction bar', () => {
    // An explainer taller than any window, so there is something to read past.
    let tall = '';
    beforeAll(() => {
      if (!OPTS) return;
      const made = createArtifact({ title: 'Tall locks, explained', kind: 'explainer', concept: 'csrf', attempt: fix.missed() });
      fs.writeFileSync(made.path, fs.readFileSync(made.path, 'utf8').replace('<!-- CONTENT:', '<p>Read this line.</p>'.repeat(150) + '<!-- CONTENT:'));
      tall = made.id;
    });

    const geo = (page: Page) => page.evaluate(() => {
      const r = (id: string) => document.getElementById(id)!.getBoundingClientRect();
      const note = document.querySelector('#fixbar .fixbar__note') as HTMLElement;
      return { inner: innerHeight, bar: r('fixbar').toJSON(), frame: r('art-frame').toJSON(), btn: r('fix-open').toJSON(), note: note.offsetParent !== null };
    });

    for (const width of [1280, 560]) {
      it(`sits on the bottom edge while you read and under the page at its end, button on the right, at ${width}px`, async () => {
        const w = await open(`#/artifacts/view/${enc(tall)}`, { width });
        await w.page.waitForSelector('#fix-open');
        expect(await w.page.getAttribute('#fixbar', 'role')).toBe('region');
        expect(await w.page.getAttribute('#fixbar', 'aria-label')).toBe('Correction');
        expect(await w.page.textContent('#fixbar')).toContain('You missed this one.');
        let g = await geo(w.page);
        expect(Math.round(g.bar.bottom)).toBe(g.inner);
        expect(g.bar.right - g.btn.right).toBeLessThanOrEqual(24);
        expect(g.btn.right).toBeLessThanOrEqual(g.bar.right);
        // One row: the button sits beside the text, never under it.
        expect(g.btn.top).toBeGreaterThanOrEqual(g.bar.top);
        expect(g.note).toBe(width > 560);
        await w.page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }));
        g = await geo(w.page);
        expect(g.bar.top).toBeGreaterThanOrEqual(g.frame.bottom);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      });
    }

    it("says what went wrong when the question won't load, and retries", async () => {
      const w = await open('#/artifacts/dashboard');
      let fail = true;
      await w.page.route('**/api/attempts/correction*', (r) => fail
        ? r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'the database is busy' }) })
        : r.continue());
      await w.page.evaluate((h) => { location.hash = h; }, `#/artifacts/view/${enc(tall)}`);
      await w.page.waitForSelector('#fix-retry');
      expect(await w.page.textContent('#fixbar')).toContain('the database is busy');
      fail = false;
      await w.page.click('#fix-retry');
      await w.page.waitForSelector('#fix-open');
      expect(w.errors.filter((e) => !/status of 500/.test(e))).toEqual([]);
      await w.ctx.close();
    });
  });

  describe('one scroll', () => {
    // A page written without the template's frame script, as every page before 1.46 was.
    const id = 'plain/tall.html';
    const dir = () => path.join(process.env.EKLAVYA_HOME!, 'artifacts', 'plain');
    beforeAll(() => {
      if (!OPTS) return;
      fs.mkdirSync(dir(), { recursive: true });
      fs.writeFileSync(path.join(dir(), 'tall.html'), '<!doctype html><html><head><title>Tall plain page</title>'
        + '<style>main{min-height:100vh}</style></head><body><main>'
        + '<p>A line of text that wraps on a narrow screen and stays on one line on a wide one.</p>'.repeat(200)
        + '</main></body></html>');
      const lines = '<p>A line of text that wraps on a narrow screen and stays on one line on a wide one.</p>'.repeat(120);
      // Two hand-written layouts that size themselves from the window, which inside the frame is the frame.
      fs.writeFileSync(path.join(dir(), 'full.html'), `<!doctype html><html><head><title>Full</title><style>html,body{height:100%;margin:0}</style></head><body>${lines}</body></html>`);
      fs.writeFileSync(path.join(dir(), 'hero.html'), `<!doctype html><html><head><title>Hero</title><style>.hero{min-height:100vh}</style></head><body><section class="hero"><h1>Hero</h1></section>${lines}</body></html>`);
    });
    afterAll(() => { if (OPTS) fs.rmSync(dir(), { recursive: true, force: true }); });

    it('sizes a page whose html and body are 100% tall to its content, not to the frame', async () => {
      const w = await open(`#/artifacts/view/${enc('plain/full.html')}`);
      const frame = w.page.frames().find((f) => f.url().includes('full.html?embed'))!;
      const content = await frame.evaluate(() => [...document.querySelectorAll('p')].at(-1)!.getBoundingClientRect().bottom + scrollY);
      expect(await w.page.evaluate(() => document.getElementById('art-frame')!.clientHeight)).toBeGreaterThanOrEqual(Math.floor(content));
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('lets a page that grows with its frame scroll on its own, instead of growing to the cap', async () => {
      const w = await open(`#/artifacts/view/${enc('plain/hero.html')}`);
      await w.page.waitForFunction(() => document.getElementById('art-frame')!.style.height === '80vh');
      const frame = w.page.frames().find((f) => f.url().includes('hero.html?embed'))!;
      expect(await frame.evaluate(() => document.documentElement.scrollHeight > document.documentElement.clientHeight
        && getComputedStyle(document.documentElement).overflowY !== 'hidden')).toBe(true);
      // And it stays that way: no report pulls it back into the loop.
      await new Promise((r) => setTimeout(r, 500));
      expect(await w.page.evaluate(() => document.getElementById('art-frame')!.style.height)).toBe('80vh');
      await w.ctx.close();
    });

    /**
     * The frame element's height, and the framed document's own heights, once
     * the framed page has caught up with its new size (that crosses a process).
     */
    const sizes = async (page: Page) => {
      const frame = page.frames().find((f) => f.url().includes('tall.html?embed'))!;
      const read = async () => ({
        frame: await page.evaluate(() => document.getElementById('art-frame')!.clientHeight),
        ...await frame.evaluate(() => ({ scroll: document.documentElement.scrollHeight, client: document.documentElement.clientHeight })),
      });
      await expect.poll(async () => { const s = await read(); return s.frame === s.client; }).toBe(true);
      return read();
    };
    const settled = (page: Page, h: number) => page.waitForFunction((was) => {
      const now = document.getElementById('art-frame')!.clientHeight;
      return now !== was;
    }, h);

    it('sizes the frame to a page that carries no frame script, so only the window scrolls', async () => {
      const w = await open(`#/artifacts/view/${enc(id)}`);
      const s = await sizes(w.page);
      expect(s.frame).toBeGreaterThan(900);
      expect(s.frame).toBe(s.client);
      expect(s.scroll).toBeLessThanOrEqual(s.client);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('shrinks the frame back when the window widens again', async () => {
      const w = await open(`#/artifacts/view/${enc(id)}`);
      const wide = (await sizes(w.page)).frame;
      await w.page.setViewportSize({ width: 560, height: 900 });
      await settled(w.page, wide);
      const narrow = (await sizes(w.page)).frame;
      expect(narrow).toBeGreaterThan(wide);
      await w.page.setViewportSize({ width: 1280, height: 900 });
      await settled(w.page, narrow);
      const back = await sizes(w.page);
      expect(back.frame).toBe(wide);
      expect(back.scroll).toBeLessThanOrEqual(back.client);
      await w.ctx.close();
    });

    it('falls back to a frame that scrolls on its own when the page never reports', async () => {
      // As if the script were blocked: the guard sees it already ran, and stays silent.
      const w = await open(`#/artifacts/view/${enc(id)}`, { init: 'window.__eklavyaEmbed = 1' });
      expect(await w.page.evaluate(() => document.getElementById('art-frame')!.style.height)).toBe('80vh');
      expect(await w.page.locator('#view .loader').count()).toBe(0);
      await w.ctx.close();
    });
  });

  describe('artifact tabs', () => {
    // Nine plain pages; the first two are taller than any window.
    const P: string[] = [];
    const title = (i: number) => `Tab page ${i}`;
    beforeAll(() => {
      if (!OPTS) return;
      for (let i = 1; i <= 9; i++) {
        const made = createArtifact({ title: title(i), description: 'a page' });
        if (i <= 2) fs.writeFileSync(made.path, fs.readFileSync(made.path, 'utf8').replace('<!-- CONTENT:', '<p>Read this line.</p>'.repeat(150) + '<!-- CONTENT:'));
        P[i] = made.id;
      }
      // A page that is still growing when it first reports its height.
      const late = createArtifact({ title: 'Late page', description: 'grows after it loads' });
      fs.writeFileSync(late.path, fs.readFileSync(late.path, 'utf8').replace('<!-- CONTENT:', '<p>Read this line.</p>'.repeat(40)
        + '<div id="later"></div><script>setTimeout(function(){document.getElementById("later").innerHTML="<p>And this one.</p>".repeat(150)},400)</script><!-- CONTENT:'));
      P[10] = late.id;
    });
    afterAll(() => {
      if (!OPTS) return;
      for (const id of P.slice(1)) fs.rmSync(path.join(process.env.EKLAVYA_HOME!, 'artifacts', id), { force: true });
    });

    const tabs = (page: Page) => page.$$eval('#view [role="tab"]', (t) => t.map((x) => (x.getAttribute('aria-selected') === 'true' ? '*' : '') + x.textContent!.trim()));
    const go = async (page: Page, id: string) => {
      await page.evaluate((h) => { location.hash = h; }, `#/artifacts/view/${encodeURIComponent(id)}`);
      await ready(page);
    };
    /**
     * The page records a tab's position from its scroll event, which fires on
     * the next frame: a tab switch that lands first keeps the old position.
     */
    const recorded = (page: Page, id: string, y: number) => page.waitForFunction(
      ([id, y]) => Math.abs(((0, eval)('TABS').scroll.get(id) ?? -1e9) - y) <= 1, [id, y] as const, { timeout: 5000 });
    const all = async (page: Page) => { await page.click('#view [role="tab"]:has-text("All artifacts")'); await ready(page); };

    it('opens every card in the dashboard, as tabs in order, with no duplicates', async () => {
      const w = await open('#/artifacts/dashboard');
      expect(await w.page.locator('#view .art a[target="_blank"]').count()).toBe(0);
      for (const i of [1, 2, 3]) {
        await w.page.click(`#view .art__open[href*="${enc(P[i]!)}"]`);
        await ready(w.page);
        if (i < 3) await all(w.page);
      }
      expect(await tabs(w.page)).toEqual(['All artifacts', title(1), title(2), '*' + title(3)]);
      expect(await w.page.locator('#view .page__back').count()).toBe(0);
      await all(w.page);
      await w.page.click(`#view .art__open[href*="${enc(P[2]!)}"]`);
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(1), '*' + title(2), title(3)]);
      expect(await w.page.getAttribute('#view [role="tablist"]', 'aria-label')).toBeTruthy();
      expect(await w.page.getAttribute('#view [role="tab"][aria-selected="true"]', 'aria-controls')).toBe('view');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('closes the active tab to its right neighbour, and a reload brings the same tabs back', async () => {
      const w = await open(`#/artifacts/view/${enc(P[1]!)}`);
      await go(w.page, P[2]!);
      await go(w.page, P[3]!);
      await w.page.click('#view [role="tab"]:has-text("Tab page 2")');
      await ready(w.page);
      await w.page.click(`#view button[aria-label="Close ${title(2)}"]`);
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(1), '*' + title(3)]);
      expect(await w.page.evaluate(() => location.hash)).toBe(`#/artifacts/view/${enc(P[3]!)}`);
      // The last one closes to its left neighbour; with none left, to All artifacts.
      await w.page.click(`#view button[aria-label="Close ${title(3)}"]`);
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', '*' + title(1)]);
      await go(w.page, P[3]!);
      await w.page.reload();
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(1), '*' + title(3)]);
      // A middle click closes a tab too.
      await w.page.click('#view [role="tab"]:has-text("Tab page 1")', { button: 'middle' });
      expect(await tabs(w.page)).toEqual(['All artifacts', '*' + title(3)]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('closes the least recently viewed tab without an open correction when a ninth opens', async () => {
      const w = await open(`#/artifacts/view/${enc(fix.other)}`);
      for (let i = 1; i <= 7; i++) await go(w.page, P[i]!);
      expect((await tabs(w.page)).length).toBe(9);
      await go(w.page, P[8]!);
      const now = await tabs(w.page);
      expect(now.length).toBe(9);
      expect(now).toContain('Queues, explained');
      expect(now).not.toContain(title(1));
      expect(now.at(-1)).toBe('*' + title(8));
      await w.ctx.close();
    }, 60000);

    it('scrolls the strip to the open tab on a phone', async () => {
      const w = await open(`#/artifacts/view/${enc(P[3]!)}`, { width: 560 });
      for (const i of [4, 5, 6, 7]) await go(w.page, P[i]!);
      const r = await w.page.evaluate(() => {
        const strip = document.querySelector('#view [role="tablist"]')!.getBoundingClientRect();
        const tab = document.querySelector('#view [role="tab"][aria-selected="true"]')!.getBoundingClientRect();
        return { strip: strip.right, tab: tab.right, left: tab.left, sl: strip.left };
      });
      expect(r.tab).toBeLessThanOrEqual(r.strip + 1);
      expect(r.left).toBeGreaterThanOrEqual(r.sl - 1);
      expect(await w.page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(560);
      await w.ctx.close();
    }, 60000);

    it('still opens tabs when storage throws', async () => {
      const w = await open(`#/artifacts/view/${enc(P[4]!)}`, {
        init: 'Storage.prototype.getItem = () => { throw new Error("denied"); }; Storage.prototype.setItem = () => { throw new Error("denied"); };',
      });
      await go(w.page, P[5]!);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(4), '*' + title(5)]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('works from the keyboard: arrows, Home and End move, Enter opens, Delete closes', async () => {
      const w = await open(`#/artifacts/view/${enc(P[4]!)}`);
      await go(w.page, P[5]!);
      await go(w.page, P[6]!);
      const focused = () => w.page.evaluate(() => document.activeElement?.textContent?.trim());
      // One tab stop for the whole strip: the selected tab.
      expect(await w.page.$$eval('#view [role="tab"]', (t) => t.map((x) => (x as HTMLElement).tabIndex))).toEqual([-1, -1, -1, 0]);
      await w.page.focus('#view [role="tab"][aria-selected="true"]');
      await w.page.keyboard.press('ArrowLeft');
      expect(await focused()).toBe(title(5));
      await w.page.keyboard.press('Home');
      expect(await focused()).toBe('All artifacts');
      await w.page.keyboard.press('End');
      expect(await focused()).toBe(title(6));
      await w.page.keyboard.press('ArrowRight');
      expect(await focused()).toBe('All artifacts');
      await w.page.keyboard.press('ArrowRight');
      await w.page.keyboard.press('Enter');
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', '*' + title(4), title(5), title(6)]);
      await w.page.keyboard.press('ArrowRight');
      expect(await focused()).toBe(title(5));
      await w.page.keyboard.press(' ');
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(4), '*' + title(5), title(6)]);
      expect(await focused()).toBe(title(5));
      await w.page.keyboard.press('Delete');
      await ready(w.page);
      expect(await tabs(w.page)).toEqual(['All artifacts', title(4), '*' + title(6)]);
      expect(await focused()).toBe(title(6));
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('waits for a page that is still growing before taking you back to where you were', async () => {
      const w = await open(`#/artifacts/view/${enc(P[10]!)}`);
      await w.page.waitForFunction(() => document.documentElement.scrollHeight > 6000);
      const deep = await w.page.evaluate(() => {
        const y = document.documentElement.scrollHeight - innerHeight - 100;
        window.scrollTo({ top: y, behavior: 'instant' });
        return y;
      });
      await recorded(w.page, P[10]!, deep);
      await go(w.page, P[1]!);
      await go(w.page, P[10]!);
      await w.page.waitForFunction((y) => Math.abs(scrollY - y) <= 1, deep, { timeout: 5000 });
      await w.ctx.close();
    }, 60000);

    it('leaves focus alone after Enter on the tab that is already open', async () => {
      const w = await open(`#/artifacts/view/${enc(P[4]!)}`);
      await w.page.focus('#view [role="tab"][aria-selected="true"]');
      await w.page.keyboard.press('Enter');
      await w.page.click('#view [role="tab"]:has-text("All artifacts")');
      await ready(w.page);
      expect(await w.page.evaluate(() => document.activeElement === document.body)).toBe(true);
      await w.ctx.close();
    }, 60000);

    it('comes back to where you were reading when you switch back', async () => {
      const w = await open(`#/artifacts/view/${enc(P[1]!)}`);
      await go(w.page, P[2]!);
      const half = await w.page.evaluate(() => {
        const y = Math.round((document.documentElement.scrollHeight - innerHeight) / 2);
        window.scrollTo({ top: y, behavior: 'instant' });
        return y;
      });
      expect(half).toBeGreaterThan(500);
      await recorded(w.page, P[2]!, half);
      await w.page.click('#view [role="tab"]:has-text("Tab page 1")');
      await ready(w.page);
      await w.page.click('#view [role="tab"]:has-text("Tab page 2")');
      await ready(w.page);
      await w.page.waitForFunction((y) => Math.abs(scrollY - y) <= 1, half);
      // The strip stays on screen while you read.
      expect(await w.page.evaluate(() => document.querySelector('#view [role="tablist"]')!.getBoundingClientRect().top)).toBe(0);
      await w.ctx.close();
    }, 60000);
  });

  describe('settings', () => {
    it('saves a user setting, overrides it for a project and inherits it back, from the keyboard', async () => {
      const userFile = path.join(home, 'home', 'config.json');
      const w = await open('#/settings/user');
      await pickOption(w.page, '#set-cadence', 'end');
      await w.page.waitForSelector('[data-msg="cadence"].here:text("saved")');
      expect(JSON.parse(fs.readFileSync(userFile, 'utf8')).cadence).toBe('end');
      // Focus stays on the control that was just used, rather than jumping to the top.
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('set-cadence-combo');

      await w.page.goto(base + '/' + `#/settings/project?project=${enc(fx.repo.mixed)}`); await ready(w.page);
      expect(await w.page.textContent('#view')).toContain('inherited from user settings');
      await pickOption(w.page, '#set-cadence', 'as-you-go');
      await w.page.waitForSelector('[data-unset="cadence"]');
      // A global-only key is shown, not editable, on a project.
      expect(await w.page.isDisabled('#set-telemetry')).toBe(true);
      await w.page.focus('[data-unset="cadence"]');
      await w.page.keyboard.press('Enter');
      await w.page.waitForSelector('[data-msg="cadence"]:text("inherited")');
      expect(await w.page.inputValue('#set-cadence')).toBe('end');

      // An out-of-range number is refused in the page, under the field, before any request.
      const posts: string[] = [];
      w.page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()); });
      await w.page.fill('#set-max_questions_per_task', '99');
      await w.page.press('#set-max_questions_per_task', 'Enter');
      await w.page.waitForSelector('#set-max_questions_per_task-e:visible');
      expect(await w.page.textContent('#set-max_questions_per_task-e')).toBe('max_questions_per_task is a whole number from 1 to 10.');
      expect(await w.page.getAttribute('#set-max_questions_per_task', 'aria-invalid')).toBe('true');
      expect(await w.page.getAttribute('#set-max_questions_per_task', 'aria-describedby')).toContain('set-max_questions_per_task-e');
      expect(await w.page.inputValue('#set-max_questions_per_task')).toBe('99'); // the typed value stays
      expect(posts).toEqual([]);
      // Only the server knows the combination: its refusal lands in the same place.
      await w.page.uncheck('#set-quiz-enabled');
      await w.page.waitForSelector('[data-msg="quiz.enabled"]:text("saved")');
      await w.page.check('#set-quiz-enforced');
      await w.page.waitForSelector('#set-quiz-enforced-e:visible');
      expect(await w.page.textContent('#set-quiz-enforced-e')).toMatch(/no effect while quiz.enabled is false/);
      // A refused switch is put back to what is on disk, not left showing a value nobody saved.
      expect(await w.page.isChecked('#set-quiz-enforced')).toBe(false);

      await w.page.goto(base + '/#/settings/user'); await ready(w.page);
      await w.page.click('[data-unset="cadence"]');
      await w.page.waitForSelector('[data-msg="cadence"]:text("inherited")');
      expect(JSON.parse(fs.readFileSync(userFile, 'utf8')).cadence).toBeUndefined();
      // The one refusal above is a 400 the browser logs; nothing else may be.
      expect(w.errors.filter((e) => !/status of 400/.test(e))).toEqual([]);
      await w.ctx.close();
    }, 60000);
  });

  describe('tips', { timeout: 12000 }, () => {
    /** Test-only tips: `window.__eklavyaTestTips` stands in for TIPS when set. */
    const tips = (list: object[]) => `window.__eklavyaTestTips = ${JSON.stringify(list)};`;
    const ONE = { id: 't-one', where: ['learning/dashboard'], el: '#wf-caret', title: 'One', text: 'The first tip.', side: 'right' };
    const TWO = { id: 't-two', where: ['learning/dashboard'], el: '#view details.about > summary', title: 'Two', text: 'The second tip.' };
    const bubble = '.driver-popover.coach';
    const beacons = (page: Page) => page.$$eval('.driver-hint:not(.driver-hint-hidden)', (b) => b.map((x) => x.getAttribute('aria-label')));
    const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('eklavya-dash-tips') ?? 'null'));
    const bubbles = (page: Page) => page.locator(bubble).count();
    /** Under the block's 12s, so a stall fails on the step that stalled. */
    const WAIT = { timeout: 5000 };

    it('opens the first tip by itself once, and marks every other tip with a beacon', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.textContent(bubble)).toContain('Tip: The first tip.');
      expect(await w.page.getAttribute(`${bubble}`, 'role')).toBe('dialog');
      expect(await beacons(w.page)).toEqual(['One', 'Two']);
      // Opening by itself does not take focus from the reader.
      expect(await w.page.evaluate(() => document.activeElement === document.body)).toBe(true);
      expect((await stored(w.page)).opened).toEqual(['t-one']);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('Got it dismisses for good', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.click(`${bubble} .driver-popover-next-btn`);
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual(['Two']);
      expect((await stored(w.page)).done).toEqual(['t-one']);
      await w.page.reload(); await ready(w.page);
      // The next tip opens by itself now; the dismissed one never comes back.
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.textContent(bubble)).toContain('The second tip.');
      expect(await beacons(w.page)).toEqual(['Two']);
      await w.ctx.close();
    });

    it('× and Escape close the bubble and keep the beacon, which reopens it', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.keyboard.press('Escape');
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual(['One', 'Two']);
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('One');
      // Enter on the focused beacon reopens it, focus goes in, and the × closes it back to the beacon.
      await w.page.keyboard.press('Enter');
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('Close');
      await w.page.keyboard.press('Tab');
      expect(await w.page.evaluate(() => document.activeElement?.textContent)).toBe('Got it');
      await w.page.click(`${bubble} .coach__x`);
      expect(await bubbles(w.page)).toBe(0);
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe('One');
      // Only the screen's first tip opens by itself, once: the second stays a beacon.
      await w.page.reload(); await ready(w.page);
      await w.page.waitForTimeout(900);
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual(['One', 'Two']);
      await w.page.click('.driver-hint[aria-label="One"]');
      await w.page.waitForSelector(bubble, WAIT);
      expect(await stored(w.page)).toMatchObject({ off: false, done: [], opened: ['t-one'] });
      await w.ctx.close();
    });

    it('using the feature dismisses its tip', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.click('#view details.about > summary');
      expect(await w.page.evaluate(() => (document.querySelector('#view details.about') as HTMLDetailsElement).open)).toBe(true);
      expect(await beacons(w.page)).toEqual(['One']);
      expect((await stored(w.page)).done).toEqual(['t-two']);
      await w.ctx.close();
    });

    it('closes the bubble on navigation, and never shows two', async () => {
      const THREE = { id: 't-three', where: ['learning/concepts'], el: '#chips', title: 'Three', text: 'The third tip.' };
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO, THREE]) });
      await w.page.waitForSelector(bubble, WAIT);
      // Opening another closes the first: one bubble at a time.
      await w.page.keyboard.press('Escape');
      await w.page.click('.driver-hint[aria-label="Two"]');
      expect(await w.page.textContent(bubble)).toContain('The second tip.');
      await w.page.evaluate("TIP.hints.open('t-one')");
      expect(await bubbles(w.page)).toBe(1);
      expect(await w.page.textContent(bubble)).toContain('The first tip.');
      await w.page.click('#nav a[data-nav="concepts"]');
      await w.page.waitForFunction(() => document.documentElement.dataset.rendered === '#/learning/concepts', null, WAIT);
      expect(await bubbles(w.page)).toBe(0);
      await w.page.waitForSelector(bubble, WAIT);
      expect(await bubbles(w.page)).toBe(1);
      expect(await w.page.textContent(bubble)).toContain('The third tip.');
      expect(await beacons(w.page)).toEqual(['Three']);
      await w.ctx.close();
    });

    it('the sidebar switch hides every tip, and on starts them over', async () => {
      const w = await open('#/learning/dashboard', { tips: true, init: tips([ONE, TWO]) });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.click(`${bubble} .driver-popover-next-btn`);
      await w.page.click('[data-tips="off"]');
      expect(await w.page.getAttribute('[data-tips="off"]', 'aria-pressed')).toBe('true');
      expect(await beacons(w.page)).toEqual([]);
      for (const h of ['#/learning/concepts', '#/learning/dashboard']) {
        await w.page.goto(base + '/' + h); await ready(w.page);
        await w.page.waitForTimeout(700);
        expect(await beacons(w.page), h).toEqual([]);
        expect(await bubbles(w.page), h).toBe(0);
      }
      expect(await w.page.getAttribute('[data-tips="off"]', 'aria-pressed')).toBe('true');
      await w.page.click('[data-tips="on"]');
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.textContent(bubble)).toContain('The first tip.');
      expect(await beacons(w.page)).toEqual(['One', 'Two']);
      await w.ctx.close();
    });

    it('shows nothing when storage throws, and treats malformed storage as fresh', async () => {
      const w = await open('#/learning/dashboard', {
        tips: true, init: tips([ONE]) + `Storage.prototype.getItem = function () { throw new DOMException('denied', 'SecurityError'); };`,
      });
      await w.page.waitForTimeout(900);
      expect(await beacons(w.page)).toEqual([]);
      expect(await bubbles(w.page)).toBe(0);
      await w.page.click('[data-tips="on"]');
      expect(await beacons(w.page)).toEqual([]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
      const m = await open('#/learning/dashboard', { tips: true, init: tips([ONE]) + `localStorage.setItem('eklavya-dash-tips', '{nope');` });
      await m.page.waitForSelector(bubble, WAIT);
      expect(m.errors).toEqual([]);
      await m.ctx.close();
    });

    it('shows no tip over the correction dialog', async () => {
      const w = await open(`#/artifacts/view/${enc(fix.other)}`, {
        tips: true, init: tips([{ id: 't-tabs', where: ['artifacts/view'], el: '#view [role="tablist"]', title: 'Tabs', text: 'Open pages.' }]),
      });
      await w.page.waitForSelector(bubble, WAIT);
      await w.page.waitForSelector('#fix-open', WAIT);
      await w.page.click('#fix-open');
      expect(await w.page.evaluate(() => (document.getElementById('fix') as HTMLDialogElement).open)).toBe(true);
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual([]);
      await w.page.keyboard.press('Escape');
      await expect.poll(() => beacons(w.page)).toEqual(['Tabs']);
      await w.ctx.close();
    });

    // The registry guard: what makes "add a row to TIPS" safe. A typo in a
    // selector, a page that does not exist or a reused id fails here.
    it('every tip in TIPS is well formed and points at a real feature on its pages', async () => {
      const w = await open('#/learning/dashboard', { tips: true });
      const list = await w.page.evaluate('TIPS.map((t) => ({ ...t, when: !!t.when }))') as { id: string; where: string[]; el: string; title: string; text: string; side?: string; when: boolean }[];
      const pages = await w.page.evaluate('Object.fromEntries(Object.entries(WORKFLOWS).map(([k, W]) => [k, Object.keys(W.pages)]))') as Record<string, string[]>;
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((t) => t.id)).size).toBe(list.length);
      // A detail page needs a parameter to open.
      const PARAM: Record<string, string> = { 'artifacts/view': enc(fix.other) };
      for (const t of list) {
        expect(t.id, t.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
        expect(t.title.length, t.id).toBeLessThanOrEqual(32);
        expect(t.text.length, t.id).toBeLessThanOrEqual(140);
        expect(t.text, t.id).not.toMatch(/click here|\p{Extended_Pictographic}/iu);
        expect(['top', 'right', 'bottom', 'left', undefined], t.id).toContain(t.side);
        expect(t.where.length, t.id).toBeGreaterThan(0);
        for (const where of t.where) {
          const [wf, pg] = where.split('/');
          expect(pages[wf!] ?? [], `${t.id}: ${where}`).toContain(pg);
          await w.page.goto(`${base}/#/${where}${PARAM[where] ? '/' + PARAM[where] : ''}`); await ready(w.page);
          if (t.when && !(await w.page.evaluate(`TIPS.find((t) => t.id === ${JSON.stringify(t.id)}).when()`))) continue;
          const rendered = await w.page.evaluate((sel) => !!document.querySelector(sel)?.getClientRects().length, t.el);
          expect(rendered, `${t.id}: ${t.el} on ${where}`).toBe(true);
        }
      }
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);

    it('on a phone, leaves out tips whose feature is in the closed drawer', async () => {
      const w = await open('#/learning/dashboard', { tips: true, width: 560, height: 800 });
      await w.page.waitForSelector(bubble, WAIT);
      expect(await w.page.textContent(bubble)).toContain('Every page explains');
      expect(await beacons(w.page)).toEqual(['How this works']);
      // Closing the drawer slides the rail away; its features stay out while it moves.
      await w.page.keyboard.press('Escape');
      await w.page.click('#menu');
      await w.page.keyboard.press('Escape');
      await w.page.waitForTimeout(900);
      expect(await beacons(w.page)).toEqual(['How this works']);
      expect(await bubbles(w.page)).toBe(0);
      await w.ctx.close();
    });

    it('waits behind the drawer, and fits a phone', async () => {
      // The drawer opens before the first render: opened after `open()` returns,
      // it races the tip's own 600ms timer, and a tip that already opened by
      // itself rightly stays a beacon once the drawer closes.
      const w = await open('#/learning/dashboard', {
        tips: true, width: 560, height: 800,
        init: tips([TWO]) + `document.addEventListener('DOMContentLoaded', () => document.getElementById('menu').click());`,
      });
      expect(await w.page.getAttribute('#menu', 'aria-expanded')).toBe('true');
      await w.page.waitForTimeout(900);
      expect(await bubbles(w.page)).toBe(0);
      expect(await beacons(w.page)).toEqual([]);
      await w.page.keyboard.press('Escape');
      await w.page.waitForSelector(bubble, WAIT);
      const r = await w.page.$eval(bubble, (b) => { const x = b.getBoundingClientRect(); return { l: x.left, r: x.right, w: innerWidth }; });
      expect(r.l).toBeGreaterThanOrEqual(8);
      expect(r.r).toBeLessThanOrEqual(r.w - 8);
      await w.ctx.close();
    });
  });

  describe('every screen', () => {
    it('makes no outbound request, logs no error, and fits the width', async () => {
      const hashes = ['#/learning/dashboard', '#/learning/projects', '#/memory/dashboard', '#/memory/timeline',
        '#/memory/sessions', '#/memory/projects', '#/memory/health', `#/memory/entry/${fx.entries.mixed}`,
        '#/artifacts/dashboard', '#/artifacts/dashboard/explainer', '#/artifacts/dashboard/to-correct',
        `#/artifacts/view/${enc(fix.other)}`, '#/artifacts/projects',
        '#/settings/dashboard', '#/settings/user', `#/settings/project?project=${enc(fx.repo.mixed)}`];
      for (const width of [1280, 900, 560, 390]) {
        for (const ground of ['ink', 'paper'] as const) {
          const w = await open(hashes[0]!, { width, ground, tips: true });
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
        tips: true,
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
      const options = await w.page.$$eval('#proj-menu [role="option"]', (o) => o.map((x) => x.textContent!.trim()));
      for (const name of ['logged', 'memory-only', 'pending', 'answered', 'mixed', 'client/api', 'server/api',
        'retired (checkout gone)', 'No repository', 'Unattributed']) {
        expect(options, name).toContain(name);
      }
      // Worktrees fold into their checkout; they are not projects of their own.
      expect(options.filter((o) => o?.startsWith('mixed'))).toEqual(['mixed']);
      await w.ctx.close();
    });

    it('opens the project listbox from the keyboard and scopes the URL', async () => {
      const w = await open('#/learning/dashboard');
      await w.page.focus('#proj');
      await w.page.keyboard.press('ArrowDown');
      expect(await w.page.getAttribute('#proj', 'aria-expanded')).toBe('true');
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('data-value'))).toBe('');
      await w.page.keyboard.press('End');
      expect(await w.page.evaluate(() => document.activeElement === [...document.querySelectorAll('#proj-menu [role="option"]')].at(-1))).toBe(true);
      await w.page.keyboard.press('Home');
      await w.page.keyboard.press('ArrowDown');
      const second = (await w.page.evaluate(() => document.activeElement?.getAttribute('data-value')))!;
      await w.page.keyboard.press('Enter');
      // Compared decoded: the page writes `~` as %7E, which encodeURIComponent leaves alone.
      await w.page.waitForFunction((id) => location.hash.startsWith('#/learning/dashboard?')
        && new URLSearchParams(location.hash.split('?')[1]).get('project') === id, second);
      await ready(w.page);
      expect(await projValue(w.page)).toBe(second);
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('proj');
      // Escape closes without choosing; an outside click closes too.
      await w.page.keyboard.press('ArrowDown');
      await w.page.keyboard.press('Escape');
      expect(await w.page.isHidden('#proj-menu')).toBe(true);
      await w.page.click('#proj');
      await w.page.mouse.click(900, 400);
      expect(await w.page.isHidden('#proj-menu')).toBe(true);
      // Inside the viewport, even on a phone-sized window.
      await w.page.setViewportSize({ width: 390, height: 500 });
      await w.page.click('#menu');
      await w.page.click('#proj');
      const box = (await w.page.locator('#proj-menu').boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(500);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('leaves no native dropdown on screen: every select has a combo standing in', async () => {
      for (const hash of ['#/memory/timeline', '#/learning/concepts', '#/settings/user']) {
        const w = await open(hash);
        const r = await w.page.evaluate(() => [...document.querySelectorAll('#view select')].map((s) => ({
          id: s.id,
          shown: (s as HTMLElement).offsetParent !== null,
          combo: !!document.getElementById(`${s.id}-combo`)?.matches('[role="combobox"]'),
        })));
        expect(r.length, hash).toBeGreaterThan(0);
        expect(r.filter((s) => s.shown || !s.combo), hash).toEqual([]);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }
    });

    it('changes a settings dropdown from the keyboard and keeps focus on it', async () => {
      const userFile = path.join(home, 'home', 'config.json');
      const w = await open('#/settings/user');
      expect(await w.page.getAttribute('#set-difficulty-combo', 'aria-label')).toBeTruthy();
      await w.page.focus('#set-difficulty-combo');
      await w.page.keyboard.press('ArrowDown');
      expect(await w.page.isVisible('#sel-menu')).toBe(true);
      expect(await w.page.getAttribute('#set-difficulty-combo', 'aria-expanded')).toBe('true');
      await w.page.keyboard.press('Escape');
      expect(await w.page.isHidden('#sel-menu')).toBe(true);
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('set-difficulty-combo');
      await w.page.keyboard.press('Enter');
      await w.page.keyboard.press('End');
      await w.page.keyboard.press('Enter');
      await w.page.waitForSelector('[data-msg="difficulty"].here:text("saved")');
      expect(JSON.parse(fs.readFileSync(userFile, 'utf8')).difficulty).toBe('hard');
      expect(await w.page.textContent('#set-difficulty-combo')).toContain('hard');
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('set-difficulty-combo');
      await w.page.click('[data-unset="difficulty"]');
      await w.page.waitForSelector('[data-msg="difficulty"]:text("inherited")');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 30000);

    it('shows the loader, not empty chrome, until the data lands', async () => {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const page = await ctx.newPage();
      let release = () => {};
      const held = new Promise<void>((r) => { release = r; });
      await page.route('**/api/projects', async (route) => { await held; await route.continue(); });
      await page.goto(base + '/#/learning/dashboard');
      await page.waitForSelector('#view .loader[role="status"]');
      expect(await page.getAttribute('#view', 'aria-busy')).toBe('true');
      expect(await page.isDisabled('#proj')).toBe(true);
      expect(await page.evaluate(() => getComputedStyle(document.getElementById('wf')!).visibility)).toBe('hidden');
      release();
      await ready(page);
      expect(await page.getAttribute('#view', 'aria-busy')).toBeNull();
      expect(await page.isEnabled('#proj')).toBe(true);
      expect(await page.textContent('#proj-name')).toBe('All projects');
      await ctx.close();
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
