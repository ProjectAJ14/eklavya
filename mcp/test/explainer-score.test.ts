import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brief, contentOf, pointHome, RUNTIME_BIN, scorePage, sectionOf, sectionText, sentenceCount, SKILL_PATH, summarise, text, type ExplainerCase } from '../src/eval/explainer-score.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(here, '..', 'src', 'assets', 'artifact-template.html'), 'utf8');
const fill = (over: Record<string, string> = {}) =>
  raw.replace(/\{\{([A-Z_]+)\}\}/g, (_, k: string) => ({ KIND: 'explainer', CONCEPT: 'debounce', ATTEMPT: '413', TITLE: 'Debouncing, explained', ...over })[k] ?? '');
const template = fill();

const c: ExplainerCase = {
  id: 't',
  concept: { slug: 'debounce', name: 'Debouncing' },
  stem: 'How many requests go out?',
  options: ['Five', 'One, after the last keystroke', 'Two', 'None'],
  notes: ['Delays every call', 'Restarts the timer', null, 'Forgets the timer'],
  pick: 0,
  right: 1,
  attempt_id: 413,
  lang: 'ts|typescript',
  identifiers: ['fetchResults', 'SearchBox'],
};

const options = (cls: string[] = ['picked', 'right', '', ''], texts = c.options!) =>
  `<ol class="options">${texts.map((t, i) => `<li${cls[i] ? ` class="${cls[i]}"` : ''}>${t}${c.notes![i] ? `<span class="note">${c.notes![i]}</span>` : ''}</li>`).join('')}</ol>`;
const FIG = '<figure><svg viewBox="0 0 10 10"><rect class="svg-box" x="1" y="1" width="2" height="2"/></svg><figcaption>One request goes out.</figcaption></figure>';
const body = (parts: Partial<Record<'q' | 'short' | 'wrong' | 'how' | 'ex' | 'rule', string>> = {}) =>
  [
    parts.q ?? `<h2>The question</h2><p>${c.stem}</p>${options()}`,
    parts.short ?? '<h2>The short answer</h2><p>It waits for quiet.</p>',
    parts.wrong ?? '<h2>Where the answer went wrong</h2><p>A delay is not a debounce.</p>',
    parts.how ?? `<h2>How it works</h2>${FIG}`,
    parts.ex ?? '<h2>A concrete example</h2><pre data-lang="ts"><code>debounce(fetchResults, 300) // #fff in code is fine</code></pre>',
    parts.rule ?? '<h2>The rule that transfers</h2><p>Use it for bursts.</p>',
  ].join('\n');
const page = (content: string, tpl = template) => tpl.replace(/<!--\s*CONTENT[\s\S]*?-->/, content);
const PATH = '/h/artifacts/p/x.html';
const score = (html: string, over: Partial<ExplainerCase> = {}, extra: Partial<Parameters<typeof scorePage>[0]> = {}) =>
  scorePage({ page: html, template, case: { ...c, ...over }, files: 1, opened: [PATH], reply: PATH, path: PATH, ...extra });
const failed = (s: ReturnType<typeof scorePage>) => s.gates.filter((g) => !g.ok).map((g) => g.id);

describe('a page that keeps the contract', () => {
  it('passes every gate and reports its metrics', () => {
    const s = score(page(body()));
    expect(failed(s)).toEqual([]);
    expect(s.metrics.figures).toBe(1);
    expect(s.metrics.identifiers_used).toBe(1);
  });
  it('allows a rewritten lede and added CSS that uses role tokens', () => {
    const html = page(body()).replace(/<p class="lede">[\s\S]*?<\/p>/, '<p class="lede">A longer lede.</p>').replace('</style>\n</head>', '  .x{color:var(--dim)}\n</style>\n</head>');
    expect(failed(score(html))).toEqual([]);
  });
});

describe('the template', () => {
  it('fails when the comment is left in, the brand is touched or a script is added', () => {
    expect(failed(score(template))).toContain('template_intact');
    expect(failed(score(page(body()).replace('<span class="brand__name">Eklavya</span>', '')))).toContain('template_intact');
    expect(failed(score(page(`${body()}<script>parent.postMessage(1)</script>`)))).toContain('no_script_added');
  });
  it('fails a missing attempt link, the wrong kind and a second page', () => {
    expect(failed(score(page(body(), fill({ ATTEMPT: '' }))))).toContain('attempt_linked');
    expect(failed(score(page(body()), { attempt_id: undefined }))).toContain('attempt_linked');
    expect(failed(score(page(body(), fill({ KIND: 'artifact' }))))).toContain('metadata');
    expect(failed(score(page(body()), {}, { files: 2 }))).toContain('one_file');
  });
});

describe('sections', () => {
  it('reads paraphrased headings and keeps "went wrong" apart from the question', () => {
    expect(sectionOf('Where your answer went wrong')).toBe('wrong');
    expect(sectionOf('The question')).toBe('question');
    expect(sectionOf('In short')).toBe('short');
    expect(sectionOf('The rule that transfers')).toBe('rule');
    expect(sectionOf('The one mistake to watch for')).toBe('rule');
    expect(sectionOf('Why answer A is tempting')).toBe('wrong');
  });
  it('fails a missing or misplaced section', () => {
    expect(failed(score(page(body({ how: '' }))))).toContain('sections_in_order');
    const swapped = body({ short: '<h2>How it works</h2>' + FIG, how: '<h2>The short answer</h2><p>x</p>' });
    expect(failed(score(page(swapped)))).toContain('sections_in_order');
  });
  it('wants no "went wrong" section for "I don\'t know", and no question on a requested page', () => {
    expect(failed(score(page(body()), { pick: undefined, dont_know: true }))).toContain('sections_in_order');
    expect(failed(score(page(body({ wrong: '' })), { pick: undefined, dont_know: true, ...{} }))).not.toContain('sections_in_order');
    const asked = { stem: undefined, options: undefined, notes: undefined, pick: undefined, right: undefined, request: 'explain it' };
    expect(failed(score(page(body({ q: '', wrong: '' })), asked))).toEqual([]);
    expect(failed(score(page(body({ wrong: '' })), asked))).toContain('sections_in_order');
  });
});

describe('the short answer', () => {
  it('counts sentences without splitting on versions or abbreviations', () => {
    expect(sentenceCount('Before Go 1.22, one i was shared. It printed 3 3 3.')).toBe(2);
    expect(sentenceCount('It waits, e.g. for typing to stop. Then it runs once!')).toBe(2);
    expect(sentenceCount('It asks "is it still this?" The server says no.')).toBe(2);
  });
  it('fails past three sentences', () => {
    const long = '<h2>The short answer</h2><p>One. Two. Three. Four.</p>';
    expect(failed(score(page(body({ short: long }))))).toContain('short_answer_brief');
  });
});

describe('options', () => {
  it('fails a reworded option, a dropped note or a missing option', () => {
    const reworded = options(undefined, ['Five', 'One', 'Two', 'None']);
    expect(failed(score(page(body({ q: `<h2>The question</h2>${reworded}` }))))).toContain('options_verbatim');
    expect(failed(score(page(body({ q: `<h2>The question</h2>${options().replace('<span class="note">Restarts the timer</span>', '')}` }))))).toContain('options_verbatim');
    expect(failed(score(page(body({ q: `<h2>The question</h2>${options().replace(/<li>None.*?<\/li>/, '')}` }))))).toContain('options_verbatim');
  });
  it('fails the pick or the right answer on the wrong item', () => {
    expect(failed(score(page(body({ q: `<h2>The question</h2>${options(['right', 'picked', '', ''])}` }))))).toContain('option_classes');
  });
  it('wants a typed answer as one more picked item after the options', () => {
    const typed = 'it fires five times';
    const list = options(['', 'right', '', '']).replace('</ol>', `<li class="picked">${typed}</li></ol>`);
    expect(failed(score(page(body({ q: `<h2>The question</h2>${list}` })), { pick: undefined, typed }))).toEqual([]);
    expect(failed(score(page(body()), { pick: undefined, typed }))).toContain('option_classes');
  });
  it('accepts a typed answer and the right answer as a two-item list when no options were offered', () => {
    const open = { options: undefined, notes: undefined, pick: undefined, typed: '0 1 2', right: 'Usually 3 3 3' };
    const list = '<ol class="options"><li class="picked">0 1 2</li><li class="right">Usually 3 3 3</li></ol>';
    expect(failed(score(page(body({ q: `<h2>The question</h2>${list}` })), open))).toEqual([]);
  });
});

describe('figures, examples and colour', () => {
  it('needs an SVG figure with a caption and the template classes', () => {
    expect(failed(score(page(body({ how: '<h2>How it works</h2><figure><svg></svg></figure>' }))))).toContain('figure_svg');
  });
  it('needs a labelled example in the case language', () => {
    expect(failed(score(page(body()), { lang: 'py|python' }))).toContain('example_labelled');
  });
  it('fails a raw colour in a style or SVG attribute, not one inside the code', () => {
    expect(failed(score(page(body({ rule: '<h2>The rule</h2><p style="color:#ff0000">x</p>' }))))).toContain('tokens_only');
    expect(failed(score(page(body({ rule: '<h2>The rule</h2><svg><rect fill="white"/></svg>' }))))).toContain('tokens_only');
    expect(failed(score(page(body({ rule: '<h2>The rule</h2><svg><rect fill="none" stroke="currentColor"/></svg>' }))))).not.toContain('tokens_only');
  });
  it('fails emoji, an unopened page and a reply that is more than the path', () => {
    expect(failed(score(page(body({ rule: '<h2>The rule</h2><p>Remember this \u{1F680}</p>' }))))).toContain('no_emoji');
    expect(failed(score(page(body()), {}, { opened: [] }))).toContain('opened');
    expect(failed(score(page(body()), {}, { reply: `Done.\n\nHere it is:\n${PATH}` }))).toContain('path_reply');
  });
});

describe('contentOf and summarise', () => {
  it('returns exactly what replaced the comment', () => {
    expect(contentOf(page('<p>hi</p>'), template)).toBe('<p>hi</p>');
  });
  it('counts clean trials and failing gates', () => {
    const s = summarise([
      { case: 'a', trial: 0, gates: [{ id: 'x', ok: true, detail: '' }] },
      { case: 'a', trial: 1, gates: [{ id: 'x', ok: false, detail: '' }] },
      { case: 'b', trial: 0, error: 'timeout', gates: [] },
    ]);
    expect(s).toMatchObject({ trials: 3, clean: 1, errored: 1, failed: { x: 1 } });
  });
});

describe('the brief', () => {
  it('carries every field of the tutor handoff, lettered, with the code', () => {
    const b = brief({ ...c, code: 'debounce(fetchResults, 300)' });
    expect(b).toContain('[Eklavya explainer handoff]');
    expect(b).toContain('options: A. Five | B. One, after the last keystroke | C. Two | D. None');
    expect(b).toContain('option_notes: Delays every call | Restarts the timer | none | Forgets the timer');
    expect(b).toContain('learner answer: A. Five');
    expect(b).toContain('right answer: B. One, after the last keystroke');
    expect(b).toContain('attempt_id: 413');
    expect(b).toContain('debounce(fetchResults, 300)');
  });
  it('says "I don\'t know", passes a typed answer through, and has no handoff for a requested page', () => {
    expect(brief({ ...c, pick: undefined, dont_know: true })).toContain("learner answer: I don't know");
    expect(brief({ ...c, options: undefined, notes: undefined, pick: undefined, typed: '0 1 2', right: '3 3 3' })).toMatch(/options: none \(typed answer\)[\s\S]*learner answer: 0 1 2[\s\S]*right answer: 3 3 3/);
    const asked = brief({ id: 'x', concept: c.concept, request: 'explain ETags', code: 'res.status(304)' });
    expect(asked).not.toContain('handoff');
    expect(asked).toContain('explain ETags');
  });
});

describe('pointHome', () => {
  it('points both paths at the trial and throws when the agent file stops naming one', () => {
    const out = pointHome(`read ${SKILL_PATH} then ${RUNTIME_BIN}`, { skill: '/t/SKILL.md', runtimeBin: '/t/eklavya' }, true);
    expect(out).toBe('read /t/SKILL.md then /t/eklavya');
    expect(() => pointHome(`only ${RUNTIME_BIN}`, { skill: '/t/SKILL.md', runtimeBin: '/t/eklavya' }, true)).toThrow(/no longer names/);
    expect(pointHome('no paths here', { runtimeBin: '/t/eklavya' }, false)).toBe('no paths here');
  });
  it('still finds both paths in the shipped agent file', () => {
    const agent = fs.readFileSync(path.join(here, '..', '..', 'agents', 'explainer.md'), 'utf8');
    expect(() => pointHome(agent, { skill: '/t/SKILL.md', runtimeBin: '/t/eklavya' }, true)).not.toThrow();
  });
});

describe('edges', () => {
  it('decodes numeric and named entities and leaves unknown ones', () => {
    expect(text('&#65;&#x42;&#X43; &amp; &bogus; \u2019x\u201d')).toBe('ABC & &bogus; \'x"');
  });
  it('briefs a case with no attempt, no right answer and no code', () => {
    const b = brief({ id: 'x', concept: c.concept, stem: 'Why?', typed: 'no idea' });
    expect(b).toContain('attempt_id: none');
    expect(b).toMatch(/right answer: \n/);
    expect(brief({ id: 'x', concept: c.concept, request: 'explain it' })).toMatch(/The code it is about:\n$/);
  });
  it('reads no section from an unrelated heading, and no content from a template without the comment', () => {
    expect(sectionOf('Background')).toBeNull();
    expect(contentOf(page(body()), '<html></html>')).toBeNull();
    expect(sectionText(template.replace(/<!--\s*CONTENT[\s\S]*?-->/, '<p>no headings</p>'), template)).toEqual({});
  });
  it('fails the metadata gate when the template carries no metadata', () => {
    const bare = template.replace(/<meta name="eklavya:[a-z]+" content="[^"]*">\n/g, '');
    expect(failed(scorePage({ page: page(body(), bare), template: bare, case: c, files: 1, opened: [PATH], reply: PATH, path: PATH }))).toEqual(expect.arrayContaining(['metadata', 'attempt_linked']));
  });
  it('scores a case with no notes, language or identifiers, and a page with no figure', () => {
    const plain = { ...c, notes: undefined, lang: undefined, identifiers: undefined };
    const noNotes = options().replace(/<span class="note">[^<]*<\/span>/g, '');
    const s = score(page(body({ q: `<h2>The question</h2>${noNotes}`, how: '<h2>How it works</h2><p>words</p>' })), plain);
    expect(failed(s)).toEqual(['figure_svg']);
    expect(s.metrics).toMatchObject({ figures: 0, identifiers_offered: 0, identifiers_used: 0 });
  });
  it('accepts "I don\'t know" as one more picked item, and fails a typed open answer marked wrongly', () => {
    const idk = options(['', 'right', '', '']).replace('</ol>', '<li class="picked">I don\'t know</li></ol>');
    expect(failed(score(page(body({ q: `<h2>The question</h2>${idk}`, wrong: '' })), { pick: undefined, dont_know: true }))).toEqual([]);
    const open = { options: undefined, notes: undefined, pick: undefined, typed: '0 1 2', right: 'Usually 3 3 3' };
    const swapped = '<ol class="options"><li class="right">0 1 2</li></ol>';
    expect(failed(score(page(body({ q: `<h2>The question</h2>${swapped}` })), open))).toEqual(expect.arrayContaining(['options_verbatim', 'option_classes']));
    // "I don't know" to an open question: no typed words, so any picked item matches.
    const blank = '<ol class="options"><li class="picked">I don\'t know</li><li class="right">Usually 3 3 3</li></ol>';
    expect(failed(score(page(body({ q: `<h2>The question</h2>${blank}`, wrong: '' })), { ...open, typed: undefined, dont_know: true }))).toEqual([]);
  });
});

describe('the explainer fixtures', () => {
  const file = path.join(here, '..', '..', 'eval', 'fixtures', 'explainer', 'cases.json');
  const { cases } = JSON.parse(fs.readFileSync(file, 'utf8')) as { cases: (ExplainerCase & { binary?: string })[] };
  it('have unique ids and briefs the scorer can check', () => {
    expect(new Set(cases.map((x) => x.id)).size).toBe(cases.length);
    for (const x of cases) {
      expect(x.request || x.stem).toBeTruthy();
      if (x.options) {
        expect(x.notes?.length ?? x.options.length).toBe(x.options.length);
        expect(typeof x.right).toBe('number');
        expect(x.right as number).toBeLessThan(x.options.length);
        if (x.pick !== undefined) expect(x.pick).toBeLessThan(x.options.length);
      }
      if (x.lang) expect(() => new RegExp(x.lang!)).not.toThrow();
      // The own-code metric means nothing if a name is not in the code the agent is handed.
      for (const id of x.identifiers ?? []) expect(x.code, `${x.id}: ${id}`).toContain(id);
    }
  });
  it('cover each brief the issue names', () => {
    expect(cases.some((x) => x.pick !== undefined)).toBe(true);
    expect(cases.some((x) => x.dont_know)).toBe(true);
    expect(cases.some((x) => x.typed && x.options)).toBe(true);
    expect(cases.some((x) => x.typed && !x.options)).toBe(true);
    expect(cases.some((x) => x.request)).toBe(true);
    expect(cases.some((x) => x.binary === 'runtime')).toBe(true);
    expect(cases.filter((x) => x.lang && !/ts/.test(x.lang)).length).toBeGreaterThan(0);
  });
});
