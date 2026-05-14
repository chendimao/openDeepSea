import test from 'node:test';
import assert from 'node:assert/strict';
import { formatPriorityLabel } from './priority-label.js';

test('formatPriorityLabel formats known priorities', () => {
  assert.equal(formatPriorityLabel('low'), '低');
  assert.equal(formatPriorityLabel('normal'), '普通');
  assert.equal(formatPriorityLabel('high'), '高');
  assert.equal(formatPriorityLabel('urgent'), '紧急');
});

test('formatPriorityLabel falls back to normal label for unknown priority', () => {
  assert.equal(formatPriorityLabel('unknown'), '普通');
});
