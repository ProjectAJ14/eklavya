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
  return open;
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

/* ---------- the page-transition probe ---------- */

/**
 * The heading block of a screen. The issue calls it `#view > .page__head`; the
 * page does not give it that class yet (`pageHead()` and the entry page emit an
 * unclassed `<div>` around their `h1.page__title`), so until it does the probe
 * holds that wrapper, and matches `.page__head` as well once it exists. One
 * constant, so the class arriving changes nothing else here. A screen whose
 * heading sits deeper (Settings draws inside `#settings`) has none to hold.
 */
export const PAGE_HEAD = '#view > .page__head, #view > :has(> h1.page__title)';

export interface ProbeOptions {
  /** Another element to hold across the action, by selector: it is looked up before and tested with `isConnected` after. */
  keep?: string;
  /** How long nothing may be pending before the page counts as settled. Default 150 ms. */
  quiet?: number;
  /** Give up, naming what was still pending, after this long. Default 30 s. */
  timeout?: number;
}

/** What one action did to the page, from just before it until the page settled. */
export interface ProbeReport {
  /** The URL the page settled on. */
  hash: string;
  /**
   * `#view` held a `.loader` at any point. Every mutation batch is inspected, so
   * a loader inserted and removed inside one task still counts, though no frame
   * ever showed it.
   */
  sawLoader: boolean;
  /** `#view`'s height before the action. */
  beforeHeight: number;
  /**
   * The lowest height `#view` took once it started changing (the first mutation
   * in it), against `finalHeight`, the height once settled. The old screen's
   * height is not part of it, so `minHeight < finalHeight` is a collapse.
   */
  minHeight: number;
  finalHeight: number;
  /** The distinct heights `#view` took after it started changing, in order. */
  heights: number[];
  /** The footer's top in document coordinates before the action, at its highest point (smallest top), and once settled. */
  footerBefore: number;
  footerMin: number;
  footerFinal: number;
  /** The footer moved up and then back down, each by more than a rounding error. */
  footerBounced: boolean;
  /** The `/api/*` requests the action made, path and query, in order. */
  requests: string[];
  scrollBefore: number;
  scrollAfter: number;
  /** The `PAGE_HEAD` element from before the action is still in the document. `null`: there was none to hold. */
  headKept: boolean | null;
  /** The same for `opts.keep`. `null`: no selector given, or nothing matched before the action. */
  keptSelector: boolean | null;
}

/** A footer that moves by this much or less between samples has not moved: it is rounding. */
const FOOT_NOISE = 2;
const STEP = 25;

/** Up by more than the noise, and then back down by more than it. */
export function footerBounces(tops: number[]): boolean {
  let up = false;
  for (let i = 1; i < tops.length; i++) {
    const d = tops[i]! - tops[i - 1]!;
    if (d < -FOOT_NOISE) up = true;
    else if (d > FOOT_NOISE && up) return true;
  }
  return false;
}

/**
 * Takes `action` (set `location.hash`, click a control) and reports what the
 * page did until it settled. See `ProbeReport` for each field.
 *
 * Settled is what a reader would call finished: the screen is drawn for the
 * URL (`data-rendered` equals the hash), nothing is booting or loading, the
 * scroll has stopped (the page scrolls smoothly), and no request is open, all
 * for `quiet` ms running. Every request counts, not only `/api/*`: a thumbnail
 * still arriving moves the layout. The live stream (`/api/events`, Phase 4) is
 * the one request that never ends and is not a wait. The open requests are the
 * page's own count, as in `ready()` and for the same reason: Playwright's
 * `networkidle` never fires again once the viewer's sandboxed frame has attached.
 *
 * The page must be settled before the action, and is waited for. The probe
 * reads and observes; it changes nothing in the page, and the same page can be
 * probed again. It is not a wall-clock measurement: nothing here is timed.
 */
export async function probeTransition(page: Page, action: () => Promise<unknown>, opts: ProbeOptions = {}): Promise<ProbeReport> {
  const quiet = opts.quiet ?? 150;
  const timeout = opts.timeout ?? 30000;
  const openNow = inflight.get(page) ?? track(page);
  const pending = () => [...openNow].filter((r) => new URL(r.url()).pathname !== '/api/events');
  const busy = () => page.evaluate(() => ({
    drawing: document.documentElement.dataset.rendered !== location.hash || !!document.querySelector('.booting, #view .loader'),
    scroll: window.scrollY,
  }));
  const settle = async () => {
    const start = Date.now();
    let since = 0;
    let scroll = NaN;
    for (;;) {
      const waiting = pending();
      const now = await busy();
      // A smooth scroll still on its way (the page sets `scroll-behavior: smooth`) is not settled either.
      const loading = now.drawing || now.scroll !== scroll;
      scroll = now.scroll;
      if (loading || waiting.length) since = 0;
      else if (!since) since = Date.now();
      else if (Date.now() - since >= quiet) return;
      if (Date.now() - start > timeout) {
        throw new Error(`probe: still not settled after ${timeout} ms: ${loading ? 'the page is drawing or scrolling; ' : ''}${waiting.map((r) => r.url()).join(', ')}`);
      }
      await new Promise((r) => setTimeout(r, STEP));
    }
  };

  const requests: string[] = [];
  const onRequest = (r: Request) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/')) requests.push(u.pathname + u.search);
  };

  await settle();
  await page.evaluate(([headSel, keepSel]) => {
    const w = window as any;
    w.__probe?.stop?.();
    const view = document.getElementById('view')!;
    const foot = document.querySelector('.foot')!;
    const footTop = () => Math.round(foot.getBoundingClientRect().top + window.scrollY);
    const st: any = {
      sawLoader: false, moving: false, done: false, raf: 0,
      before: view.offsetHeight, heights: [] as number[], foot: [footTop()], scrollBefore: window.scrollY,
      head: document.querySelector(headSel), keep: keepSel ? document.querySelector(keepSel) : null,
    };
    st.sample = () => {
      const t = footTop();
      if (t !== st.foot[st.foot.length - 1]) st.foot.push(t);
      if (!st.moving) return;
      const h = view.offsetHeight;
      if (h !== st.heights[st.heights.length - 1]) st.heights.push(h);
    };
    st.seen = (records: MutationRecord[]) => {
      st.moving = true;
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n instanceof Element && (n.matches('.loader') || n.querySelector('.loader'))) st.sawLoader = true;
        }
      }
      if (view.querySelector('.loader')) st.sawLoader = true;
      st.sample();
    };
    st.mo = new MutationObserver(st.seen);
    st.mo.observe(view, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-busy'] });
    st.stop = () => { st.done = true; cancelAnimationFrame(st.raf); st.mo.disconnect(); };
    const tick = () => { st.sample(); if (!st.done) st.raf = requestAnimationFrame(tick); };
    tick();
    w.__probe = st;
  }, [PAGE_HEAD, opts.keep ?? null]);

  page.on('request', onRequest);
  try {
    await action();
    await settle();
  } finally {
    page.off('request', onRequest);
  }
  const seen = await page.evaluate(() => {
    const w = window as any;
    const st = w.__probe;
    const view = document.getElementById('view')!;
    // Whatever the observer has not delivered yet is still a batch to inspect.
    const rest = st.mo.takeRecords();
    if (rest.length) st.seen(rest);
    st.stop();
    st.moving = true;
    st.sample();
    delete w.__probe;
    return {
      hash: location.hash, sawLoader: st.sawLoader as boolean, before: st.before as number, final: view.offsetHeight,
      heights: st.heights as number[], foot: st.foot as number[], scrollBefore: st.scrollBefore as number, scrollAfter: window.scrollY,
      headKept: st.head ? (st.head.isConnected as boolean) : null,
      keptSelector: st.keep ? (st.keep.isConnected as boolean) : null,
    };
  });
  return {
    hash: seen.hash,
    sawLoader: seen.sawLoader,
    beforeHeight: seen.before,
    minHeight: Math.min(...seen.heights, seen.final),
    finalHeight: seen.final,
    heights: seen.heights,
    footerBefore: seen.foot[0]!,
    footerMin: Math.min(...seen.foot),
    footerFinal: seen.foot[seen.foot.length - 1]!,
    footerBounced: footerBounces(seen.foot),
    requests,
    scrollBefore: seen.scrollBefore,
    scrollAfter: seen.scrollAfter,
    headKept: seen.headKept,
    keptSelector: seen.keptSelector,
  };
}

/** `before>final`, with the lowest point between them when it was lower than both. */
function footerCell(r: ProbeReport): string {
  if (r.footerBefore === r.footerFinal && r.footerMin === r.footerFinal) return `${r.footerFinal}`;
  const dipped = r.footerMin < Math.min(r.footerBefore, r.footerFinal) - FOOT_NOISE;
  return dipped ? `${r.footerBefore}>${r.footerMin}>${r.footerFinal}` : `${r.footerBefore}>${r.footerFinal}`;
}

/**
 * The report as a table, one row per probe, for a person to read. `label` is
 * whatever names the row; `scrub` rewrites what varies between runs (the
 * fixture's temporary folder) so two tables can be compared line by line.
 */
export function probeTable(rows: [label: string, r: ProbeReport][], scrub: (s: string) => string = (s) => s): string {
  const head = ['probe', 'loader', 'view min>final', 'footer', 'bounce', 'req', 'scroll', 'head kept', 'sel kept', 'requests'];
  const yn = (v: boolean | null) => (v === null ? '-' : v ? 'yes' : 'NO');
  const cells = rows.map(([label, r]) => [
    scrub(label),
    r.sawLoader ? 'LOADER' : '-',
    r.minHeight === r.finalHeight ? `${r.finalHeight}` : `${r.minHeight}>${r.finalHeight}`,
    footerCell(r),
    r.footerBounced ? 'BOUNCE' : '-',
    String(r.requests.length),
    r.scrollBefore === r.scrollAfter ? `${r.scrollAfter}` : `${r.scrollBefore}>${r.scrollAfter}`,
    yn(r.headKept),
    yn(r.keptSelector),
    scrub(r.requests.join(' ')),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i]!.length)));
  const line = (c: string[]) => c.map((v, i) => (i === c.length - 1 ? v : v.padEnd(widths[i]!))).join('  ').trimEnd();
  const legend = 'loader: #view held a .loader. view: its lowest and its settled height in px (one number: no collapse). footer: top before>lowest>settled, '
    + 'the lowest only when it dipped below both. head kept / sel kept: NO = the element held before the action is gone, - = none to hold. scroll: before>after.';
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line), '', legend].join('\n');
}

// Vitest isolates modules per file, so each browser suite gets its own DB,
// browser and ephemeral server port while sharing the fixture implementation.
export { OPTS, home, db, fx, base, fix, KEY, browser, open, ready, screen, enc, projValue, pickProject, pickOption };
