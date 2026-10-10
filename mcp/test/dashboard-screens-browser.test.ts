// Split by feature so Vitest's file sharding can divide the browser work.
import { describe, expect, it } from 'vitest';
import { OPTS, base, enc, fix, fx, open, ready } from './dashboard-browser-helpers.js';

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

    it('centres the content column in a window wider than it', async () => {
      const w = await open('#/learning/dashboard', { width: 2560 });
      for (const h of ['#/learning/dashboard', `#/artifacts/view/${enc(fix.other)}`, '#/settings/dashboard']) {
        await w.page.goto(base + '/' + h); await ready(w.page);
        // Every band of the column: the refresh notice (shown for this), the crumb, the view and the footer.
        const gaps = await w.page.evaluate(() => {
          document.getElementById('stale')!.hidden = false;
          const main = document.getElementById('main')!;
          const m = main.getBoundingClientRect(), pad = parseFloat(getComputedStyle(main).paddingLeft);
          return [...main.querySelectorAll(':scope > .inner')].map((el) => {
            const r = el.getBoundingClientRect();
            return { id: el.id || el.tagName, offCentre: Math.round((r.left - m.left) - (m.right - r.right)), clear: r.left - m.left > pad };
          });
        });
        expect(gaps.map((g) => g.id), h).toEqual(['stale', 'crumb', 'view', 'FOOTER']);
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
});
