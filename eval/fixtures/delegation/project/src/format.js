/** Turns a stats object into the lines the CLI prints. */

export function formatReport(s) {
  return [`words: ${s.words}`, `lines: ${s.lines}`, `chars: ${s.chars}`].join('\n');
}
