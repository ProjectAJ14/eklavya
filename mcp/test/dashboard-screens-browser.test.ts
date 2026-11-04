// Split by feature so Vitest's file sharding can divide the browser work.
import { describe, expect, it } from 'vitest';
import { OPTS, base, db, enc, fix, fx, open, ready } from './dashboard-browser-helpers.js';

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('every screen', () => {
    it('makes no outbound request, logs no error, and fits the width', async () => {
      const hashes = ['#/learning/dashboard', '#/learning/projects', '#/memory/dashboard', '#/memory/timeline',
        '#/memory/sessions', '#/memory/projects', '#/memory/health', `#/memory/entry/${fx.entries.mixed}`,
        '#/artifacts/dashboard', '#/artifacts/dashboard/explainer', '#/artifacts/dashboard/to-correct',
        `#/artifacts/view/${enc(fix.other)}`, '#/artifacts/projects',
        '#/feedback/dashboard', '#/feedback/history',
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

    it('shows every scope on the Settings rail by name when the rail scrolls sideways', async () => {
      // A shrinking link in a row that scrolls clipped its label to nothing (the first one, "User", was an icon alone).
      for (const width of [560, 390]) {
        const w = await open('#/settings/dashboard', { width, height: 800 });
        const scopes = await w.page.$$eval('.sw__scope', (links) => links.map((a) => {
          const label = a.querySelector('span')!.getBoundingClientRect().width;
          return { text: (a.textContent ?? '').trim(), label: Math.round(label), link: Math.round(a.getBoundingClientRect().width) };
        }));
        expect(scopes.length).toBeGreaterThan(2);
        expect(scopes[0]!.text).toBe('User');
        for (const sc of scopes) {
          expect(sc.label, `${sc.text} at ${width}px has room for its name`).toBeGreaterThan(20);
          expect(sc.link, `${sc.text} at ${width}px`).toBeGreaterThan(sc.label);
        }
        await w.ctx.close();
      }
    });

    it('centres the content column in a window wider than it', async () => {
      const w = await open('#/learning/dashboard', { width: 2560 });
      for (const h of ['#/learning/dashboard', `#/artifacts/view/${enc(fix.other)}`, '#/settings/dashboard']) {
        await w.page.goto(base + '/' + h); await ready(w.page);
        // Every band of the column: the crumb, the view and the footer.
        const gaps = await w.page.evaluate(() => {
          const main = document.getElementById('main')!;
          const m = main.getBoundingClientRect(), pad = parseFloat(getComputedStyle(main).paddingLeft);
          return [...main.querySelectorAll(':scope > .inner')].map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.id || el.tagName, offCentre: Math.round((r.left - m.left) - (m.right - r.right)), clear: r.left - m.left > pad };
          });
        });
        expect(gaps.map((g) => g.id), h).toEqual(['crumb', 'view', 'FOOTER']);
        for (const g of gaps) expect(g, h).toMatchObject({ offCentre: 0, clear: true });
      }
      await w.ctx.close();
    });

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
  describe('one session page from every workflow', () => {
    it('opens the same page from Learning, Memory and Cost, and a ledger-only session too', async () => {
      const row = db.prepare(
        `INSERT INTO econ_sessions (session_id, project, transcript_path, model, started_at, ended_at, prompts, effective, quiz_effective,
           eklavya_effective, eklavya_tools, folded_at) VALUES (?, ?, ?, 'claude-opus-5-5', '2026-11-02T10:00:00Z', '2026-11-02T11:00:00Z', 3, 1000, 50, 50, ?, 'x')`,
      );
      row.run('s-mixed', fx.repo.mixed, '/gone/s-mixed.jsonl', '{"memory_search":2}');
      row.run('s-ledger', fx.repo.mixed, null, null);
      db.prepare(`INSERT INTO econ_guard_events (at, session_id, project, kind) VALUES ('x', 's-ledger', ?, 'redirect')`).run(fx.repo.mixed);
      const w = await open('#/cost/sessions', { width: 560 });
      const { page } = w;
      await page.click(`tr.row[data-go*="s-mixed"]`);
      await page.waitForSelector('.sess-talk eklavya-mascot');
      expect(page.url()).toContain('#/cost/session/s-mixed');
      const seen = async () => ({
        h1: await page.textContent('h1.page__title'),
        talk: await page.textContent('.sess-talk .say'),
        state: await page.getAttribute('.sess-talk eklavya-mascot', 'state'),
      });
      const fromCost = await seen();
      expect(fromCost.talk).toContain("I used 5% of this session's effective tokens.");
      expect(fromCost.state).toBe('info');
      expect(await page.textContent('#view')).toContain('Claude Code has since deleted it');
      expect(await page.textContent('#view')).toContain('memory_search');
      for (const wf of ['learning', 'memory']) {
        await page.goto(`${base}/#/${wf}/session/s-mixed`); await ready(page);
        await page.waitForSelector('.sess-talk eklavya-mascot');
        expect(await seen(), wf).toEqual(fromCost);
      }
      // Known only to the ledger: its own head, and a worried face for the redirect.
      await page.goto(`${base}/#/cost/session/s-ledger`); await ready(page);
      await page.waitForSelector('.sess-talk eklavya-mascot');
      expect(await page.getAttribute('.sess-talk eklavya-mascot', 'state')).toBe('warning');
      expect(await page.textContent('#view')).toContain('No transcript was recorded');
      // Nothing recorded at all: not found.
      await page.goto(`${base}/#/cost/session/s-nobody`); await ready(page);
      await page.waitForSelector('text=No session');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(w.outbound).toEqual([]);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    }, 60000);
  });
});
