import assert from 'node:assert/strict';
import test from 'node:test';
import { getRoutableActiveTaskId, selectChatLayerMessages } from './roomPageLogic';
import type { Message } from '../lib/types';

test('getRoutableActiveTaskId only returns active tasks that can receive new messages', () => {
  assert.equal(getRoutableActiveTaskId({ id: 'todo-task', status: 'todo' }), 'todo-task');
  assert.equal(getRoutableActiveTaskId({ id: 'running-task', status: 'in_progress' }), 'running-task');
  assert.equal(getRoutableActiveTaskId({ id: 'review-task', status: 'review' }), 'review-task');
  assert.equal(getRoutableActiveTaskId({ id: 'done-task', status: 'done' }), null);
  assert.equal(getRoutableActiveTaskId({ id: 'failed-task', status: 'failed' }), null);
  assert.equal(getRoutableActiveTaskId(null), null);
});

test('selectChatLayerMessages keeps chat and legacy messages out of task event layers', () => {
  const messages = [
    createMessage({ id: 'legacy' }),
    createMessage({ id: 'chat', layer: 'chat' }),
    createMessage({ id: 'activity', layer: 'activity' }),
    createMessage({ id: 'timeline', layer: 'timeline' }),
    createMessage({ id: 'runtime', layer: 'runtime' }),
    createMessage({ id: 'diff', layer: 'diff' }),
  ];

  assert.deepEqual(selectChatLayerMessages(messages).map((message) => message.id), ['legacy', 'chat']);
});

function createMessage(input: { id: string; layer?: Message['layer'] }): Message {
  return {
    id: input.id,
    room_id: 'room-1',
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content: input.id,
    message_type: 'system',
    layer: input.layer,
    metadata: null,
    created_at: 1,
  };
}
