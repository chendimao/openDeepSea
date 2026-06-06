import assert from 'node:assert/strict';
import test from 'node:test';
import { getThinkingDurationPresentation } from './ChatMessageBubble';

test('getThinkingDurationPresentation formats active run thinking time', () => {
  const presentation = getThinkingDurationPresentation({
    status: 'running',
    started_at: 1_000,
    completed_at: null,
    updated_at: 1_000,
  }, 19_400);

  assert.deepEqual(presentation, { label: '思考中 18s', active: true });
});

test('getThinkingDurationPresentation formats completed run thinking time', () => {
  const presentation = getThinkingDurationPresentation({
    status: 'completed',
    started_at: 1_000,
    completed_at: 126_000,
    updated_at: 126_000,
  }, 200_000);

  assert.deepEqual(presentation, { label: '思考 2m 5s', active: false });
});
