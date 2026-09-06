/**
 * Paints the product's name in the accent, everywhere the manual says it.
 *
 * The name is the one word on a documentation page that is never a general
 * English word, and a reader skimming for "does this page talk about the tool
 * or about my repo?" is answered by the colour before they read the sentence.
 * Doing it by hand would mean 51 spans across 17 pages today and a missed one
 * on every page written after — so it happens at build time, over the rendered
 * tree, and a new page gets it for free.
 *
 * Deliberately narrow, because the failure mode is accent everywhere and accent
 * therefore nowhere:
 *
 * - Capital `Eklavya` only. Lowercase `eklavya` is a binary, a slug or a config
 *   key — `eklavya dashboard`, `/eklavya:quiz`, `.eklavya.json` — and those are
 *   code, not the product's name.
 * - Never inside `code`, `pre` or `kbd`: a command is monospace and stays that
 *   colour, or the syntax theme starts fighting the brand.
 * - Never inside `a`: links already carry the accent, and nesting a second
 *   colour inside one is how a link stops looking like a link.
 * - Never as part of a longer token — `eklavya-run.web.app`, `Eklavya's` is
 *   fine but `EklavyaFoo` is not the name.
 *
 * The one place this cannot reach is the page's own `<h1>`, which Starlight
 * renders from frontmatter rather than from Markdown. `src/components/
 * PageTitle.astro` does that half.
 */

/** Subtrees whose text is code, a keystroke, or already accented. */
const SKIP = new Set(['code', 'pre', 'kbd', 'samp', 'a', 'script', 'style']);

/**
 * Word boundaries, hand-rolled rather than `\b`: `\b` would match inside
 * `eklavya-run` and `/eklavya:quiz`, which are names of other things.
 */
const NAME = /(?<![\w./:-])Eklavya(?![\w./:-])/g;

const brandSpan = (value) => ({
  type: 'element',
  tagName: 'span',
  properties: { className: ['brand-word'] },
  children: [{ type: 'text', value }],
});

/** Splits one text node into text / span / text …, or returns null if untouched. */
function split(value) {
  NAME.lastIndex = 0;
  if (!NAME.test(value)) return null;
  NAME.lastIndex = 0;

  const out = [];
  let last = 0;
  let match;
  while ((match = NAME.exec(value)) !== null) {
    if (match.index > last) out.push({ type: 'text', value: value.slice(last, match.index) });
    out.push(brandSpan(match[0]));
    last = match.index + match[0].length;
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) });
  return out;
}

export default function rehypeBrand() {
  return (tree) => {
    const walk = (node) => {
      if (!node.children) return;
      const next = [];
      for (const child of node.children) {
        if (child.type === 'text') {
          const parts = split(child.value);
          next.push(...(parts ?? [child]));
          continue;
        }
        if (child.type === 'element' && !SKIP.has(child.tagName)) walk(child);
        next.push(child);
      }
      node.children = next;
    };
    walk(tree);
  };
}
