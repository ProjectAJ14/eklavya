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
declare let S: { daily: unknown[]; concepts: unknown[]; logged: { slug: string }[] };
declare function inScope(repo: unknown, sid: unknown): boolean;
declare let INV: { projects: unknown[] };
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
    /** Replaces the payload's days with `[daysAgo, passed, corrected, missed]` rows and redraws. */
    const days = (page: Page, rows: number[][]) => page.evaluate((rows) => {
      const key = (n: number) => { const d = fromKey(todayKey()); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
      S.daily = rows.map(([n, passed, corrected, missed]) => ({ day: key(n!), repo: null, passed, corrected, missed, skipped: 0 }));
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
    /** Marks `slugs` due (most overdue first) and every other concept not due, then redraws. */
    const due = (page: Page, rows: [string, string | null][]) => page.evaluate((rows) => {
      const want = new Map(rows);
      S.concepts.forEach((c: any) => {
        c.due = want.has(c.slug);
        if (c.due) { c.seen = 1; c.repo = want.get(c.slug); c.overdue_days = rows.length - rows.findIndex(([s]) => s === c.slug); }
      });
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

    it('gives the review queue one block per project, most due first', async () => {
      const w = await open('#/learning/review');
      const [a, b, c] = ['csrf', 'jwt-structure', 'git-rebase'];
      await due(w.page, [[a!, fx.repo.answered], [b!, fx.repo.mixed], [c!, fx.repo.mixed]]);
      const blocks = await w.page.evaluate(() => ({
        head: document.querySelector('#view .starts h2')?.textContent,
        rows: [...document.querySelectorAll('#view .starts .start')].map((x) => ({
          who: x.querySelector('p')!.textContent!.replace(/\s+/g, ' ').trim(), cmd: x.querySelector('code')!.textContent,
        })),
        quiz: document.querySelector('#view .next:not(.start)')?.textContent ?? '',
      }));
      expect(blocks.head).toBe('Start your reviews');
      // A run asks the weakest concepts, so the caption must not promise overdue order.
      expect(await w.page.$eval('#view .starts > .cmd__note', (n) => n.textContent))
        .toBe('Each run asks up to your questions-per-task limit, weakest first. Run it again for the rest.');
      expect(blocks.rows.map((r) => r.who)).toEqual(['mixed · 2 due', 'answered · 1 due']);
      expect(blocks.rows[0]!.cmd).toBe(`cd '${fx.repo.mixed}' && claude "/eklavya:quiz ${b} ${c}"`);
      // A selected project shows its own block alone.
      await w.page.evaluate((id) => { location.hash = `#/learning/review?project=${encodeURIComponent(id)}`; }, fx.repo.mixed);
      await ready(w.page);
      const inMixed = await w.page.evaluate(() => S.logged.find((l: any) => inScope(l.repo, l.session_id))!.slug);
      await due(w.page, [[inMixed, fx.repo.answered]]);
      expect(await w.page.$$eval('#view .starts .start p', (x) => x.map((p) => p.textContent!.replace(/\s+/g, ' ').trim())))
        .toEqual(['mixed · 1 due']);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('shows the top three review blocks and folds the rest under Show more', async () => {
      const w = await open('#/learning/review');
      await w.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
      // Five projects, counts 2, 2, 1, 1, 1: the top two plus one single show; two singles fold.
      await due(w.page, [
        ['csrf', fx.repo.answered], ['jwt-structure', fx.repo.answered],
        ['git-rebase', fx.repo.mixed], ['refresh-token-rotation', fx.repo.mixed],
        ['cors-basics', fx.repo.clientApi], ['express-middleware', fx.repo.serverApi], ['git-stash', fx.repo.retired],
      ]);
      const read = () => w.page.evaluate(() => ({
        shown: [...document.querySelectorAll('#view .starts > .start > p:first-child')].map((p) => p.textContent!.replace(/\s+/g, ' ').trim()),
        folded: [...document.querySelectorAll('#view .starts__more .start > p:first-child')].map((p) => p.textContent!.replace(/\s+/g, ' ').trim()),
        label: document.querySelector('#view .starts__more > summary')?.textContent,
        open: (document.querySelector('#view .starts__more') as HTMLDetailsElement | null)?.open,
      }));
      const before = await read();
      expect(before.shown).toHaveLength(3);
      expect(before.folded).toHaveLength(2);
      expect(before.label).toBe('Show 2 more · 2 due');
      expect(before.open).toBe(false);
      // Folded blocks are not rendered until opened, and the keyboard opens them.
      expect(await w.page.$eval('#view .starts__more .start', (n) => n.checkVisibility())).toBe(false);
      await w.page.focus('#view .starts__more > summary');
      await w.page.keyboard.press('Enter');
      expect((await read()).open).toBe(true);
      // A folded block copies exactly its own command.
      await w.page.click('#view .starts__more .start:last-of-type [data-copy]');
      const cmd = await w.page.$eval('#view .starts__more .start:last-of-type code', (n) => n.textContent);
      expect(await w.page.evaluate(() => navigator.clipboard.readText())).toBe(cmd);
      // Three or fewer projects show no fold at all.
      await due(w.page, [['csrf', fx.repo.answered], ['git-rebase', fx.repo.mixed], ['cors-basics', fx.repo.clientApi]]);
      expect(await w.page.$('#view .starts__more')).toBeNull();
      expect((await read()).shown).toHaveLength(3);
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
