import test from 'node:test';
import assert from 'node:assert/strict';
import { wordCount, lineCount, stats } from '../src/stats.js';

test('counts words separated by spaces', () => {
  assert.equal(wordCount('one two three'), 3);
});

test('counts lines', () => {
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount(''), 0);
});

test('stats combines the counts', () => {
  assert.deepEqual(stats('hi there'), { words: 2, lines: 1, chars: 8 });
});
