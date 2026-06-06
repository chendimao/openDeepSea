import assert from 'node:assert/strict';
import test from 'node:test';
import {
  commitEditedChip,
  commitEditedChipWithTriggerSearch,
  detectActiveTrigger,
} from './prompt-area-engine';
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

test('commitEditedChip keeps edited chip when text matches a suggestion', () => {
  const segments = [
    { type: 'text' as const, text: 'ask ' },
    { type: 'chip' as const, trigger: '@', value: 'planner', displayText: 'planner' },
    { type: 'text' as const, text: ' now' },
  ];
  const suggestions = [
    { value: 'frontend-executor', label: '前端执行者', data: { role: 'executor' } },
  ];

  assert.deepEqual(commitEditedChip(segments, 1, '前端执行者', suggestions), {
    segments: [
      { type: 'text', text: 'ask ' },
      {
        type: 'chip',
        trigger: '@',
        value: 'frontend-executor',
        displayText: '前端执行者',
        data: { role: 'executor' },
      },
      { type: 'text', text: ' now' },
    ],
    committed: {
      type: 'chip',
      trigger: '@',
      value: 'frontend-executor',
      displayText: '前端执行者',
      data: { role: 'executor' },
    },
    cursorOffset: 10,
  });
});

test('commitEditedChip converts edited chip to plain text when text has no suggestion match', () => {
  const segments = [
    { type: 'text' as const, text: 'ask ' },
    { type: 'chip' as const, trigger: '@', value: 'planner', displayText: 'planner' },
    { type: 'text' as const, text: ' now' },
  ];

  assert.deepEqual(commitEditedChip(segments, 1, 'nobody', []), {
    segments: [{ type: 'text', text: 'ask @nobody now' }],
    committed: { type: 'text', text: '@nobody' },
    cursorOffset: 11,
  });
});

test('commitEditedChipWithTriggerSearch matches edited chip text through its trigger search', async () => {
  const segments = [
    { type: 'text' as const, text: 'ask ' },
    { type: 'chip' as const, trigger: '@', value: 'planner', displayText: 'planner' },
    { type: 'text' as const, text: ' now' },
  ];

  const result = await commitEditedChipWithTriggerSearch(segments, 1, '前端执行者', [
    {
      char: '@',
      position: 'any',
      mode: 'dropdown',
      onSearch: (query) => {
        assert.equal(query, '前端执行者');
        return [{ value: 'frontend-executor', label: '前端执行者' }];
      },
    },
  ]);

  assert.deepEqual(result, {
    segments: [
      { type: 'text', text: 'ask ' },
      {
        type: 'chip',
        trigger: '@',
        value: 'frontend-executor',
        displayText: '前端执行者',
      },
      { type: 'text', text: ' now' },
    ],
    committed: {
      type: 'chip',
      trigger: '@',
      value: 'frontend-executor',
      displayText: '前端执行者',
    },
    cursorOffset: 10,
  });
});

test('commitEditedChipWithTriggerSearch converts edited chip to text when trigger search has no match', async () => {
  const segments = [
    { type: 'text' as const, text: 'ask ' },
    { type: 'chip' as const, trigger: '@', value: 'planner', displayText: 'planner' },
  ];

  const result = await commitEditedChipWithTriggerSearch(segments, 1, 'nobody', [
    {
      char: '@',
      position: 'any',
      mode: 'dropdown',
      onSearch: () => [{ value: 'frontend-executor', label: '前端执行者' }],
    },
  ]);

  assert.deepEqual(result, {
    segments: [{ type: 'text', text: 'ask @nobody' }],
    committed: { type: 'text', text: '@nobody' },
    cursorOffset: 11,
  });
});
