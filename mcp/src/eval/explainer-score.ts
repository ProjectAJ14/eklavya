/**
 * The deterministic half of the explainer eval.
 *
 * `agents/explainer.md` makes a dozen precise promises about the page it
 * writes: the sections and their order, every option restated verbatim with
 * the pick and the right one marked, a captioned inline-SVG figure, the
 * template left alone, the missed attempt linked, role tokens only. Nobody
 * reads the agent's transcript, so the page is the only evidence; this module
 * checks those promises against it. Whether the page is *clear* is left to the
 * judge in the harness, and to the metrics returned beside the gates.
 *
 * Pure like `conversation-score.ts`: no model, no files, no clock. Regex rather
 * than an HTML parser, because every page starts from one known template.
 */

/** One brief, in the shape the tutor hands the explainer. */
export interface ExplainerCase {
  id: string;
  concept: { slug: string; name: string };
  /** The question as asked. Absent for a page someone asked for. */
  stem?: string;
  options?: string[];
  /** One per option, same order; null where the question showed none. */
  notes?: (string | null)[];
  /** 0-based index of the option picked. */
  pick?: number;
  /** Their own words, when they typed an answer. */
  typed?: string;
  dont_know?: boolean;
  /** 0-based index into `options`, or the right answer's text when none were offered. */
  right?: number | string;
  attempt_id?: number;
  /** The developer's request, for a page nobody's question started. */
  request?: string;
  code?: string;
  /** The `data-lang` an example in the case's language should carry, as a regex. */
  lang?: string;
  /** Names from `code` a page grounded in the developer's work would use. */
  identifiers?: string[];
}

/** The home paths `agents/explainer.md` names, which the harness points at one trial's copies. */
export const SKILL_PATH = '~/.claude/skills/eklavya-artifacts/SKILL.md';
export const RUNTIME_BIN = '$HOME/.eklavya/runtime/node_modules/.bin/eklavya';

const letter = (i: number) => String.fromCharCode(65 + i);

/** The brief, in the shape of the tutor's handoff block (`agents/tutor.md`), plus the code. */
export function brief(c: ExplainerCase): string {
  if (c.request) {
    return [`The developer asked: "${c.request}"`, `concept: ${c.concept.slug} (${c.concept.name})`, '', 'The code it is about:', c.code ?? ''].join('\n');
  }
  const opts = c.options ?? [];
  const answer = c.dont_know ? "I don't know" : c.typed !== undefined ? c.typed : `${letter(c.pick!)}. ${opts[c.pick!]}`;
  const right = typeof c.right === 'number' ? `${letter(c.right)}. ${opts[c.right]}` : String(c.right ?? '');
  return [
    'Write the explainer page for this missed question.',
    '',
    '[Eklavya explainer handoff]',
    `concept: ${c.concept.slug} (${c.concept.name})`,
    `question: ${c.stem}`,
    `options: ${opts.length ? opts.map((o, i) => `${letter(i)}. ${o}`).join(' | ') : 'none (typed answer)'}`,
    `option_notes: ${c.notes ? c.notes.map((n) => n ?? 'none').join(' | ') : 'none'}`,
    `learner answer: ${answer}`,
    `right answer: ${right}`,
    `attempt_id: ${c.attempt_id ?? 'none'}`,
    'context: none',
    '',
    'The code it came from:',
    c.code ?? '',
  ].join('\n');
}

/**
 * Points the home paths a prompt names at one trial's copies. Claude Code
 * cannot run under a throwaway HOME, so this is how a trial gets its own skill
 * and runtime binary. `strict` (the agent file) throws when a path is no longer
 * named, so a reworded prompt cannot run against the real home unnoticed.
 */
export function pointHome(text: string, to: { skill?: string; runtimeBin: string }, strict: boolean): string {
  const pairs: [string, string | undefined][] = [[SKILL_PATH, to.skill], [RUNTIME_BIN, to.runtimeBin]];
  let out = text;
  for (const [from, dest] of pairs) {
    if (dest === undefined) continue;
    if (strict && !out.includes(from)) throw new Error(`the prompt no longer names ${from}; update pointHome`);
    out = out.split(from).join(dest);
  }
  return out;
}

export interface Verdict {
  id: string;
  ok: boolean;
  detail: string;
}

export interface PageInput {
  /** The page as the agent left it. */
  page: string;
  /** The same file as `eklavya artifacts new` wrote it, before any edit. */
  template: string;
  case: ExplainerCase;
  /** HTML files under the trial's artifact folder. */
  files: number;
  /** Paths `eklavya artifacts open` was called with. */
  opened: string[];
  /** The agent's final reply. */
  reply: string;
  path: string;
}

export interface PageScore {
  gates: Verdict[];
  metrics: { words: number; figures: number; sections: string[]; identifiers_used: number; identifiers_offered: number };
}

const CONTENT = /<!--\s*CONTENT[\s\S]*?-->/;
const LEDE = /<p class="lede">[\s\S]*?<\/p>/;
const STYLE = /<style>([\s\S]*?)<\/style>/g;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
function decode(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
/** Visible text, whitespace collapsed and quotes straightened, so "verbatim" survives escaping. */
export function text(html: string): string {
  return decode(html.replace(/<[^>]+>/g, ' '))
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function meta(page: string, name: string): string | null {
  const m = new RegExp(`<meta\\s+name="eklavya:${name}"\\s+content="([^"]*)"`).exec(page);
  return m ? decode(m[1]!) : null;
}

/**
 * The page minus everything the agent may legitimately change -- the lede, and
 * CSS it adds -- so what is left must equal the template around the content.
 */
function frame(html: string): string {
  return html.replace(LEDE, '<p class="lede"></p>').replace(STYLE, '<style></style>');
}

/** The content the agent wrote, or null when the frame around it was touched. */
export function contentOf(page: string, template: string): string | null {
  const t = frame(template);
  const m = CONTENT.exec(t);
  if (!m) return null;
  const pre = t.slice(0, m.index);
  const post = t.slice(m.index + m[0].length);
  const p = frame(page);
  if (CONTENT.test(p) || p.length < pre.length + post.length || !p.startsWith(pre) || !p.endsWith(post)) return null;
  return p.slice(pre.length, p.length - post.length);
}

/** CSS lines in the page's `<style>` blocks that the template did not have. */
function addedCss(page: string, template: string): string {
  const had = new Set([...template.matchAll(STYLE)].flatMap((m) => m[1]!.split('\n').map((l) => l.trim())));
  return [...page.matchAll(STYLE)].flatMap((m) => m[1]!.split('\n').map((l) => l.trim()).filter((l) => l && !had.has(l))).join('\n');
}

type Section = 'question' | 'short' | 'wrong' | 'how' | 'example' | 'rule';
// Order matters: "Where the answer went wrong" must not read as the question.
const HEADINGS: [Section, RegExp][] = [
  ['short', /short answer|in short|short version|the gist|in one sentence|in a sentence/i],
  ['wrong', /wrong|misconception|tripped|tempting|mix-?up/i],
  ['how', /how .*works?\b|mechanism|under the hood|what actually happens/i],
  ['example', /example/i],
  ['rule', /rule|transfer|takeaway|gotcha|elsewhere|carry|next time|watch for/i],
  ['question', /question/i],
];
export function sectionOf(heading: string): Section | null {
  for (const [s, re] of HEADINGS) if (re.test(heading)) return s;
  return null;
}

const v = (id: string, ok: boolean, detail = ''): Verdict => ({ id, ok, detail });

function checkSections(found: (Section | null)[], c: ExplainerCase): Verdict {
  const want: Section[] = [];
  if (c.stem) want.push('question');
  want.push('short');
  const answered = !c.dont_know && (c.pick !== undefined || c.typed !== undefined);
  if (answered) want.push('wrong');
  want.push('how', 'example', 'rule');
  const at = want.map((s) => found.indexOf(s));
  const missing = want.filter((_, i) => at[i]! < 0);
  if (missing.length) return v('sections_in_order', false, `missing ${missing.join(', ')}`);
  for (let i = 1; i < at.length; i++) if (at[i]! < at[i - 1]!) return v('sections_in_order', false, `${want[i]} before ${want[i - 1]}`);
  if (!c.stem && found.includes('question')) return v('sections_in_order', false, 'a question section on a page nobody asked a question for');
  if (!answered && found.includes('wrong')) return v('sections_in_order', false, 'a "went wrong" section with no answer given');
  return v('sections_in_order', true);
}

interface Item {
  cls: string;
  body: string;
  note: string | null;
}
function items(content: string): Item[] | null {
  const ol = /<ol\s+class="options"[^>]*>([\s\S]*?)<\/ol>/.exec(content);
  if (!ol) return null;
  return [...ol[1]!.matchAll(/<li([^>]*)>([\s\S]*?)<\/li>/g)].map((m) => {
    const cls = /class="([^"]*)"/.exec(m[1]!)?.[1] ?? '';
    const note = /<span\s+class="note"[^>]*>([\s\S]*?)<\/span>/.exec(m[2]!);
    return { cls, body: text(m[2]!.replace(/<span\s+class="note"[^>]*>[\s\S]*?<\/span>/, '')), note: note ? text(note[1]!) : null };
  });
}
const has = (it: Item | undefined, c: string) => !!it && it.cls.split(/\s+/).includes(c);

function checkOptions(content: string, c: ExplainerCase): Verdict[] {
  if (!c.stem) return [];
  const list = items(content);
  if (!list) return [v('options_verbatim', false, 'no <ol class="options">'), v('option_classes', false, 'no list')];
  const opts = c.options ?? [];
  const out: Verdict[] = [];
  const picked = list.flatMap((it, i) => (has(it, 'picked') ? [i] : []));
  const right = list.flatMap((it, i) => (has(it, 'right') ? [i] : []));

  if (!opts.length) {
    // A typed answer to an open question: their words and the right answer, in one list.
    const typed = text(c.typed ?? '');
    const r = text(String(c.right ?? ''));
    const p = list[picked[0] ?? -1];
    const ok = picked.length === 1 && right.length === 1 && !!p && p.body.includes(typed) && list[right[0]!]!.body.includes(r);
    return [v('options_verbatim', list.length >= 2, `${list.length} items`), v('option_classes', ok, ok ? '' : `picked ${picked}, right ${right}`)];
  }

  // Every option in order, verbatim, then their own words when they typed instead.
  const extra = c.typed !== undefined ? 1 : 0;
  const wrongText = opts.flatMap((o, i) => (list[i]?.body === text(o) ? [] : [`${String.fromCharCode(65 + i)}: ${JSON.stringify(list[i]?.body ?? null)}`]));
  const countOk = list.length === opts.length + extra || (c.dont_know && list.length === opts.length + 1);
  const notesBad = (c.notes ?? []).flatMap((n, i) => (n && list[i]?.note !== text(n) ? [String.fromCharCode(65 + i)] : []));
  const detail = [!countOk && `${list.length} items for ${opts.length + extra}`, wrongText.length && `not verbatim ${wrongText.join('; ')}`, notesBad.length && `note missing or changed on ${notesBad.join(',')}`].filter(Boolean).join('; ');
  out.push(v('options_verbatim', !!countOk && !wrongText.length && !notesBad.length, detail));

  let wantPick: number | null = c.pick ?? null;
  if (c.typed !== undefined) wantPick = opts.length;
  const pickOk = c.dont_know ? picked.length === 0 || (picked.length === 1 && picked[0] === opts.length) : picked.length === 1 && picked[0] === wantPick;
  const typedOk = c.typed === undefined || list[opts.length]?.body.includes(text(c.typed)) === true;
  const rightOk = right.length === 1 && right[0] === c.right;
  out.push(v('option_classes', pickOk && rightOk && typedOk, pickOk && rightOk && typedOk ? '' : `picked ${JSON.stringify(picked)} want ${wantPick}, right ${JSON.stringify(right)} want ${c.right}${typedOk ? '' : ', typed answer not the extra item'}`));
  return out;
}

/** A raw colour where a role token belongs: hex, rgb/hsl, a `--vd-*` step, or a named fill. */
function rawColours(content: string, css: string): string[] {
  const bad: string[] = [];
  const styleAttrs = [...content.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]!).join('\n');
  for (const m of `${css}\n${styleAttrs}`.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(|--vd-[\w-]*/g)) bad.push(m[0]);
  for (const m of content.matchAll(/\s(?:fill|stroke|stop-color|color)="([^"]*)"/g)) {
    if (!/^(none|currentColor|transparent|inherit|var\(--[\w-]+\)|url\(#[\w-]+\))$/.test(m[1]!.trim())) bad.push(m[0].trim());
  }
  return bad;
}

/** Sentences end in . ! or ? before a space or the end; "Go 1.22" and "e.g." do not end one. */
export function sentenceCount(s: string): number {
  const t = s.replace(/\b(?:e\.g|i\.e|etc|vs)\./gi, '_').trim();
  return t ? t.split(/[.!?]["')\]]?(?:\s+|$)/).filter((x) => /\w/.test(x)).length : 0;
}

const EMOJI = /\p{Extended_Pictographic}/u;
const words = (s: string) => (s.match(/\S+/g) ?? []).length;

export function scorePage(input: PageInput): PageScore {
  const { page, template, case: c } = input;
  const gates: Verdict[] = [];
  gates.push(v('one_file', input.files === 1, `${input.files} pages`));
  const content = contentOf(page, template);
  gates.push(v('template_intact', content !== null, content === null ? 'the frame around <!-- CONTENT --> changed, or the comment is still there' : ''));
  const body = content ?? '';
  gates.push(v('no_script_added', !/<script\b/i.test(body), ''));

  const kind = meta(page, 'kind');
  const concept = meta(page, 'concept');
  const attempt = meta(page, 'attempt');
  const wantAttempt = c.attempt_id ? String(c.attempt_id) : '';
  gates.push(v('metadata', kind === 'explainer' && concept === c.concept.slug, `kind ${kind}, concept ${concept}`));
  gates.push(v('attempt_linked', attempt === wantAttempt, `attempt "${attempt}", want "${wantAttempt}"`));

  const headings = [...body.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)].map((m) => text(m[1]!));
  const found = headings.map(sectionOf);
  gates.push(checkSections(found, c));
  gates.push(...checkOptions(body, c));

  // "Two or three sentences a newcomer could repeat": countable, so counted.
  const short = sectionText(page, template).short ?? '';
  const sentences = sentenceCount(short);
  gates.push(v('short_answer_brief', sentences >= 1 && sentences <= 3, `${sentences} sentences`));

  const figures = [...body.matchAll(/<figure[^>]*>([\s\S]*?)<\/figure>/g)].map((m) => m[1]!);
  const good = figures.filter((f) => /<svg\b/.test(f) && /<figcaption[^>]*>[\s\S]*?\S[\s\S]*?<\/figcaption>/.test(f) && /class="[^"]*\bsvg-/.test(f));
  gates.push(v('figure_svg', good.length > 0 && /<svg\b/.test(figures[0] ?? ''), `${good.length}/${figures.length} figures with svg, caption and .svg-* classes`));

  const langs = [...body.matchAll(/<pre\s[^>]*data-lang="([^"]*)"/g)].map((m) => m[1]!);
  const langOk = langs.length > 0 && (!c.lang || langs.some((l) => new RegExp(`^(?:${c.lang})$`, 'i').test(l)));
  gates.push(v('example_labelled', langOk, `data-lang ${JSON.stringify(langs)}${c.lang ? `, want ${c.lang}` : ''}`));

  const bad = rawColours(body, addedCss(page, template));
  gates.push(v('tokens_only', bad.length === 0, bad.slice(0, 4).join(' ')));
  gates.push(v('no_emoji', !EMOJI.test(text(body)), ''));
  gates.push(v('opened', input.opened.includes(input.path), `opened ${JSON.stringify(input.opened)}`));
  const reply = input.reply.trim();
  gates.push(v('path_reply', reply.includes(input.path) && reply.split('\n').length <= 2, reply.slice(0, 120)));

  const plain = text(body.replace(/<svg[\s\S]*?<\/svg>/g, ' '));
  const used = (c.identifiers ?? []).filter((id) => body.includes(id));
  return {
    gates,
    metrics: { words: words(plain), figures: figures.length, sections: headings, identifiers_used: used.length, identifiers_offered: c.identifiers?.length ?? 0 },
  };
}

/** The text under each `<h2>`, by section, for the judge. */
export function sectionText(page: string, template: string): Partial<Record<Section, string>> {
  const body = contentOf(page, template) ?? '';
  const out: Partial<Record<Section, string>> = {};
  const parts = body.split(/(?=<h2[^>]*>)/);
  for (const part of parts) {
    const h = /<h2[^>]*>([\s\S]*?)<\/h2>/.exec(part);
    if (!h) continue;
    const s = sectionOf(text(h[1]!));
    if (s && !out[s]) out[s] = text(part.slice(h.index + h[0].length).replace(/<svg[\s\S]*?<\/svg>/g, ' '));
  }
  return out;
}

export interface TrialResult {
  case: string;
  trial: number;
  error?: string;
  gates: Verdict[];
  metrics?: PageScore['metrics'];
}

export function summarise(results: TrialResult[]) {
  const failed: Record<string, number> = {};
  let clean = 0;
  let errored = 0;
  const byCase: Record<string, { trials: number; clean: number }> = {};
  for (const r of results) {
    const row = (byCase[r.case] ??= { trials: 0, clean: 0 });
    row.trials += 1;
    if (r.error) {
      errored += 1;
      continue;
    }
    const bad = r.gates.filter((g) => !g.ok);
    for (const g of bad) failed[g.id] = (failed[g.id] ?? 0) + 1;
    if (!bad.length) {
      clean += 1;
      row.clean += 1;
    }
  }
  return { trials: results.length, clean, errored, failed, byCase };
}
