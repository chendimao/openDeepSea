import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskEvent } from '../../lib/types';
import { createTaskActionStates } from './taskActionState';

test('createTaskActionStates folds task action events by task seq before status overwrite', () => {
  const completed = taskEvent({
    id: 'event-completed',
    seq: 2,
    payload: { task_action: 'start_execution', task_action_status: 'completed' },
  });
  const running = taskEvent({
    id: 'event-running',
    seq: 1,
    payload: { task_action: 'start_execution', task_action_status: 'running' },
  });

  const states = createTaskActionStates([completed, running], null);

  assert.equal(states.start_execution?.status, 'completed');
});

function taskEvent(input: Partial<TaskEvent>): TaskEvent {
  return {
    id: input.id ?? 'event-1',
    task_id: input.task_id ?? 'task-1',
    room_id: input.room_id ?? 'room-1',
    seq: input.seq ?? 1,
    type: input.type ?? 'task_updated',
    layer: input.layer ?? 'timeline',
    payload: input.payload ?? {},
    source_run_id: input.source_run_id ?? null,
    created_at: input.created_at ?? 1000,
  };
}
