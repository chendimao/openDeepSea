import assert from 'node:assert/strict';
import test from 'node:test';
import { detectActiveTrigger } from './prompt-area-engine';
import type { TriggerConfig } from './types';

const triggers: TriggerConfig[] = [
  { char: '@', position: 'any', mode: 'dropdown' },
  { char: '/', position: 'start', mode: 'dropdown' },
];

test('detectActiveTrigger detects mention trigger at the beginning of a message', () => {
  assert.deepEqual(detectActiveTrigger('@', 1, triggers), {
    config: triggers[0],
    startOffset: 0,
    query: '',
  });
});

test('detectActiveTrigger detects mention trigger after whitespace', () => {
  assert.deepEqual(detectActiveTrigger('ask @pla', 8, triggers), {
    config: triggers[0],
    startOffset: 4,
    query: 'pla',
  });
});

test('detectActiveTrigger detects slash command trigger only at line start', () => {
  assert.deepEqual(detectActiveTrigger('/ta', 3, triggers), {
    config: triggers[1],
    startOffset: 0,
    query: 'ta',
  });
  assert.equal(detectActiveTrigger('ask /ta', 7, triggers), null);
});
