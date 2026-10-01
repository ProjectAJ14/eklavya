import test from 'node:test';
import assert from 'node:assert/strict';
import { formatReport } from '../src/format.js';

test('formats a report', () => {
  assert.equal(formatReport({ words: 2, lines: 1, chars: 8 }), 'words: 2\nlines: 1\nchars: 8');
});
