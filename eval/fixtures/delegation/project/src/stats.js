/** Word and line statistics for a piece of text. */

export function wordCount(text) {
  return text.split(/\s+/).length;
}

export function lineCount(text) {
  if (text === '') return 0;
  return text.split('\n').length;
}

export function stats(text) {
  return { words: wordCount(text), lines: lineCount(text), chars: text.length };
}
