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
import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright-core';
import { afterAll, beforeAll } from 'vitest';
import { openDb, type DB } from '../src/db.js';
// The built server, so the page under test is the one `npm run build` ships.
import { createArtifact } from '../dist/artifacts.js';
import { startDashboard } from '../dist/dashboard.js';
import { gradeConcept } from '../src/store.js';
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
export type { Watched };

async function open(
  hash: string,
  opts: { width?: number; height?: number; init?: string; ground?: 'ink' | 'paper'; tips?: boolean; tz?: string; now?: string } = {},
): Promise<Watched> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 }, ...(opts.tz ? { timezoneId: opts.tz } : {}) });
  // Tips are switched off unless a test is about them, so a bubble never sits on what a test clicks.
  if (!opts.tips) await ctx.addInitScript(() => { try { localStorage.getItem('eklavya-dash-tips') ?? localStorage.setItem('eklavya-dash-tips', '{"off":true}'); } catch { /* the framed page */ } });
  // Init scripts run in every frame, and the viewer's sandboxed frame has no storage.
  if (opts.ground) await ctx.addInitScript((g) => { try { localStorage.setItem('eklavya-ground', g); } catch { /* the framed page */ } }, opts.ground);
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  if (opts.now) await page.clock.setFixedTime(opts.now);
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
// Vitest isolates modules per file, so each browser suite gets its own DB,
// browser and ephemeral server port while sharing the fixture implementation.
export { OPTS, home, db, fx, base, fix, KEY, browser, open, ready, screen, enc, projValue, pickProject, pickOption };
