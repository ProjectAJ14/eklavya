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
function objectAt(text: string, start: number): { end: number; value: unknown } | undefined {
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
          return { end: i, value: JSON.parse(text.slice(start, i + 1)) };
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

export function extractJson(text: string): unknown | null {
  // Every candidate is parsed, rather than walking back with lastIndexOf:
  // `lastIndexOf('{', -1)` clamps to 0 and returns 0 again, so the obvious loop
  // never advances past a leading brace and cannot terminate.
  const found: { start: number; end: number; value: unknown }[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    const parsed = objectAt(text, i);
    if (parsed) found.push({ start: i, end: parsed.end, value: parsed.value });
  }
  if (found.length === 0) return null;

  // Outermost first, then latest. "Last object in the text" alone was wrong the
  // moment a reply nested one: for `{"concepts":[{...},{...}]}` the last `{` is
  // the final array element, and it parses perfectly -- so the caller got one
  // concept instead of the list and read it as an empty extraction.
  //
  // So: discard any object contained inside another, which leaves the wrappers;
  // then take the last of those, which is still the rule that skips an example
  // in a model's preamble.
  const outermost = found.filter(
    (a) => !found.some((b) => b !== a && b.start <= a.start && a.end <= b.end),
  );
  return outermost[outermost.length - 1]?.value ?? null;
}
