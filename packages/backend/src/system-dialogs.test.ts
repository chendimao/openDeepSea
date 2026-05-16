import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePickerOutput } from './system-dialogs.js';

test('parsePickerOutput returns selected directory path', () => {
  assert.deepEqual(parsePickerOutput('/Users/example/project\n'), {
    canceled: false,
    path: '/Users/example/project',
  });
});

test('parsePickerOutput treats empty output as canceled selection', () => {
  assert.deepEqual(parsePickerOutput(' \n'), { canceled: true });
});
