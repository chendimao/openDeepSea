import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyMessageStreamBatch,
  getRoutableActiveTaskId,
  projectRoomActivityMessages,
  selectChatLayerMessages,
  selectConversationMessages,
} from './roomPageLogic';
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

test('selectConversationMessages includes task cards without flooding activity events', () => {
  const messages = [
    createMessage({ id: 'legacy' }),
    createMessage({ id: 'chat', layer: 'chat' }),
    createMessage({
      id: 'task-created',
      layer: 'activity',
      metadata: JSON.stringify({ event_type: 'task_created', task_id: 'task-1' }),
    }),
    createMessage({
      id: 'task-status',
      layer: 'activity',
      metadata: JSON.stringify({ event_type: 'task_status_changed', task_id: 'task-1' }),
    }),
    createMessage({
      id: 'message-routed',
      layer: 'activity',
      metadata: JSON.stringify({ event_type: 'message_routed', task_id: 'task-1' }),
    }),
    createMessage({
      id: 'workflow-failed',
      layer: 'activity',
      metadata: JSON.stringify({ event_type: 'workflow_failed', task_id: 'task-1' }),
    }),
  ];

  assert.deepEqual(
    selectConversationMessages(messages).map((message) => message.id),
    ['legacy', 'chat', 'task-created', 'task-status'],
  );
});

test('applyMessageStreamBatch merges task ownership snapshots for routed user messages', () => {
  const messages = [
    createMessage({
      id: 'user-message',
      layer: 'chat',
      metadata: JSON.stringify({
        route_result: { action: 'create_task', taskId: null },
      }),
    }),
  ];

  const result = applyMessageStreamBatch(messages, [{
    messageId: 'user-message',
    chunk: '',
    done: true,
    message: createMessage({
      id: 'user-message',
      layer: 'chat',
      metadata: JSON.stringify({
        task_id: 'task-1',
        route_result: { action: 'create_task', taskId: 'task-1' },
      }),
    }),
  }]);

  assert.equal(result.matched, true);
  const metadata = JSON.parse(result.messages?.[0]?.metadata ?? '{}') as {
    task_id?: string;
    route_result?: { taskId?: string | null };
  };
  assert.equal(metadata.task_id, 'task-1');
  assert.equal(metadata.route_result?.taskId, 'task-1');
});

test('projectRoomActivityMessages turns room activity messages into activity feed events', () => {
  const messages = [
    createMessage({ id: 'chat', layer: 'chat' }),
    createMessage({
      id: 'task-created',
      layer: 'activity',
      metadata: JSON.stringify({
        event_type: 'task_created',
        task_id: 'task-1',
      }),
    }),
    createMessage({
      id: 'route-uncertain',
      layer: 'activity',
      content: '无法确定消息应归属哪个任务',
      metadata: JSON.stringify({
        event_type: 'message_route_uncertain',
        message_id: 'user-message',
        route_action: 'ask_user',
      }),
    }),
  ];

  const events = projectRoomActivityMessages(messages);

  assert.equal(events.length, 1);
  assert.equal(events[0]?.id, 'message:route-uncertain');
  assert.equal(events[0]?.type, 'message_route_uncertain');
  assert.equal(events[0]?.layer, 'activity');
  assert.equal(events[0]?.payload.message_id, 'user-message');
  assert.equal(events[0]?.payload.event_message_id, 'route-uncertain');
  assert.equal(events[0]?.payload.content, '无法确定消息应归属哪个任务');
});

function createMessage(input: {
  id: string;
  layer?: Message['layer'];
  content?: string;
  metadata?: string | null;
}): Message {
  return {
    id: input.id,
    room_id: 'room-1',
    sender_type: 'system',
    sender_id: 'system',
    sender_name: 'System',
    content: input.content ?? input.id,
    message_type: 'system',
    layer: input.layer,
    metadata: input.metadata ?? null,
    created_at: 1,
  };
}
