import assert from 'node:assert/strict';
import test from 'node:test';
import { filterRootTasks, selectActivityEvents } from './taskBoardLogic';
import type { Task, TaskEvent } from '../lib/types';

test('filterRootTasks applies status filters and keeps newest root tasks first', () => {
  const tasks = [
    createTask({ id: 'child', parent_task_id: 'open', status: 'todo', updated_at: 40 }),
    createTask({ id: 'done', status: 'done', updated_at: 80 }),
    createTask({ id: 'open', status: 'in_progress', updated_at: 100 }),
    createTask({ id: 'review', status: 'review', updated_at: 60 }),
  ];

  const filtered = filterRootTasks(tasks, ['in_progress', 'review']);

  assert.deepEqual(filtered.map((task) => task.id), ['open', 'review']);
});

test('selectActivityEvents returns newest room activity events first', () => {
  const events = [
    createEvent({ id: 'runtime', layer: 'runtime', created_at: 30 }),
    createEvent({ id: 'old-activity', layer: 'activity', created_at: 10 }),
    createEvent({ id: 'new-activity', layer: 'activity', created_at: 50 }),
  ];

  const activity = selectActivityEvents(events, 2);

  assert.deepEqual(activity.map((event) => event.id), ['new-activity', 'old-activity']);
});

function createTask(input: Partial<Task>): Task {
  return {
    id: input.id ?? 'task',
    room_id: 'room',
    project_id: 'project',
    parent_task_id: input.parent_task_id ?? null,
    title: input.title ?? input.id ?? 'Task',
    description: null,
    status: input.status ?? 'todo',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: null,
    source_message_id: null,
    created_from: 'manual',
    created_at: 1,
    updated_at: input.updated_at ?? 1,
    completed_at: null,
    deleted_at: null,
  };
}

function createEvent(input: Partial<TaskEvent>): TaskEvent {
  return {
    id: input.id ?? 'event',
    task_id: 'task',
    room_id: 'room',
    seq: 1,
    type: input.type ?? 'task_created',
    layer: input.layer ?? 'activity',
    payload: {},
    source_run_id: null,
    created_at: input.created_at ?? 1,
  };
}
