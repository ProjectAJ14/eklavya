/**
 * Pull the JSON object out of a model's reply.
 *
 * Lives here rather than in the harness because it is the only part of the eval
 * with parsing logic, and the harness is a script whose command dispatch runs on
 * import -- so a copy there is a copy no test can reach. That is not
 * hypothetical: the first version hung forever on a reply beginning with `{`,
 * and nothing could have caught it.
 *
 * Two rules, both learned from the shape of the replies:
 *
 * - **Last object first.** A model asked for JSON often narrates before it, so
 *   scanning back from the end finds the answer rather than an example inside
 *   the preamble.
 * - **Strings are not structure.** A question about code contains braces --
 *   `retry(() => {...})` in a stem, `${...}` in an option -- and counting those
 *   as depth is what made the first version fail to terminate. The scan tracks
 *   quoting and escaping, so a brace inside a string is just a character.
 */

/** Parse one candidate object starting at `start`, or `undefined` if it is not one. */
function objectAt(text: string, start: number): unknown | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function extractJson(text: string): unknown | null {
  // Collected up front rather than walked with lastIndexOf: `lastIndexOf('{', -1)`
  // clamps to 0 and returns 0 again, so the obvious loop never advances past a
  // leading brace. An index list cannot do that.
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] === '{') starts.push(i);

  for (let s = starts.length - 1; s >= 0; s--) {
    const found = objectAt(text, starts[s] as number);
    if (found !== undefined) return found;
  }
  return null;
}
