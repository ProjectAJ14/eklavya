// Split by feature so Vitest's file sharding can divide the browser work.
//
// Phase 6 of #171, the page half. The server ships only the newest ATTEMPT_LIMIT answers and the newest
// LOGGED_LIMIT logged lines (and says so: attempts_shown / attempts_total, logged_shown / logged_total),
// and gives the page what the cut leaves out: each project's whole concept list and session count
// (`learning.concept_slugs`, `learning.sessions` in /api/projects) and one session's whole learning half
// (`learning` in /api/memory/sessions?session=). These tests hold the page to using them.
//
// The caps are the server's own constants, imported from the build, and the database is filled past them
// with plain inserts (no test-only seam in the server): a crowd of rows newer than everything else pushes
// the old rows out of the payload. The first group runs before the crowd exists, on a database inside both
// caps, and the second after it, so one file covers both sides of the cut.
import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { ATTEMPT_LIMIT, LOGGED_LIMIT } from '../dist/dashboard.js';
import { OPTS, base, db, enc, home, open, probeTransition, ready } from './dashboard-browser-helpers.js';

// Globals of the page under test (a script's `let` and `const` are reachable by name from `evaluate`, not from `window`).
declare const S: { attempts: { slug: string; repo: string | null; session_id: string | null }[]; logged: { slug: string; repo: string | null; session_id: string }[] };
declare const SCOPE: Set<string> | null;
declare function inScope(repo: string | null, session: string | null): boolean;
declare function sessions(): { id: string; logged: unknown[]; asked: unknown[] }[];
declare function learningSessions(): unknown[];

/** SQLite's own timestamp shape, as `attempts.ts` and `session_concepts.ts` hold it. */
const stamp = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

interface Inventory { projects: { id: string; learning: { sessions: number; concept_slugs: string[] } }[] }
const getJson = async (p: string) => (await fetch(base + p)).json() as Promise<any>;
const inventory = () => getJson('/api/projects') as Promise<Inventory>;

/** The rows a screen shows, from the page: how many of a selector, and what the heading block counts say. */
const count = (page: Page, selector: string) => page.locator(selector).count();
const counts = (page: Page) => page.textContent('#view .page__head .counts');
/** What a reader reads of an element: its text with the markup's line breaks and indentation collapsed. */
const said = async (page: Page, selector: string) => ((await page.textContent(selector)) ?? '').replace(/\s+/g, ' ').trim();
const badge = (page: Page, nav: string) => page.textContent(`#nav a[data-nav="${nav}"] i`);

/** Opens a session's page by hash, the way a reader follows a link, and says what it asked the server for. */
async function visit(page: Page, id: string, project?: string): Promise<string[]> {
  const hash = `#/learning/session/${enc(id)}${project ? `?project=${enc(project)}` : ''}`;
  const r = await probeTransition(page, () => page.evaluate((h) => { location.hash = h; }, hash));
  return r.requests.filter((u) => u.startsWith('/api/memory/sessions'));
}

/** The session page's own words: what it counts and the lists under them. */
const sessionPage = (page: Page) => page.evaluate(() => ({
  counts: document.querySelector('#view .page__head .counts')?.textContent ?? '',
  worked: [...document.querySelectorAll('#view .card')].find((c) => c.querySelector('h2')?.textContent === 'What the work taught')?.querySelectorAll('.lines li').length ?? 0,
  asked: document.querySelectorAll('#view details.qa').length,
  askedHint: [...document.querySelectorAll('#view .card')].find((c) => c.querySelector('h2')?.textContent === 'What you were asked')?.querySelector('.head p')?.textContent ?? '',
  text: (document.getElementById('view')!.textContent ?? '').replace(/\s+/g, ' '),
}));

// One project holds the three sessions the cut treats differently, another the crowd that does the cutting.
let repoOld = '';
let repoCrowd = '';
let concepts: { id: number; slug: string }[] = [];
const LINES_PER_SESSION = 23;

/**
 * Fills the database past both caps. Row order is what the server cuts by (answers by id, logged lines by
 * time), so the crowd goes in after the old rows and before the newest ones:
 *
 *  - `cap-old`: three logged lines and two answers, years old. After the crowd it is wholly outside both lists.
 *  - `cap-across`: two lines and two answers, years old, and two of each just now. It begins before the cut and
 *    runs past it, so the payload holds half of it.
 *  - `cap-new`: one line and one answer, just now. It is inside both lists.
 *  - `cap-chatty`: ATTEMPT_LIMIT + 5 answers in one session, past what the server sends for one session.
 *  - `cap-line-N`: LOGGED_LIMIT + 5 logged lines over many sessions.
 *
 * The first three are one project; its concepts are twelve at the end of the catalogue and one more, which no
 * other project and none of the crowd names.
 */
function seedPastBothCaps(): void {
  concepts = db.prepare('SELECT id, slug FROM concepts ORDER BY id').all() as { id: number; slug: string }[];
  const crowdConcepts = concepts.slice(0, LINES_PER_SESSION);
  const o = concepts.slice(-12);
  const newest = concepts[LINES_PER_SESSION]!;
  const repo = (name: string) => {
    const dir = path.join(home, 'root', name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    return fs.realpathSync(dir);
  };
  repoOld = repo('caps-old');
  repoCrowd = repo('caps-crowd');

  const gate = db.prepare("INSERT INTO gates (session_id, mode, repo) VALUES (?, 'ambient', ?)");
  const line = db.prepare('INSERT INTO session_concepts (session_id, concept_id, context, ts, origin) VALUES (?, ?, ?, ?, ?)');
  const ask = db.prepare('INSERT INTO attempts (concept_id, session_id, question, answer, feedback, grade, difficulty, ts, repo) VALUES (?, ?, ?, ?, ?, ?, 2, ?, ?)');
  const OLD = '2020-03-01 10:00:00';
  const OLDER = '2020-03-02 10:00:00';
  const now = Date.now();
  db.transaction(() => {
    for (const s of ['cap-old', 'cap-across', 'cap-new']) gate.run(s, repoOld);
    gate.run('cap-chatty', repoCrowd);
    for (let n = 0; n <= Math.floor((LOGGED_LIMIT + 5) / LINES_PER_SESSION); n++) gate.run(`cap-line-${n}`, repoCrowd);

    // Years old: below everything the payload will hold.
    o.slice(0, 3).forEach((c, i) => line.run('cap-old', c.id, `old line ${i}`, OLD, 'work'));
    o.slice(3, 5).forEach((c) => ask.run(c.id, 'cap-old', `What did ${c.slug} do in the old project?`, 'an answer', 'feedback', 4, OLD, repoOld));
    o.slice(4, 6).forEach((c, i) => line.run('cap-across', c.id, `an old line of the long session ${i}`, OLDER, 'work'));
    o.slice(6, 8).forEach((c) => ask.run(c.id, 'cap-across', `What did ${c.slug} do before the cut?`, 'an answer', 'feedback', 2, OLDER, repoOld));

    // The crowd: newer than all of it, so the newest rows are these.
    for (let i = 0; i < ATTEMPT_LIMIT + 5; i++) {
      ask.run(crowdConcepts[0]!.id, 'cap-chatty', `Question ${i}?`, 'a', 'f', i % 2 ? 4 : 1, stamp(now - 5 * 3600e3 + i * 1000), repoCrowd);
    }
    for (let i = 0; i < LOGGED_LIMIT + 5; i++) {
      line.run(`cap-line-${Math.floor(i / LINES_PER_SESSION)}`, crowdConcepts[i % LINES_PER_SESSION]!.id, `crowd line ${i}`, stamp(now - 5 * 3600e3 + i * 1000), 'work');
    }

    // Newer than the crowd.
    o.slice(8, 10).forEach((c, i) => line.run('cap-across', c.id, `a new line of the long session ${i}`, stamp(now - 120e3), 'work'));
    o.slice(10, 12).forEach((c) => ask.run(c.id, 'cap-across', `What did ${c.slug} do after the cut?`, 'an answer', 'feedback', 5, stamp(now - 110e3), repoOld));
    line.run('cap-new', newest.id, 'the newest line', stamp(now - 60e3), 'work');
    ask.run(newest.id, 'cap-new', `What is ${newest.slug} for?`, 'an answer', 'feedback', 3, stamp(now - 50e3), repoOld);
  })();
}

describe.skipIf(!OPTS)('dashboard in a browser', () => {
  describe('a database inside both caps', () => {
    it('says nothing of a cap, counts the list it lists and draws a session from the payload with no lookup', async () => {
      const w = await open('#/learning/sessions');
      const { page } = w;
      const state = await getJson('/api/state');
      expect(state).toMatchObject({ attempts_shown: state.attempts_total, logged_shown: state.logged_total });
      // Nothing is cut, so the footer says nothing of it, and the Sessions page is the plain list it always was.
      expect(await page.textContent('#foot-note')).toBe('');
      expect(await counts(page)).toMatch(/^\d+ sessions · \d+ with questions · \d+ answers$/);
      expect(await page.textContent('#view')).not.toContain('This list is built from');
      const listed = await page.evaluate(() => learningSessions().length);
      expect(await badge(page, 'sessions')).toBe(String(listed));
      expect(await counts(page)).toContain(`${listed} sessions`);

      // A session in the payload, memory half and all: its own page asks for its memory and not for a lookup.
      const asked = await visit(page, 's-mixed');
      expect(asked).toEqual([]);
      const body = await sessionPage(page);
      expect(body.counts).toContain('2 concepts logged');
      expect(body.counts).toContain('/3 right');
      expect(body.worked).toBe(2);
      expect(body.asked).toBe(3);
      expect(body.askedHint).toBe('3 questions, in order. Open one for the options and the feedback.');
      expect(w.errors).toEqual([]);
      expect(w.outbound).toEqual([]);
      await w.ctx.close();
    });
  });

  describe('a database past both caps', () => {
    beforeAll(() => { if (OPTS) seedPastBothCaps(); });

    it('discloses both caps in the footer, and says what they affect', async () => {
      const state = await getJson('/api/state');
      expect(state).toMatchObject({ attempts_shown: ATTEMPT_LIMIT, logged_shown: LOGGED_LIMIT });
      expect(state.attempts_total).toBeGreaterThan(ATTEMPT_LIMIT);
      expect(state.logged_total).toBeGreaterThan(LOGGED_LIMIT);
      const w = await open('#/learning/dashboard');
      expect(await w.page.textContent('#foot-note')).toBe(
        ` Question histories show the most recent ${ATTEMPT_LIMIT} of ${state.attempts_total} answers.`
        + ` Logged context lines show the most recent ${LOGGED_LIMIT} of ${state.logged_total}.`
        + ' The Sessions list shows the most recent sessions; each session opens whole.',
      );
      // Narrow, the sentence wraps with the rest of the footer and the page does not scroll sideways.
      await w.page.setViewportSize({ width: 560, height: 900 });
      expect(await w.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      expect(w.errors).toEqual([]);
      expect(w.outbound).toEqual([]);
      await w.ctx.close();
    });

    it('says one number for a project\'s sessions on the sidebar, the Sessions page, the dashboard and the project card', async () => {
      const inv = await inventory();
      const old = inv.projects.find((p) => p.id === repoOld)!;
      // Three sessions of the project, every one counted by the server; the payload's rows name two of them.
      expect(old.learning.sessions).toBe(3);
      const w = await open(`#/learning/sessions?project=${enc(repoOld)}`);
      const { page } = w;
      expect(await page.evaluate(() => learningSessions().length)).toBe(2);
      expect(await badge(page, 'sessions')).toBe('3');
      expect(await counts(page)).toBe('3 sessions · newest 2 listed · 2 of those with questions · 3 answers in them');
      expect(await count(page, '#view tbody tr.row')).toBe(2);
      const state = await getJson('/api/state');
      expect(await said(page, '#view [data-region="sessions"] p.slug')).toBe(
        `This list is built from the most recent ${ATTEMPT_LIMIT} of ${state.attempts_total} answers and the most recent ${LOGGED_LIMIT} of ${state.logged_total} logged lines, `
        + 'so older sessions are counted above but not listed, and the oldest one listed may show only part of its work. Open a session to read it whole.',
      );

      await page.evaluate((h) => { location.hash = h; }, `#/learning/dashboard?project=${enc(repoOld)}`);
      await ready(page);
      expect(await page.textContent('#view a.link[data-go*="/sessions"]')).toBe('All 3 →');
      expect(await badge(page, 'sessions')).toBe('3');

      // The project card, which was always the server's own count.
      await page.evaluate((h) => { location.hash = h; }, `#/learning/projects?project=${enc(repoOld)}`);
      await ready(page);
      expect(await page.textContent('#view .kv div:has(b:text-is("Sessions")) span')).toBe('3');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('counts every project\'s sessions for all projects, though the list is only the newest rows\' sessions', async () => {
      const inv = await inventory();
      const cards = inv.projects.reduce((n, p) => n + p.learning.sessions, 0);
      const w = await open('#/learning/sessions');
      const { page } = w;
      const listed = await page.evaluate(() => learningSessions().length);
      expect(cards).toBeGreaterThan(listed);
      expect(await badge(page, 'sessions')).toBe(String(cards));
      expect(await counts(page)).toMatch(new RegExp(`^${cards} sessions · newest ${listed} listed · `));
      // The pager pages the list that exists.
      expect(await count(page, '#view tbody tr.row')).toBe(Math.min(20, listed));
      await w.ctx.close();
    });

    it('keeps a concept in its project when every row that names it is older than the payload\'s newest', async () => {
      const inv = await inventory();
      const old = inv.projects.find((p) => p.id === repoOld)!;
      const expected = [...concepts.slice(-12), concepts[LINES_PER_SESSION]!].map((c) => c.slug).sort();
      expect(old.learning.concept_slugs).toEqual(expected);
      const w = await open(`#/learning/concepts?project=${enc(repoOld)}`);
      const { page } = w;
      // What the payload's own rows could name for the project: the five concepts of its newest rows, and no more.
      const fromRows = await page.evaluate(() => {
        const from = new Set<string>();
        for (const a of S.attempts) if (inScope(a.repo, a.session_id)) from.add(a.slug);
        for (const l of S.logged) if (inScope(l.repo, l.session_id)) from.add(l.slug);
        return [...from].sort();
      });
      expect(fromRows).toHaveLength(5);
      expect(fromRows.every((s) => expected.includes(s))).toBe(true);
      // The scope is the inventory's list, so all thirteen are in it, on the page and in the sidebar.
      expect(await page.evaluate(() => [...(SCOPE ?? [])].sort())).toEqual(expected);
      expect(await badge(page, 'concepts')).toBe('13');
      const listedSlugs = await page.$$eval('#view tbody tr.row', (rows) => rows.map((r) => decodeURIComponent((r.getAttribute('data-go') ?? '').split('/concept/')[1]!.split('?')[0]!)));
      expect(listedSlugs.sort()).toEqual(expected);
      // A project's concept list does not depend on who else has rows: the crowd's own project has its own.
      expect((inv.projects.find((p) => p.id === repoCrowd)!.learning.concept_slugs).length).toBe(LINES_PER_SESSION);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('reads a session whole: one inside the lists, one across the cut, one wholly outside both', async () => {
      const w = await open('#/learning/sessions');
      const { page } = w;
      // The three cases as the payload holds them: all of it, half of it, none of it.
      const held = await page.evaluate(() => Object.fromEntries(['cap-new', 'cap-across', 'cap-old'].map((id) => {
        const s = sessions().find((x) => x.id === id);
        return [id, s ? [s.logged.length, s.asked.length] : null];
      })));
      expect(held).toEqual({ 'cap-new': [1, 1], 'cap-across': [2, 2], 'cap-old': null });

      // Inside: the same session whether or not it is asked for, and still read from the server, since nothing
      // in a cut payload says that a session's older rows are not among those left out.
      let asked = await visit(page, 'cap-new');
      expect(asked).toEqual(['/api/memory/sessions?session=cap-new']);
      let body = await sessionPage(page);
      expect(body).toMatchObject({ worked: 1, asked: 1, askedHint: '1 question, in order. Open one for the options and the feedback.' });
      expect(body.counts).toContain('1 concept logged');

      // Across: four lines and four answers, where the payload holds two and two.
      asked = await visit(page, 'cap-across');
      expect(asked).toEqual(['/api/memory/sessions?session=cap-across']);
      body = await sessionPage(page);
      expect(body).toMatchObject({ worked: 4, asked: 4 });
      expect(body.counts).toContain('4 concepts logged');
      expect(body.counts).toContain('2/4 right (50%)');
      expect(body.text).toContain('an old line of the long session 0');
      expect(body.text).toContain('a new line of the long session 1');
      // The header's first time is the old rows' (March 2020, whichever day the machine's zone puts it on), not the newest rows'.
      expect(body.counts).toMatch(/^Mar [123],/);

      // Wholly outside: nothing of it in the payload, all of it here.
      asked = await visit(page, 'cap-old');
      expect(asked).toEqual(['/api/memory/sessions?session=cap-old']);
      body = await sessionPage(page);
      expect(body).toMatchObject({ worked: 3, asked: 2 });
      expect(body.counts).toContain('3 concepts logged');
      expect(body.counts).toContain('2/2 right (100%)');
      expect(body.text).not.toContain('No session');

      // A session with memory as well, outside both lists: its learning half and its memory half, joined.
      asked = await visit(page, 's-mixed');
      expect(asked).toEqual(['/api/memory/sessions?session=s-mixed']);
      body = await sessionPage(page);
      expect(body.worked).toBe(2);
      expect(body.asked).toBe(3);
      expect(body.counts).toContain('2 captured');
      expect(body.text).toContain('What the session remembered');

      // Seen again, it is the page's own copy: no request.
      expect(await visit(page, 'cap-across')).toEqual([]);
      expect((await sessionPage(page)).worked).toBe(4);
      expect(w.errors).toEqual([]);
      expect(w.outbound).toEqual([]);
      await w.ctx.close();
    });

    it('narrows a looked-up session to the project in scope, and says so for one that is not in it', async () => {
      const w = await open(`#/learning/sessions?project=${enc(repoOld)}`);
      const { page } = w;
      // In the project: read with the project named, and whole.
      expect(await visit(page, 'cap-old', repoOld)).toEqual([`/api/memory/sessions?session=cap-old&project=${enc(repoOld)}`]);
      expect(await sessionPage(page)).toMatchObject({ worked: 3, asked: 2 });
      // The crowd's session is another project's: none of its rows are in this scope.
      expect(await visit(page, 'cap-chatty', repoOld)).toHaveLength(1);
      expect((await sessionPage(page)).text).toContain('No session cap-chatty in this scope.');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('says when a session has more answers than the server sends for one', async () => {
      const w = await open('#/learning/sessions');
      const { page } = w;
      const asked = await visit(page, 'cap-chatty');
      expect(asked).toEqual(['/api/memory/sessions?session=cap-chatty']);
      const body = await sessionPage(page);
      expect(body.asked).toBe(ATTEMPT_LIMIT);
      expect(body.askedHint).toBe(`The newest ${ATTEMPT_LIMIT} of this session's ${ATTEMPT_LIMIT + 5} questions, in order. Open one for the options and the feedback.`);
      expect(body.counts).toContain(`the newest ${ATTEMPT_LIMIT} of ${ATTEMPT_LIMIT + 5} answers`);
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('says on Memory\'s Sessions list that Asked counts only the answers the payload holds', async () => {
      const w = await open('#/memory/sessions');
      const state = await getJson('/api/state');
      expect(await said(w.page, '#msess-rows p.slug')).toBe(
        `Asked counts the most recent ${ATTEMPT_LIMIT} of ${state.attempts_total} answers: a session older than those shows —, and the oldest one that is counted may show only part of its answers.`,
      );
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });

    it('draws a lookup for a session in the Memory workflow too, with its learning half', async () => {
      const w = await open('#/memory/sessions');
      const { page } = w;
      const r = await probeTransition(page, () => page.evaluate(() => { location.hash = '#/memory/session/cap-old'; }));
      expect(r.requests.filter((u) => u.startsWith('/api/memory/sessions'))).toEqual(['/api/memory/sessions?session=cap-old']);
      expect(await sessionPage(page)).toMatchObject({ worked: 3, asked: 2 });
      // The back link stays in the workflow the reader came from.
      expect(await page.getAttribute('#view .page__back', 'data-go')).toBe('#/memory/sessions');
      expect(w.errors).toEqual([]);
      await w.ctx.close();
    });
  });
});
