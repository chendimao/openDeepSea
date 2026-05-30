import assert from 'node:assert/strict';
import test from 'node:test';
import { describeTaskEvent, selectTaskDetailEvents, type TaskLayerVisibility } from './TaskDetailPanel';
import type { MessageLayer, TaskEvent, TaskEventType } from '../lib/types';

const visible: TaskLayerVisibility = {
  chat: true,
  activity: true,
  timeline: true,
  runtime: true,
  diff: true,
};

test('selectTaskDetailEvents groups task events by detail view and layer visibility', () => {
  const events = [
    createEvent('task_created', 'activity'),
    createEvent('workflow_plan_ready', 'timeline'),
    createEvent('workflow_completed', 'runtime'),
    createEvent('workflow_failed', 'diff'),
  ];

  const result = selectTaskDetailEvents(events, {
    ...visible,
    timeline: false,
    runtime: false,
  });

  assert.deepEqual(result.visibleEvents.map((event) => event.layer), ['activity', 'diff']);
  assert.deepEqual(result.planEvents, []);
  assert.deepEqual(result.timelineEvents.map((event) => event.layer), ['activity']);
  assert.deepEqual(result.diffEvents.map((event) => event.layer), ['diff']);
  assert.deepEqual(result.logEvents, []);
});

test('describeTaskEvent summarizes diff payload with changed file stats', () => {
  const event = createEvent('diff_detected', 'diff', {
    path: 'src/index.ts',
    additions: 2,
    deletions: 1,
    title: '修改 src/index.ts',
  });

  assert.equal(describeTaskEvent(event, t), 'src/index.ts · +2 / -1');
});

test('describeTaskEvent summarizes runtime tool and command payloads', () => {
  const tool = createEvent('runtime_event', 'runtime', {
    timeline_type: 'tool_call',
    name: 'read_file',
    input: '{"path":"README.md"}',
  });
  const command = createEvent('runtime_event', 'runtime', {
    timeline_type: 'command',
    command: 'npm test',
  });

  assert.equal(describeTaskEvent(tool, t), 'read_file · README.md');
  assert.equal(describeTaskEvent(command, t), 'npm test');
});

function createEvent(type: TaskEventType, layer: MessageLayer, payload: Record<string, unknown> = {}): TaskEvent {
  return {
    id: `${type}-${layer}`,
    task_id: 'task-1',
    room_id: 'room-1',
    seq: 1,
    type,
    layer,
    payload,
    source_run_id: null,
    created_at: 1,
  };
}

function t(key: string): string {
  return key;
}
