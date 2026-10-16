// Split by feature so Vitest's file sharding can divide the browser work.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import { OPTS, base, browser, enc, fx, home, open, projValue, ready } from './dashboard-browser-helpers.js';
/** Page globals the day tests call directly. */
declare function todayKey(): string;
declare function fromKey(k: string): Date;
declare function render(): void;
declare function adoptState(s: unknown, inv: unknown): void;
declare let S: { daily: unknown[]; concepts: unknown[]; logged: { slug: string }[] };
declare function inScope(repo: unknown, sid: unknown): boolean;
declare let INV: { projects: unknown[] };
declare const toast: any;
declare function ekDialog(o: unknown): Promise<{ ok: boolean; value: string }>;
declare function startCommand(concepts: unknown[]): { name: string; count: number; command: string; note: string }[];
declare function streaks(map: Map<string, { day: string; total: number }>): { current: number; best: number; days: number };

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('local days', () => {
    it("counts today in the learner's time zone, not UTC", async () => {
      // 19:30 UTC on the 3rd is 01:00 IST on the 4th: an answer then is today's.
      const w = await open('#/learning/dashboard', { tz: 'Asia/Kolkata', now: '2026-10-03T19:30:00Z' });
      expect(await w.page.evaluate(() => [todayKey(), streaks(new Map([['2026-10-04', { day: '2026-10-04', total: 1 }]])).current]))
        .toEqual(['2026-10-04', 1]);
      await w.ctx.close();
    });
  });

  describe('the streak card', () => {
    /** Replaces the payload's days with `[daysAgo, passed, corrected, missed]` rows and redraws. New data reaches the page through `adoptState`. */
    const days = (page: Page, rows: number[][]) => page.evaluate((rows) => {
      const key = (n: number) => { const d = fromKey(todayKey()); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
      const s = structuredClone(S);
      s.daily = rows.map(([n, passed, corrected, missed]) => ({ day: key(n!), repo: null, passed, corrected, missed, skipped: 0 }));
      adoptState(s, INV);
      render();
    }, rows);
    const card = (page: Page) => page.evaluate(() => {
      const c = document.querySelector('#view .streak')!;
      return {
        head: c.querySelector('h2')!.textContent!.trim(),
        best: c.querySelector('.streak__best')?.textContent!.replace(/\s+/g, ' ').trim() ?? null,
        sub: c.querySelector('.streak__sub')?.textContent!.trim() ?? null,
        run: c.querySelectorAll('rect.cell.is-run').length,
      };
    });

    it('sits right under the tiles, open, in place of the streak tile and the folded calendar', async () => {
      const w = await open('#/learning/dashboard');
      const placed = await w.page.evaluate(() => {
        const stats = document.querySelector('#view .stats')!;
        let n = stats.nextElementSibling;
        while (n && !n.classList.contains('card')) n = n.nextElementSibling;
        return {
          first: n?.classList.contains('streak'),
          tiles: stats.querySelectorAll('.tile').length,
          fold: !!document.querySelector('[data-fold="learn:heat"]'),
        };
      });
      expect(placed).toEqual({ first: true, tiles: 4, fold: false });
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('counts the current run and the longest one, and outlines the current run', async () => {
      const w = await open('#/learning/dashboard');
      await days(w.page, [[0, 1, 0, 0], [1, 1, 0, 0], [2, 0, 0, 1], ...[10, 11, 12, 13, 14].map((n) => [n, 1, 0, 0])]);
      expect(await card(w.page)).toEqual({ head: '3 day streak', best: 'Longest streak | 5 days', sub: null, run: 3 });
      expect(await w.page.$eval('#view rect.cell.is-run title', (t) => t.textContent)).toContain(' · current streak');
      await w.ctx.close();
    });

    it('asks for today when only yesterday is done, and says the longest when nothing is running', async () => {
      const w = await open('#/learning/dashboard');
      await days(w.page, [[1, 1, 0, 0], [2, 1, 0, 0], [3, 1, 0, 0]]);
      expect(await card(w.page)).toMatchObject({ head: '3 day streak', sub: 'Answer one today to make it 4.' });
      await days(w.page, [[0, 1, 0, 0]]);
      expect(await card(w.page)).toMatchObject({ head: '1 day streak', best: 'Longest streak | 1 day', sub: null });
      await days(w.page, [[5, 1, 0, 0], [6, 1, 0, 0]]);
      expect(await card(w.page)).toMatchObject({ head: 'No streak yet', sub: 'Your longest was 2 days.' });
      await days(w.page, []);
      expect(await card(w.page)).toEqual({ head: 'No streak yet', best: null, sub: 'Answer one question to start one.', run: 0 });
      expect(await w.page.$$eval('#view rect.cell', (r) => r.length)).toBeGreaterThan(0);
      await w.ctx.close();
    });

    it('steps a day by its share of the busiest visible day, and counts a correction as right', async () => {
      const w = await open('#/learning/dashboard');
      await days(w.page, [[1, 1, 0, 0], [2, 4, 2, 2], [3, 1, 1, 0]]);
      const cells = await w.page.$$eval('#view rect.cell', (r) => r.map((x) => ({
        step: x.getAttribute('data-step'), title: x.querySelector('title')!.textContent!, fill: x.getAttribute('fill'),
      })));
      const on = (n: string) => cells.find((c) => c.title.includes(n))!;
      expect(on('1 answer (1 right)').step).toBe('1');
      expect(on('8 answers (6 right)').step).toBe('4');
      expect(on('2 answers (2 right)').step).toBe('1');
      expect(on('8 answers').fill).toBe('color-mix(in srgb, var(--spot) 100%, var(--mass))');
      expect(cells.some((c) => c.title.endsWith(' — nothing') && c.fill === 'var(--mass)')).toBe(true);
      await w.ctx.close();
    });

    it('pages back and forward on a narrow screen, by mouse and by keyboard', async () => {
      const w = await open('#/learning/dashboard', { width: 560 });
      const state = () => w.page.evaluate(() => ({
        month: document.querySelector('#c-heat text.axis')!.textContent,
        prev: (document.getElementById('heat-prev') as HTMLButtonElement).disabled,
        next: (document.getElementById('heat-next') as HTMLButtonElement).disabled,
        hidden: document.getElementById('heat-prev')!.hidden,
      }));
      const before = await state();
      expect(before).toMatchObject({ prev: false, next: true, hidden: false });
      await w.page.click('#heat-prev');
      const back = await state();
      expect(back.month).not.toBe(before.month);
      expect(back.next).toBe(false);
      await w.page.focus('#heat-next');
      await w.page.keyboard.press('Enter');
      expect(await state()).toEqual(before);
      // Tab order: the earlier-weeks arrow is reachable, and Enter works on it.
      await w.page.focus('#heat-next');
      await w.page.keyboard.press('Shift+Tab');
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('heat-prev');
      await w.page.keyboard.press('Enter');
      expect((await state()).month).toBe(back.month);
      // Paging stops a year back.
      for (let i = 0; i < 10; i++) if (!(await state()).prev) await w.page.click('#heat-prev');
      expect((await state()).prev).toBe(true);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('shows a whole year with no arrows on a wide screen', async () => {
      const w = await open('#/learning/dashboard', { width: 1280 });
      expect(await w.page.evaluate(() => ({
        weeks: document.querySelectorAll('#c-heat rect.cell').length / 7,
        prev: document.getElementById('heat-prev')!.hidden,
        next: document.getElementById('heat-next')!.hidden,
      }))).toEqual({ weeks: 53, prev: true, next: true });
      await w.ctx.close();
    });

    for (const ground of ['ink', 'paper'] as const) {
      it(`draws the outline in the ink colour on ${ground}`, async () => {
        const w = await open('#/learning/dashboard', { ground });
        await days(w.page, [[0, 1, 0, 0], [1, 1, 0, 0]]);
        const [stroke, ink] = await w.page.evaluate(() => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--ink)';
          document.body.append(probe);
          return [getComputedStyle(document.querySelector('#view rect.cell.is-run')!).stroke, getComputedStyle(probe).color];
        });
        expect(stroke).toBe(ink);
        await w.ctx.close();
      });
    }
  });

  describe('start-review commands', () => {
    /** Marks `slugs` due (most overdue first) and every other concept not due, then redraws. New data reaches the page through `adoptState`. */
    const due = (page: Page, rows: [string, string | null][]) => page.evaluate((rows) => {
      const want = new Map(rows);
      const next = structuredClone(S);
      next.concepts.forEach((c: any) => {
        c.due = want.has(c.slug);
        if (c.due) { c.seen = 1; c.repo = want.get(c.slug); c.overdue_days = rows.length - rows.findIndex(([s]) => s === c.slug); }
      });
      adoptState(next, INV);
      render();
    }, rows);

    it('quotes the path for the shell, caps the slugs and falls back without a project', async () => {
      const w = await open('#/learning/review');
      const out = await w.page.evaluate((mixed) => {
        INV.projects.push({ id: "/Users/a b/it's", path: "/Users/a b/it's", name: "it's", available: true });
        const c = (slug: string, repo: string | null, overdue = 1) => ({ slug, repo, due: true, overdue_days: overdue });
        const many = Array.from({ length: 25 }, (_, i) => c(`concept-${i}`, mixed, i));
        const posix = startCommand([c('csrf', "/Users/a b/it's"), c('bad slug', "/Users/a b/it's")]);
        const capped = startCommand(many);
        const loose = startCommand([c('csrf', null)]);
        Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
        const win = startCommand([c('csrf', "/Users/a b/it's")]);
        return { posix, capped, loose, win };
      }, fx.repo.mixed);
      expect(out.posix).toEqual([{ name: "it's", count: 1, command: `cd '/Users/a b/it'\\''s' && claude "/eklavya:quiz csrf"`, note: '' }]);
      expect(out.win[0]!.command).toBe(`Set-Location -LiteralPath '/Users/a b/it''s'; claude "/eklavya:quiz csrf"`);
      expect(out.capped[0]!.count).toBe(25);
      const named = out.capped[0]!.command.match(/quiz ([^"]+)"/)![1]!.split(' ');
      expect(named).toHaveLength(20);
      expect(named[0]).toBe('concept-24');
      expect(out.loose[0]).toMatchObject({ command: 'claude "/eklavya:quiz csrf"', note: 'Run it inside the project you want these answers counted in.' });
      await w.ctx.close();
    });

    it('lists due concepts as cards, most overdue first, with one Start here', async () => {
      const w = await open('#/learning/review');
      await due(w.page, [['csrf', fx.repo.answered], ['jwt-structure', fx.repo.mixed], ['git-rebase', fx.repo.mixed]]);
      const read = () => w.page.evaluate(() => ({
        head: document.querySelector('#view .starts h2')?.textContent,
        cards: [...document.querySelectorAll('#view .rv-card')].map((x) => ({ slug: (x as HTMLElement).dataset.start, go: x.querySelector('.rv-card__go')!.textContent })),
        guides: document.querySelectorAll('#view .rv-guide').length,
        face: document.querySelector('#view .rv-guide eklavya-mascot')?.getAttribute('state'),
        note: document.querySelector('#view .starts > .cmd__note')?.textContent,
        fold: document.querySelector('#view .rv-more > summary')?.textContent ?? null,
      }));
      const out = await read();
      expect(out.head).toBe('Pick a concept to review');
      expect(out.cards.map((c) => c.slug)).toEqual(['csrf', 'jwt-structure', 'git-rebase']);
      expect(out.cards.map((c) => c.go)).toEqual(['Start →', 'Open →', 'Open →']);
      expect([out.guides, out.face, out.fold]).toEqual([1, 'review', null]);
      expect(out.note).toBe('Each session quizzes that one concept. Come back for the next.');
      // Past five, the rest fold under one summary, and nothing due shows the all-clear message instead of cards.
      const slugs = await w.page.evaluate(() => S.concepts.slice(0, 9).map((c: any) => c.slug));
      await due(w.page, slugs.map((s) => [s, fx.repo.mixed] as [string, string]));
      const many = await w.page.evaluate(() => ({
        shown: document.querySelectorAll('#view .starts > .rv-list > .rv-card, #view .starts > .rv-list > .rv-first > .rv-card').length,
        fold: document.querySelector('#view .rv-more > summary')?.textContent,
      }));
      expect(many.shown).toBe(5);
      expect(many.fold).toBe('Show 4 more concepts');
      await due(w.page, []);
      expect(await w.page.$('#view .rv-card')).toBeNull();
      expect(await w.page.textContent('#view .ek-mascot-message')).toContain('Nothing is due.');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('opens the steps for one concept, remembers Claude desktop, and toasts each copy', async () => {
      const w = await open('#/learning/review');
      await w.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await due(w.page, [['csrf', fx.repo.mixed]]);
      await w.page.click('#view .rv-card');
      await w.page.waitForSelector('#sheet[open]');
      const codes = () => w.page.$$eval('#sheet code', (n) => n.map((x) => x.textContent));
      expect(await codes()).toEqual([`cd '${fx.repo.mixed}'`, 'claude "/eklavya:quiz csrf"']);
      await w.page.click('#sheet [data-copy] >> nth=1');
      expect(await w.page.evaluate(() => navigator.clipboard.readText())).toBe('claude "/eklavya:quiz csrf"');
      expect(await w.page.textContent('#toasts .toast b')).toBe('Copied');
      expect(await w.page.textContent('#toasts .toast p')).toBe('Paste it in your terminal and press Enter.');
      expect(await w.page.getAttribute('#toasts .toast eklavya-mascot', 'state')).toBe('success');
      await w.page.click('#sheet [data-sheet-tool="desktop"]');
      expect(await codes()).toEqual([fx.repo.mixed, '/eklavya:quiz csrf']);
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('data-sheet-tool'))).toBe('desktop');
      await w.page.keyboard.press('Escape');
      expect(await w.page.$('#sheet[open]')).toBeNull();
      expect(await w.page.evaluate(() => document.activeElement?.getAttribute('data-start'))).toBe('csrf');
      await w.page.click('#view .rv-card');
      expect(await codes()).toEqual([fx.repo.mixed, '/eklavya:quiz csrf']);
      // A refused clipboard selects the text and says so in a caution toast.
      await w.page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
      await w.page.click('#sheet [data-copy] >> nth=1');
      await w.page.waitForSelector('#toasts .toast[data-k="caution"]');
      expect(await w.page.getAttribute('#toasts .toast[data-k="caution"] eklavya-mascot', 'state')).toBe('warning');
      // The sheet is emptied on close, so its live region never doubles one in the page.
      await w.page.keyboard.press('Escape');
      await w.page.waitForFunction(() => !document.getElementById('copy-live'));
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('hides the intro for good, and a project with no folder here shows no path', async () => {
      const w = await open('#/learning/review');
      expect(await w.page.$('#view .rv-intro')).not.toBeNull();
      await w.page.click('[data-rv-hide]');
      expect(await w.page.$('#view .rv-intro')).toBeNull();
      await w.page.reload(); await ready(w.page);
      expect(await w.page.$('#view .rv-intro')).toBeNull();
      await due(w.page, [['csrf', null]]);
      await w.page.click('#view .rv-card');
      expect(await w.page.$$eval('#sheet code', (n) => n.map((x) => x.textContent))).toEqual(['claude "/eklavya:quiz csrf"']);
      expect(await w.page.textContent('#sheet .next')).toContain('not on this machine');
      await w.ctx.close();
    });

    it('the shared toast replaces a repeat, keeps at most three, and the dialog resolves what was pressed', async () => {
      const w = await open('#/learning/review');
      const out = await w.page.evaluate(async () => {
        toast.success('one', { id: 'a' }); toast.success('two', { id: 'a' });
        toast.caution('c'); toast.alert('d'); toast.success('e', { id: 'e' });
        const n = document.querySelectorAll('#toasts .toast').length;
        const roles = [...document.querySelectorAll('#toasts .toast')].map((x) => x.getAttribute('role'));
        toast.dismiss('e');
        const after = document.querySelectorAll('#toasts .toast').length;
        const asked = ekDialog({ state: 'warning', title: 'Sure?', text: 'x', ok: 'Delete', danger: true, input: 'Reason' });
        const focus = document.activeElement?.id;
        (document.getElementById('dlg-in') as HTMLTextAreaElement).value = 'why';
        (document.getElementById('dlg-ok') as HTMLButtonElement).click();
        const r = await asked;
        return { n, roles, after, focus, r };
      });
      expect(out.n).toBe(3);
      expect(out.roles).toEqual(['status', 'alert', 'status']);
      expect(out.after).toBe(2);
      expect(out.focus).toBe('dlg-c');
      expect(out.r).toEqual({ ok: true, value: 'why' });
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('puts a one-slug command on a due concept, and none on one that is not due', async () => {
      const w = await open('#/learning/concept/csrf');
      await due(w.page, [['csrf', fx.repo.mixed]]);
      expect(await w.page.evaluate(() => ({
        head: document.querySelector('#view .starts h2')?.textContent,
        cmd: document.querySelector('#view .starts code')?.textContent,
      }))).toEqual({ head: 'This one is due', cmd: `cd '${fx.repo.mixed}' && claude "/eklavya:quiz csrf"` });
      await due(w.page, []);
      expect(await w.page.$('#view .starts')).toBeNull();
      await w.ctx.close();
    });

    it('sends the Learning next step to the queue instead of naming a bare command', async () => {
      const w = await open('#/learning/dashboard');
      await due(w.page, [['csrf', fx.repo.mixed], ['git-rebase', fx.repo.mixed]]);
      const text = await w.page.$eval('#view .next', (x) => x.textContent!.replace(/\s+/g, ' ').trim());
      expect(text).toBe('2 concepts are due. Open the review queue for the command to run.');
      await w.ctx.close();
    });

    it('copies the exact command, and selects it when the clipboard refuses', async () => {
      const w = await open('#/learning/concept/csrf');
      await w.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      await due(w.page, [['csrf', fx.repo.mixed]]);
      const want = await w.page.$eval('#view .starts code', (x) => x.textContent);
      await w.page.click('#view [data-copy]');
      await w.page.waitForFunction(() => document.querySelector('#view [data-copy]')!.textContent === 'Copied');
      expect(await w.page.evaluate(() => navigator.clipboard.readText())).toBe(want);
      expect(await w.page.$eval('#copy-live', (x) => x.textContent)).toBe('Command copied');
      await w.page.waitForFunction(() => document.querySelector('#view [data-copy]')!.textContent === 'Copy', null, { timeout: 3000 });

      await w.page.evaluate(() => { navigator.clipboard.writeText = () => Promise.reject(new Error('denied')); });
      await w.page.focus('#view [data-copy]');
      await w.page.keyboard.press('Enter');
      await w.page.waitForFunction(() => /to copy/.test(document.getElementById('copy-live')!.textContent!));
      expect(await w.page.evaluate(() => String(getSelection()))).toBe(want);
      const mac = await w.page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
      expect(await w.page.$eval('#copy-live', (x) => x.textContent)).toBe(`Press ${mac ? '⌘C' : 'Ctrl+C'} to copy`);
      expect(w.errors).toEqual([]);
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
      await w.page.waitForSelector('[data-msg="difficulty"].here:has-text("saved")');
      expect(JSON.parse(fs.readFileSync(userFile, 'utf8')).difficulty).toBe('hard');
      expect(await w.page.textContent('#set-difficulty-combo')).toContain('hard');
      expect(await w.page.evaluate(() => document.activeElement?.id)).toBe('set-difficulty-combo');
      await w.page.click('[data-unset="difficulty"]');
      await w.page.waitForSelector('[data-msg="difficulty"]:has-text("inherited")');
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
