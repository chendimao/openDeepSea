import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTaskTimelineItems, describeTaskEvent, selectTaskDetailEvents, type TaskLayerVisibility } from './TaskDetailPanel';
import type { MessageLayer, Task, TaskEvent, TaskEventType } from '../lib/types';

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

test('describeTaskEvent explains message routing decisions from route payload', () => {
  const event = createEvent('message_routed', 'activity', {
    route_action: 'append_to_task',
    route_confidence: 0.9,
    route_reason: '使用当前激活任务：浏览器闭环测试',
  });

  assert.equal(describeTaskEvent(event, t), '使用当前激活任务：浏览器闭环测试 · 90%');
});

test('buildTaskTimelineItems merges task body with events by created_at ascending', () => {
  const task = createTask({
    description: '用户回复正文',
    created_at: 10,
  });
  const laterEvent = createEvent('runtime_event', 'runtime', { command: 'npm test' });
  laterEvent.id = 'event-later';
  laterEvent.created_at = 20;
  const earlierEvent = createEvent('task_created', 'activity');
  earlierEvent.id = 'event-earlier';
  earlierEvent.created_at = 5;

  const items = buildTaskTimelineItems(task, [laterEvent, earlierEvent], visible);

  assert.deepEqual(items.map((item) => item.id), ['event-earlier', 'task-body-task-1', 'event-later']);
  assert.equal(items[1]?.kind, 'body');
});

test('buildTaskTimelineItems hides task body when chat layer is disabled', () => {
  const task = createTask({
    description: '这段正文不应展示',
    created_at: 10,
  });

  const items = buildTaskTimelineItems(task, [], {
    ...visible,
    chat: false,
  });

  assert.deepEqual(items, []);
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

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    room_id: 'room-1',
    project_id: 'project-1',
    parent_task_id: null,
    title: '测试任务',
    description: null,
    status: 'todo',
    priority: 'normal',
    interaction_mode: 'ask_user',
    assigned_agent_id: null,
    source_message_id: null,
    created_from: 'manual',
    created_at: 1,
    updated_at: 1,
    completed_at: null,
    deleted_at: null,
    ...overrides,
  };
}

function t(key: string): string {
  return key;
}
