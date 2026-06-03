import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPendingTaskExecution } from './ActiveTaskSurface';
import type { Message } from '../../lib/types';

function createMessage(input: Partial<Message> & { id: string; created_at: number }): Message {
  return {
    id: input.id,
    room_id: 'room-1',
    sender_type: input.sender_type ?? 'agent',
    sender_id: input.sender_id ?? 'planner',
    sender_name: input.sender_name ?? '规划师',
    content: input.content ?? '',
    message_type: 'text',
    layer: 'chat',
    metadata: input.metadata ?? null,
    created_at: input.created_at,
  };
}

test('selectPendingTaskExecution returns latest awaiting decision', () => {
  const decision = {
    state: 'needs_boundary_confirmation',
    status: 'suggested',
    summary: '等待确认边界',
    next_steps: [{ agent_id: 'planner', goal: '确认边界' }],
  };

  assert.deepEqual(selectPendingTaskExecution([
    createMessage({
      id: 'planner-1',
      created_at: 10,
      metadata: JSON.stringify({ task_execution: decision }),
    }),
  ]), decision);
});

test('selectPendingTaskExecution clears awaiting decision after user replies', () => {
  const decision = {
    state: 'needs_boundary_confirmation',
    status: 'suggested',
    summary: '等待确认边界',
    next_steps: [{ agent_id: 'planner', goal: '确认边界' }],
  };

  assert.equal(selectPendingTaskExecution([
    createMessage({
      id: 'planner-1',
      created_at: 10,
      metadata: JSON.stringify({ task_execution: decision }),
    }),
    createMessage({
      id: 'user-confirm',
      sender_type: 'user',
      sender_id: 'user',
      sender_name: 'You',
      content: '确定',
      created_at: 20,
    }),
  ]), null);
});
