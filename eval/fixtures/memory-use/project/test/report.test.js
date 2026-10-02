import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/report.js';

test('summarize adds amounts per category', () => {
  assert.deepEqual(summarize([{ category: 'a', amount: 2 }, { category: 'a', amount: 3 }, { category: 'b', amount: 1 }]), { a: 5, b: 1 });
});
