/**
 * The informative words of a piece of text (issue #258).
 *
 * The prompt gate used to AND every word of the whole prompt, stopwords
 * included, so "can you look at why the retry loop in fetchUser keeps timing
 * out" matched only an entry that also said "can", "you", "look" and "why".
 * This module keeps what names the subject: identifiers split on case and
 * underscores (`fetchUser` gives `fetch`, `user` and `fetchuser`), file names
 * and their stems, and ordinary words that are not on the stopword list.
 *
 * Pure: no database, no clock. The gate and the `local-hash-v2` embedder both
 * read it, so a word that counts for one counts for the other.
 */

/**
 * Common English function words, chat filler and coding-request verbs that
 * appear in almost every prompt and so tell the gate nothing. Kept short and
 * explicit rather than borrowed from a library: a word on this list can never
 * open the gate, so each one is a decision.
 */
export const STOPWORDS = new Set(
  (
    'a about above after again all also am an and any are as at be because been before being below between both but by ' +
    'can could did do does doing done down during each else even ever every few for from further get gets got had has ' +
    'have having he her here hers him his how however i if in into is it its itself just let lets like make makes may me ' +
    'might more most much must my need needs no nor not now of off on once one only or other our ours out over own ' +
    'please same see she should so some such than that the their theirs them then there these they thing things this ' +
    'those through to too under until up us use used using very want wants was way we well were what when where which ' +
    'while who whom why will with would yes yet you your yours ' +
    // Request verbs and filler that describe asking, not the subject.
    'add check fix help keep keeps kept look looks run try tell show work works working change changes update thanks thank ok okay ' +
    'sure still again also going go gonna actually maybe something anything everything stuff kind sort bit'
  ).split(/\s+/),
);

/** A path or file name: contains a slash, or ends in a short extension. */
const FILE_LIKE = /^[\w@.~-]*(?:\/[\w@.~-]+)+\/?$|^[\w@~-]+\.[a-z][a-z0-9]{0,5}$/i;

/** `fetchUserById` → fetch, user, by, id. `HTTPServer` → http, server. */
export function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((p) => p.toLowerCase())
    .filter(Boolean);
}

const keep = (t: string) => t.length > 2 && !STOPWORDS.has(t) && !/^\d+$/.test(t);

/**
 * Informative terms, lowercased and unique, in first-seen order.
 *
 * A path contributes its file name and the file's stem as whole terms (the
 * FTS index splits `recall.ts` into `recall` and `ts`, so the stem is what
 * matches) and the parts of each segment. An identifier contributes itself
 * whole as well as its parts, because an entry may spell it either way.
 */
export function informativeTerms(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (t: string) => {
    if (!keep(t) || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const raw of text.split(/[\s"'`()[\]{}<>,;:!?=]+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}_/~.@-]+|[^\p{L}\p{N}_]+$/gu, '');
    if (!word) continue;
    if (FILE_LIKE.test(word)) {
      const base = word.split('/').filter(Boolean).pop()!;
      const stem = base.replace(/\.[^.]+$/, '');
      push(stem.toLowerCase());
      for (const segment of word.split('/')) for (const part of splitIdentifier(segment)) push(part);
      continue;
    }
    for (const token of word.split(/[^\p{L}\p{N}_-]+/u)) {
      if (!token) continue;
      const parts = splitIdentifier(token);
      // The joined identifier first: `fetchUser` is the term most likely to be
      // spelled the same way in an entry about it.
      if (parts.length > 1) push(token.replace(/[-_]/g, '').toLowerCase());
      for (const part of parts) push(part);
    }
  }
  return out;
}
