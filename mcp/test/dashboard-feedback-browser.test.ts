/**
 * The Feedback workflow in a real browser: the badge on every workflow, the
 * rule on every state, Acknowledge and Delete, and the promise that looking at
 * an item never acknowledges it. Needs the same Chromium as the main browser
 * suite and skips the same way.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { openDb, type DB } from '../src/db.js';
import { startDashboard } from '../dist/dashboard.js';
import { acknowledgeFeedback, insertFeedback, type NewFeedback } from '../src/feedback.js';

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
  if (process.env.CI) throw new Error('dashboard-feedback-browser: no Chromium available on CI');
  console.warn('dashboard-feedback-browser: no Chromium found, skipping');
}

/** The page's tips registry, a top-level const of its script. */
declare const TIPS: unknown;

let root = '';
let home = '';
let db: DB;
let base = '';
let closeServer = () => {};
let browser: Browser;
const savedHome = process.env.EKLAVYA_HOME;
const savedEnv = { EKLAVYA_TELEMETRY: process.env.EKLAVYA_TELEMETRY, DO_NOT_TRACK: process.env.DO_NOT_TRACK };

beforeAll(async () => {
  if (!OPTS) return;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'eklavya-dash-fb-'));
  home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.EKLAVYA_HOME = home;
  // The counts these tests read are skipped while the usage ping is off.
  delete process.env.EKLAVYA_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  db = openDb(path.join(root, 'knowledge.db'));
  const srv = await startDashboard(db as any, { port: 0 });
  base = srv.url;
  closeServer = srv.close;
  browser = await chromium.launch({ headless: true, ...OPTS });
}, 60000);

afterAll(async () => {
  if (!OPTS) return;
  await browser?.close();
  closeServer();
  db?.close();
  if (savedHome === undefined) delete process.env.EKLAVYA_HOME;
  else process.env.EKLAVYA_HOME = savedHome;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  if (!OPTS) return;
  db.exec("DELETE FROM feedback_items; DELETE FROM feedback_reviewed; DELETE FROM usage_counts WHERE name LIKE 'feedback:%'");
  fs.rmSync(path.join(home, 'config.json'), { force: true });
});

const ON = { feedback: { enabled: true }, providers: { observer: { kind: 'anthropic', model: 'm' } } };
const configure = (c: Record<string, unknown>) => fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(c));
const PROMPT = 'fix the login bug please, users cannot sign in <b>now</b>';
const item = (over: Partial<NewFeedback> = {}): NewFeedback => ({
  session_id: 's1',
  project: '/work/app',
  event_id: null,
  prompt: PROMPT,
  review: { worked: 'You named the bug.', gaps: [{ area: 'context', missing: 'No file or expected behaviour.' }, { area: 'check', missing: 'No test named.', evidence: 'run the tests again' }] } as never,
  better: 'Fix the login bug in [the file]; it should [expected behaviour].',
  tips: ['Say what fixed looks like before asking.', 'Name the file.'],
  model: 'sonnet',
  ...over,
});
const pending = () => insertFeedback(db, item())!;
const acknowledged = (over: Partial<NewFeedback> = {}) => {
  const id = insertFeedback(db, item(over))!;
  acknowledgeFeedback(db, id);
  return id;
};
const state = (page: Page) => page.evaluate(() => fetch('/api/state').then((r) => r.json()).then((s) => s.feedback));
const acks = () => (db.prepare('SELECT COUNT(*) AS n FROM feedback_items WHERE acknowledged_at IS NOT NULL').get() as { n: number }).n;

interface Watched { page: Page; ctx: BrowserContext; errors: string[]; outbound: string[] }
async function open(hash: string, opts: { width?: number; ground?: 'ink' | 'paper' } = {}): Promise<Watched> {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1280, height: 900 } });
  await ctx.addInitScript(() => { try { localStorage.getItem('eklavya-dash-tips') ?? localStorage.setItem('eklavya-dash-tips', '{"off":true}'); } catch { /* */ } });
  if (opts.ground) await ctx.addInitScript((g) => { try { localStorage.setItem('eklavya-ground', g); } catch { /* */ } }, opts.ground);
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
async function ready(page: Page) {
  await page.waitForFunction(() => document.documentElement.dataset.rendered === location.hash
    && !document.querySelector('.booting, #view .loader'));
}
const rule = (page: Page) => page.textContent('#fb-rule');

describe.skipIf(!OPTS)('the Feedback workflow', () => {
  describe('where you said it', () => {
    it('shows project, host, topic, time and a session link, escapes the topic, and fits a narrow screen', async () => {
      configure(ON);
      const ev = db.prepare(
        "INSERT INTO evidence_events (event_uid, project, checkout, session_id, host, kind, body, occurred_at) VALUES (?, '/work/app', '/work/app-wt/x', 's1', 'claude-code', 'prompt', ?, ?)",
      );
      const first = Number(ev.run('ctx1', 'refactor the <i>payment</i> client so it retries on timeout', '2026-10-01T10:00:00Z').lastInsertRowid);
      pending();
      db.prepare('UPDATE feedback_items SET event_id = ?').run(first);
      for (const width of [1280, 560]) {
        const w = await open('#/feedback/dashboard', { width });
        const text = (await w.page.textContent('.fb__ctx'))!;
        expect(text).toContain('/work/app');
        expect(text).toContain('/work/app-wt/x');
        expect(text).toContain('claude-code');
        expect(text).toContain('refactor the <i>payment</i> client');
        expect(await w.page.locator('.fb__ctx i').count()).toBe(0);
        expect(await w.page.getAttribute('.fb__ctx a', 'data-go')).toBe('#/memory/session/s1');
        expect(await w.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${width}px`).toBe(true);
        expect(w.errors).toEqual([]);
        await w.ctx.close();
      }
      db.exec('DELETE FROM evidence_events');
    });

    it('still opens an item whose events are gone, with only the rows it can fill', async () => {
      configure(ON);
      const id = acknowledged();
      const w = await open(`#/feedback/item/${id}`);
      expect(await w.page.textContent('.fb__ctx')).toContain('/work/app');
      expect(await w.page.locator('.fb__ctx dt', { hasText: 'About' }).count()).toBe(0);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });
  });

  describe('the badge', () => {
    it('shows a count and a name on every workflow while an item is pending, and nothing when none is', async () => {
      configure(ON);
      pending();
      for (const hash of ['#/learning/dashboard', '#/memory/dashboard', '#/artifacts/dashboard', '#/settings/dashboard', '#/feedback/dashboard']) {
        const w = await open(hash);
        expect(await w.page.getAttribute('#wf-caret', 'aria-label'), hash).toBe('Switch workflow, 1 feedback unread');
        expect(await w.page.textContent('#wf-badge'), hash).toBe('1');
        expect(await w.page.isVisible('#wf-badge'), hash).toBe(true);
        expect(await w.page.getAttribute('#wf-badge', 'aria-hidden'), hash).toBe('true');
        await w.ctx.close();
      }
      db.exec('DELETE FROM feedback_items');
      const w = await open('#/learning/dashboard');
      expect(await w.page.getAttribute('#wf-caret', 'aria-label')).toBe('Switch workflow');
      expect(await w.page.isVisible('#wf-badge')).toBe(false);
      await w.ctx.close();
    });

    it('stays quiet while feedback is off, though the stored item can still be opened', async () => {
      configure({});
      pending();
      const w = await open('#/learning/dashboard');
      expect(await w.page.isVisible('#wf-badge')).toBe(false);
      expect(await w.page.getAttribute('#wf-caret', 'aria-label')).toBe('Switch workflow');
      await w.page.goto(base + '/#/feedback/dashboard'); await ready(w.page);
      expect(await w.page.textContent('.fb__quote')).toBe(PROMPT);
      await w.ctx.close();
    });

    it('names the picker entry, lists five workflows, and keeps the badge text visible', async () => {
      configure(ON);
      pending();
      const w = await open('#/learning/dashboard');
      await w.page.click('#wf-caret');
      const names = await w.page.$$eval('#wf-menu [role="menuitemradio"]', (els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent!.trim()));
      expect(names).toEqual(['Learning', 'Memory', 'Artifacts', 'Feedback, 1 unread', 'Settings']);
      expect(await w.page.textContent('#wf-menu [data-wf="feedback"] .badge')).toBe('1');
      expect(await w.page.getAttribute('#wf-menu [data-wf="feedback"] .badge', 'aria-hidden')).toBe('true');
      await w.page.click('#wf-menu [data-wf="feedback"]');
      await ready(w.page);
      expect(await w.page.evaluate(() => location.hash)).toMatch(/^#\/feedback\/dashboard/);
      await w.ctx.close();
    });

    it('is the attention role as a fill with --bg text, legible on both grounds', async () => {
      configure(ON);
      pending();
      for (const ground of ['ink', 'paper'] as const) {
        const w = await open('#/learning/dashboard', { ground });
        const c = await w.page.$eval('#wf-badge', (e) => {
          const cs = getComputedStyle(e);
          const root = getComputedStyle(document.documentElement);
          return { bg: cs.backgroundColor, ink: cs.color, warning: root.getPropertyValue('--warning').trim() };
        });
        expect(c.bg, ground).not.toBe(c.ink);
        expect(c.bg, ground).toMatch(/^rgb/);
        await w.ctx.close();
      }
    });
  });

  describe('the rule', () => {
    it('is on the page in every state, with the reason there is no item', async () => {
      const cases: [string, () => void, RegExp, RegExp][] = [
        ['off', () => configure({}), /^Eklavya reviews one prompt at a time\./, /Prompt feedback is off/],
        ['memory off', () => configure({ ...ON, memory: { enabled: false } }), /^Eklavya reviews one prompt at a time\./, /Prompt feedback needs memory\. Turn on memory\.enabled\./],
        ['no observer', () => configure({ feedback: { enabled: true } }), /^Eklavya reviews one prompt at a time\./, /Prompt feedback needs an observer model\. Run eklavya config set providers\.observer <model>\./],
        ['empty', () => configure(ON), /^Eklavya reviews one prompt at a time\./, /Nothing to review yet/],
        ['failed', () => { configure(ON); db.prepare("INSERT INTO feedback_reviewed (session_id, outcome) VALUES ('s', 'failed')").run(); }, /^Eklavya reviews/, /Couldn't review the last session\. It will try again at a later start\./],
      ];
      for (const [name, setup, ruleText, bodyText] of cases) {
        db.exec('DELETE FROM feedback_reviewed');
        setup();
        const w = await open('#/feedback/dashboard');
        expect(await rule(w.page), name).toMatch(ruleText);
        expect(await w.page.textContent('#view'), name).toMatch(bodyText);
        expect(w.errors, name).toEqual([]);
        await w.ctx.close();
      }
      configure(ON);
      pending();
      const w = await open('#/feedback/dashboard');
      expect(await w.page.textContent('.fb__decide .fb__dp')).toBe('The next review waits until you acknowledge this one. It moves to History.');
      await w.ctx.close();
    });

    it('links the off state to Settings, and shows the observer command with Copy', async () => {
      configure({});
      let w = await open('#/feedback/dashboard');
      await w.page.click('#fb-empty a.btn');
      await ready(w.page);
      expect(await w.page.evaluate(() => location.hash)).toMatch(/^#\/settings\/user/);
      await w.ctx.close();
      configure({ feedback: { enabled: true } });
      w = await open('#/feedback/dashboard');
      expect(await w.page.textContent('#fb-empty code')).toContain('eklavya config set providers.observer');
      expect(await w.page.isVisible('#fb-empty [data-copy]')).toBe(true);
      await w.ctx.close();
    });

    it('sits once beside Acknowledge for every pending item, and the banner only says it when nothing waits', async () => {
      const RULE = 'The next review waits until you acknowledge this one.';
      configure(ON);
      for (const setup of [() => pending(), () => { acknowledged({ session_id: 'earlier' }); pending(); }]) {
        db.exec('DELETE FROM feedback_items');
        setup();
        const w = await open('#/feedback/dashboard');
        expect(await w.page.locator('.fb__rule').count()).toBe(0);
        expect(await w.page.locator('.fb__decide', { hasText: RULE }).count()).toBe(1);
        expect((await w.page.textContent('.fb__story'))!).not.toContain(RULE);
        await w.ctx.close();
      }
    });
  });

  describe('an item', () => {
    it('shows the prompt, a better one, what worked, what it left out and the tips, escaped', async () => {
      configure(ON);
      pending();
      const w = await open('#/feedback/dashboard');
      expect(await w.page.textContent('.fb__quote')).toBe(PROMPT);
      expect(await w.page.locator('.fb__quote b').count()).toBe(0);
      expect(await w.page.textContent('.cmd--block code')).toContain('[the file]');
      expect(await w.page.textContent('.fb')).toContain('You named the bug.');
      // As a screen reader hears it: the visible "You, later" label is hidden from it, and says the same thing.
      const rows = await w.page.$$eval('.fb__ds li', (els) => els.map((e) => {
        const c = e.cloneNode(true) as HTMLElement;
        c.querySelectorAll('[aria-hidden="true"]').forEach((x) => x.remove());
        return c.textContent!.replace(/\s+/g, ' ').trim();
      }));
      expect(rows).toEqual([
        'Context files, systems, prior facts No file or expected behaviour.',
        'Check how the agent proves it worked No test named. You said later: run the tests again',
      ]);
      expect(await w.page.textContent('.fb__ds q')).toBe('run the tests again');
      expect(await w.page.$eval('.fb__ds q', (q) => getComputedStyle(q).quotes)).toBe('"“" "”"');
      expect(await w.page.locator('.fb__tips li').count()).toBe(2);
      // Each [placeholder] is marked, escaped first; the caption says why.
      expect(await w.page.$$eval('mark.fb__ph', (m) => m.map((x) => x.textContent))).toEqual(['[the file]', '[expected behaviour]']);
      expect(await w.page.textContent('.fb__better')).toContain('Highlighted: details only you know.');
      await w.ctx.close();
    });

    it('states the verdict from the gap areas, never a number, for no gaps, one and three', async () => {
      configure(ON);
      const cases: [unknown[], string][] = [
        [[], 'Nothing here left the agent guessing.'],
        [[{ area: 'scope', missing: 'x' }], 'The agent had to guess the scope.'],
        [[{ area: 'check', missing: 'x' }, { area: 'outcome', missing: 'y' }, { area: 'context', missing: 'z' }], 'The agent had to guess the check, the outcome and the context.'],
      ];
      for (const [gaps, head] of cases) {
        db.exec('DELETE FROM feedback_items');
        insertFeedback(db, item({ review: { worked: 'ok', gaps } as never }));
        const w = await open('#/feedback/dashboard');
        expect(await w.page.textContent('.fb__verdict h2')).toBe(head);
        expect(await w.page.locator('.fb__vs').count()).toBe(gaps.length ? 1 : 0);
        expect(await w.page.getAttribute('.fb__verdict eklavya-mascot', 'state')).toBe(gaps.length ? 'review' : 'complete');
        // With no prompted_at there is no date, so no digit at all.
        expect(await w.page.textContent('.fb__verdict')).not.toMatch(/\d/);
        await w.ctx.close();
      }
    });

    it('reads the coverage strip from the review areas, and says "Not flagged" where an older review said nothing', async () => {
      configure(ON);
      const strip = (page: Page) => page.$$eval('.fb__cover [role="listitem"]', (els) => els.map((e) => e.textContent!.replace(/\s+/g, ' ').trim()));
      insertFeedback(db, item({ review: { worked: 'ok', gaps: [{ area: 'context', missing: 'x' }], areas: { outcome: 'clear', context: 'left_out', scope: 'not_needed', check: 'left_out' } } }));
      let w = await open('#/feedback/dashboard');
      expect(await strip(w.page)).toEqual(['Outcome Clear', 'Context Left out', 'Scope Not needed', 'Check Left out']);
      expect(await w.page.getAttribute('.fb__cover', 'aria-label')).toBe('What the prompt covered');
      await w.ctx.close();
      db.exec('DELETE FROM feedback_items');
      pending();
      db.prepare('UPDATE feedback_items SET rubric = 2').run();
      w = await open('#/feedback/dashboard');
      expect(await strip(w.page)).toEqual(['Outcome Not flagged', 'Context Left out', 'Scope Not flagged', 'Check Left out']);
      await w.ctx.close();
    });

    it('clamps a long rewrite behind a toggle that keeps focus', async () => {
      configure(ON);
      insertFeedback(db, item({ better: 'Retry the call in [the file] on a timeout. '.repeat(20) }));
      const w = await open('#/feedback/dashboard');
      const t = w.page.locator('#fb-better-t');
      const short = (await t.boundingBox())!.height;
      await w.page.click('[data-fb-more="fb-better-t"]');
      expect(await w.page.getAttribute('[data-fb-more="fb-better-t"]', 'aria-expanded')).toBe('true');
      expect(await w.page.textContent('[data-fb-more="fb-better-t"]')).toBe('Show less');
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('data-fb-more'))).toBe('fb-better-t');
      await w.page.waitForFunction(() => document.getElementById('fb-better-t')!.style.maxHeight === 'none');
      expect((await t.boundingBox())!.height).toBeGreaterThan(short);
      await w.page.click('[data-fb-more="fb-better-t"]');
      expect(await w.page.getAttribute('[data-fb-more="fb-better-t"]', 'aria-expanded')).toBe('false');
      // Your own prompt is short here: no toggle.
      expect(await w.page.locator('[data-fb-more="fb-mine-t"]').count()).toBe(0);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('shows an item from before this review without its old notes', async () => {
      configure(ON);
      const id = pending();
      db.prepare(`UPDATE feedback_items SET review = '{"worked":"","gaps":[]}' WHERE id = ?`).run(id);
      const w = await open('#/feedback/dashboard');
      expect(await w.page.textContent('.fb__quote')).toBe(PROMPT);
      expect(await w.page.locator('.fb__ds').count()).toBe(0);
      expect(await w.page.locator('.fb__cover').count()).toBe(0);
      expect(await w.page.locator('.fb__worked').count()).toBe(0);
      expect(await w.page.textContent('.fb')).not.toContain('What worked');
      expect(await w.page.textContent('.fb__verdict')).toContain('An older review');
      expect(await w.page.locator('.fb__tips li').count()).toBe(2);
      await w.ctx.close();
    });

    it('copies the better prompt', async () => {
      configure(ON);
      pending();
      const w = await open('#/feedback/dashboard');
      await w.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await w.page.click('.fb__better [data-copy]');
      // The plain rewrite: the marks around its placeholders are not copied.
      expect(await w.page.evaluate(() => navigator.clipboard.readText())).toBe(item().better);
      expect(await w.page.textContent('#copy-live')).toBe('Command copied');
      await w.ctx.close();
    });

    it('is never acknowledged by looking: open, reload, open again, go Back', async () => {
      configure(ON);
      const id = pending();
      const w = await open('#/feedback/dashboard');
      await w.page.reload(); await ready(w.page);
      await w.page.goto(base + '/#/learning/dashboard'); await ready(w.page);
      await w.page.goBack(); await ready(w.page);
      const other = await w.ctx.newPage();
      await other.goto(base + `/#/feedback/item/${id}`);
      await ready(other);
      expect(await other.textContent('.fb__quote')).toBe(PROMPT);
      expect(await w.page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toMatch(/ack/i);
      expect(await state(w.page)).toMatchObject({ pending: { id }, acknowledged: 0 });
      expect(db.prepare('SELECT acknowledged_at FROM feedback_items').get()).toEqual({ acknowledged_at: null });
      await w.ctx.close();
    });
  });

  describe('Acknowledge', () => {
    it('clears the badge without a reload, announces it, moves focus to the heading and files it under History', async () => {
      configure(ON);
      const id = pending();
      const w = await open('#/feedback/dashboard');
      await w.page.evaluate(() => { (window as any).__same = true; });
      await w.page.click('[data-fb-ack]');
      await w.page.waitForFunction(() => document.getElementById('wf-badge')!.hidden);
      expect(await w.page.evaluate(() => (window as any).__same)).toBe(true);
      expect(await w.page.getAttribute('#wf-caret', 'aria-label')).toBe('Switch workflow');
      await w.page.waitForFunction(() => document.getElementById('fb-live')!.textContent!.length > 0);
      expect(await w.page.textContent('#fb-live')).toBe('Acknowledged. Feedback resumes at your next session.');
      expect(await w.page.getAttribute('#fb-live', 'role')).toBe('status');
      expect(await w.page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
      expect(await rule(w.page)).toMatch(/^Eklavya reviews one prompt at a time/);
      expect(acks()).toBe(1);
      await w.page.goto(base + '/#/feedback/history'); await ready(w.page);
      expect(await w.page.locator('#fb-rows tbody tr').count()).toBe(1);
      expect(await w.page.textContent('#fb-rows tbody tr')).toContain('fix the login bug');
      await w.page.click('#fb-rows tbody tr');
      await ready(w.page);
      expect(await w.page.evaluate(() => location.hash)).toBe(`#/feedback/item/${id}`);
      expect(await w.page.locator('[data-fb-ack]').count()).toBe(0);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('is operable by keyboard: Tab reaches it and Enter acknowledges once', async () => {
      configure(ON);
      pending();
      const w = await open('#/feedback/dashboard');
      let posts = 0;
      w.page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/feedback/acknowledge')) posts++; });
      let found = false;
      for (let i = 0; i < 60 && !found; i++) {
        await w.page.keyboard.press('Tab');
        found = await w.page.evaluate(() => document.activeElement?.hasAttribute('data-fb-ack') ?? false);
      }
      expect(found).toBe(true);
      await w.page.keyboard.press('Enter');
      await w.page.waitForFunction(() => document.getElementById('wf-badge')!.hidden);
      expect(posts).toBe(1);
      expect(acks()).toBe(1);
      await w.ctx.close();
    });

    it('reads the acknowledgement from another tab as already done and says so without an error', async () => {
      configure(ON);
      const id = pending();
      const w = await open('#/feedback/dashboard');
      acknowledgeFeedback(db, id);
      await w.page.click('[data-fb-ack]');
      await w.page.waitForFunction(() => document.getElementById('wf-badge')!.hidden);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });
  });

  describe('Delete', () => {
    it('asks inline, can be cancelled, then removes the item, clears the badge and leaves History alone', async () => {
      configure(ON);
      acknowledged({ session_id: 'earlier' });
      pending();
      const w = await open('#/feedback/dashboard');
      let dialogs = 0;
      w.page.on('dialog', (d) => { dialogs++; void d.dismiss(); });
      await w.page.click('[data-fb-del]');
      expect(await w.page.textContent('#fb-actions')).toContain('Delete this feedback for good?');
      expect(await w.page.evaluate(() => document.activeElement?.hasAttribute('data-fb-no'))).toBe(true);
      await w.page.click('[data-fb-no]');
      expect(await w.page.locator('[data-fb-del]').count()).toBe(1);
      expect(await w.page.evaluate(() => document.activeElement?.hasAttribute('data-fb-del'))).toBe(true);
      expect(acks()).toBe(1);
      await w.page.click('[data-fb-del]');
      await w.page.click('[data-fb-yes]');
      await w.page.waitForFunction(() => document.getElementById('wf-badge')!.hidden);
      expect(dialogs).toBe(0);
      expect(db.prepare('SELECT COUNT(*) AS n FROM feedback_items').get()).toEqual({ n: 1 });
      expect(acks()).toBe(1);
      await w.page.goto(base + '/#/feedback/history'); await ready(w.page);
      expect(await w.page.locator('#fb-rows tbody tr').count()).toBe(1);
      await w.ctx.close();
    });
  });

  describe('every Feedback screen', () => {
    it('makes no outbound request, logs no error and fits 1280, 900, 560 and 390 on both grounds', async () => {
      configure(ON);
      acknowledged({ session_id: 'earlier' });
      const id = pending();
      for (const width of [1280, 900, 560, 390]) {
        for (const ground of ['ink', 'paper'] as const) {
          const w = await open('#/feedback/dashboard', { width, ground });
          for (const h of ['#/feedback/dashboard', '#/feedback/history', `#/feedback/item/${id}`]) {
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

    it('stacks the prompts and gives full-width 44px buttons at 560px', async () => {
      configure(ON);
      pending();
      const w = await open('#/feedback/dashboard', { width: 560 });
      const cols = await w.page.$eval('.fb__grid', (e) => getComputedStyle(e).gridTemplateColumns.split(' ').length);
      expect(cols).toBe(1);
      // The verdict first, and the rail after the story.
      expect(await w.page.evaluate(() => document.querySelector('.fb__verdict')!.getBoundingClientRect().top
        < document.querySelector('.fb__rail')!.getBoundingClientRect().top
        && document.querySelector('.fb__tips')!.getBoundingClientRect().bottom < document.querySelector('.fb__ctx')!.getBoundingClientRect().top)).toBe(true);
      // The visible Acknowledge is the bar's; Delete stays in the rail card.
      for (const sel of ['[data-fb-ack]:visible', '.fb__decide [data-fb-del]']) {
        const box = (await w.page.locator(sel).boundingBox())!;
        expect(box.height, sel).toBeGreaterThanOrEqual(44);
        expect(box.width, sel).toBeGreaterThan(400);
      }
      await w.ctx.close();
    });

    it('keeps Acknowledge in view at 1280px: the rail is sticky and still on screen at the tips', async () => {
      configure(ON);
      pending();
      const w = await open('#/feedback/dashboard');
      expect(await w.page.$eval('.fb__rail', (e) => getComputedStyle(e).position)).toBe('sticky');
      expect(await w.page.isVisible('.fb__bar')).toBe(false);
      await w.page.$eval('.fb__tips', (e) => e.scrollIntoView({ block: 'end', behavior: 'instant' }));
      const box = (await w.page.locator('.fb__decide [data-fb-ack]').boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(900);
      await w.ctx.close();
    });

    it('shows one Acknowledge at 800px, and pressing it holds both', async () => {
      configure(ON);
      pending();
      const w = await open('#/feedback/dashboard', { width: 800 });
      expect(await w.page.locator('[data-fb-ack]').count()).toBe(2);
      expect(await w.page.locator('[data-fb-ack]:visible').count()).toBe(1);
      expect(await w.page.getAttribute('.fb__bar', 'aria-label')).toBe('Acknowledge this feedback');
      let release = () => {};
      await w.page.route('**/api/feedback/acknowledge', (r) => new Promise<void>((done) => { release = () => { void r.continue(); done(); }; }));
      await w.page.click('[data-fb-ack]:visible');
      await w.page.waitForFunction(() => [...document.querySelectorAll('[data-fb-ack]')].every((b) => (b as HTMLButtonElement).disabled));
      release();
      await w.page.waitForFunction(() => document.getElementById('wf-badge')!.hidden);
      expect(acks()).toBe(1);
      await w.ctx.close();
    });

    it('shows no decision and no bar on an acknowledged item, and says when it was acknowledged', async () => {
      configure(ON);
      const id = acknowledged();
      for (const width of [1280, 800]) {
        const w = await open(`#/feedback/item/${id}`, { width });
        expect(await w.page.locator('.fb__decide, .fb__bar').count()).toBe(0);
        expect(await w.page.textContent('.fb__acked')).toMatch(/^Acknowledged /);
        await w.ctx.close();
      }
    });

    it('highlights History for an item page, and is a sidebar with Dashboard and History', async () => {
      configure(ON);
      const id = acknowledged();
      const w = await open(`#/feedback/item/${id}`);
      expect(await w.page.$$eval('#nav a[data-nav]', (a) => a.map((x) => x.getAttribute('data-nav')))).toEqual(['dashboard', 'history']);
      expect(await w.page.getAttribute('#nav [aria-current="page"]', 'data-nav')).toBe('history');
      expect(await w.page.textContent('#wf-main span')).toBe('Feedback');
      await w.ctx.close();
    });
  });

  describe('how the reader got there, counted', () => {
    const opened = () =>
      Object.fromEntries(
        (db.prepare("SELECT name, SUM(n) AS n FROM usage_counts WHERE name LIKE 'feedback:%' GROUP BY name").all() as { name: string; n: number }[]).map((r) => [r.name, r.n]),
      );
    /** The count is the server's, a moment after the page asks. */
    const settled = async (want: Record<string, number>) => {
      const same = () => JSON.stringify(Object.entries(opened()).sort()) === JSON.stringify(Object.entries(want).sort());
      for (let i = 0; i < 60 && !same(); i++) await new Promise((r) => setTimeout(r, 50));
      expect(opened()).toEqual(want);
    };

    it('counts the greeting link once and drops it from the URL, whatever re-renders', async () => {
      configure(ON);
      pending();
      const w = await open('#/feedback/dashboard?via=greeting');
      await settled({ 'feedback:opened_greeting': 1 });
      expect(await w.page.evaluate(() => location.hash)).toBe('#/feedback/dashboard');
      await w.page.setViewportSize({ width: 700, height: 900 });
      await w.page.setViewportSize({ width: 1280, height: 900 });
      await new Promise((r) => setTimeout(r, 400));
      expect(opened()).toEqual({ 'feedback:opened_greeting': 1 });
      await w.ctx.close();
    });

    it('counts the way in through the badge, and a typed link as direct', async () => {
      configure(ON);
      pending();
      let w = await open('#/learning/dashboard');
      await w.page.click('#wf-caret');
      await w.page.click('#wf-menu [data-wf="feedback"]');
      await ready(w.page);
      await settled({ 'feedback:opened_badge': 1 });
      expect(await w.page.evaluate(() => location.hash)).toBe('#/feedback/dashboard');
      await w.ctx.close();
      w = await open('#/feedback/dashboard');
      await settled({ 'feedback:opened_badge': 1, 'feedback:opened_direct': 1 });
      await w.ctx.close();
    });

    it('keeps the other query keys when it drops via, and counts again after leaving and returning', async () => {
      configure(ON);
      pending();
      const w = await open('#/feedback/dashboard?via=greeting&project=x');
      await settled({ 'feedback:opened_greeting': 1 });
      expect(await w.page.evaluate(() => location.hash)).not.toContain('via=');
      await w.page.goto(base + '/#/feedback/history'); await ready(w.page);
      await w.page.goto(base + '/#/feedback/dashboard'); await ready(w.page);
      await settled({ 'feedback:opened_greeting': 1, 'feedback:opened_direct': 1 });
      await w.ctx.close();
    });

    it('counts nothing when no item is waiting', async () => {
      configure(ON);
      const w = await open('#/feedback/dashboard?via=greeting');
      await new Promise((r) => setTimeout(r, 400));
      expect(opened()).toEqual({});
      await w.ctx.close();
    });
  });

  describe('the "Found a problem" card', () => {
    const KEY = 'eklavya-dash-feedback-tip';
    const TEXT = 'Found a problem with Eklavya itself? Tell Claude File feedback for Eklavya; it shows you the issue before posting.';
    const states: [string, () => void][] = [
      ['off', () => configure({})],
      ['memory off', () => configure({ ...ON, memory: { enabled: false } })],
      ['no observer', () => configure({ feedback: { enabled: true } })],
      ['empty', () => configure(ON)],
      ['pending', () => { configure(ON); pending(); }],
    ];

    it('is on the page by default in all five states, with its words', async () => {
      for (const [name, setup] of states) {
        db.exec('DELETE FROM feedback_items');
        setup();
        const w = await open('#/feedback/dashboard');
        expect(await w.page.textContent('#fb-tip h2'), name).toBe('Found a problem with Eklavya?');
        expect(await w.page.textContent('#fb-tip p'), name).toBe(TEXT);
        expect(await w.page.textContent('#fb-tip code'), name).toBe('File feedback for Eklavya');
        expect(await w.page.textContent('#fb-tip button'), name).toBe('Dismiss');
        // Last, under everything else: of the page, or with an item, of its story column.
        expect(await w.page.evaluate(() => (document.querySelector('.fb__story')?.lastElementChild
          ?? document.querySelector('#view')!.lastElementChild!.previousElementSibling)!.id), name).toBe('fb-tip');
        await w.ctx.close();
      }
    });

    it('is information in place, not a tip bubble: it is not in the registry', async () => {
      configure(ON);
      const w = await open('#/feedback/dashboard');
      expect(await w.page.evaluate(() => (TIPS as { id: string; text: string }[]).some((x) => /feedback-tip|problem/.test(x.id)))).toBe(false);
      expect(await w.page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
      await w.ctx.close();
    });

    it('is dismissed for good by Dismiss, with focus on the heading, and survives a reload', async () => {
      configure(ON);
      const w = await open('#/feedback/dashboard');
      await w.page.click('#fb-tip button');
      expect(await w.page.locator('#fb-tip').count()).toBe(0);
      expect(await w.page.evaluate(() => document.activeElement?.tagName)).toBe('H1');
      expect(await w.page.evaluate((k) => localStorage.getItem(k), KEY)).toBe('1');
      await w.page.reload(); await ready(w.page);
      expect(await w.page.locator('#fb-tip').count()).toBe(0);
      await w.page.goto(base + '/#/feedback/history'); await ready(w.page);
      await w.page.goto(base + '/#/feedback/dashboard'); await ready(w.page);
      expect(await w.page.locator('#fb-tip').count()).toBe(0);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('stays shown when storage throws: this is information, not a nag', async () => {
      configure(ON);
      const w = await open('#/feedback/dashboard');
      await w.ctx.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });
      });
      await w.page.reload(); await ready(w.page);
      expect(await w.page.locator('#fb-tip').count()).toBe(1);
      // A press still does something this time, and nothing throws out of the page.
      await w.page.click('#fb-tip button');
      expect(await w.page.locator('#fb-tip').count()).toBe(0);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('is operable by keyboard', async () => {
      configure(ON);
      const w = await open('#/feedback/dashboard');
      let found = false;
      for (let i = 0; i < 60 && !found; i++) {
        await w.page.keyboard.press('Tab');
        found = await w.page.evaluate(() => document.activeElement?.closest('#fb-tip') !== null && document.activeElement?.tagName === 'BUTTON');
      }
      expect(found).toBe(true);
      await w.page.keyboard.press('Enter');
      expect(await w.page.locator('#fb-tip').count()).toBe(0);
      await w.ctx.close();
    });

    it('fits the width on both grounds at every size', async () => {
      configure(ON);
      for (const width of [1280, 900, 560, 390]) {
        for (const ground of ['ink', 'paper'] as const) {
          const w = await open('#/feedback/dashboard', { width, ground });
          const fits = await w.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
          expect(fits, `${width} ${ground}`).toBe(true);
          await w.ctx.close();
        }
      }
    }, 60000);
  });
});
