import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-events-')), 'test.db');

const { db } = await import('../db.js');
const { taskEventRepo } = await import('./task-events.js');
const { projectRepo } = await import('./projects.js');
const { roomRepo } = await import('./rooms.js');
const { taskRepo } = await import('./tasks.js');

function createTaskFixture() {
  const project = projectRepo.create({
    name: `task-events-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-events-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({
    project_id: project.id,
    room_id: room.id,
    title: '事件流测试任务',
  });
  return { project, room, task };
}

test('taskEventRepo appends task events with monotonically increasing task-local seq', () => {
  const { room, task } = createTaskFixture();

  const first = taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'task_created',
    layer: 'activity',
    payload: { title: task.title },
    source_run_id: null,
  });
  const second = taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'workflow_stage_changed',
    layer: 'timeline',
    payload: { stage: 'analysis' },
    source_run_id: 'run-1',
  });

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.deepEqual(first.payload, { title: task.title });
  assert.deepEqual(second.payload, { stage: 'analysis' });
  assert.equal(second.source_run_id, 'run-1');

  const events = taskEventRepo.listByTask(task.id);
  assert.deepEqual(events.map((event) => event.id), [first.id, second.id]);
});

test('task_events table is append-only for repo callers', () => {
  const { room, task } = createTaskFixture();
  const event = taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'task_created',
    layer: 'activity',
    payload: {},
    source_run_id: null,
  });

  const exposedMethods = taskEventRepo as Record<string, unknown>;
  assert.equal(typeof exposedMethods.update, 'undefined');
  assert.equal(typeof exposedMethods.delete, 'undefined');

  const row = db.prepare('SELECT id, seq FROM task_events WHERE id = ?').get(event.id) as {
    id: string;
    seq: number;
  } | undefined;
  assert.deepEqual(row, { id: event.id, seq: 1 });
});

test('taskEventRepo createOnceByPayloadString reuses existing projected events', () => {
  const { room, task } = createTaskFixture();
  const first = taskEventRepo.createOnceByPayloadString('timeline_event_id', {
    task_id: task.id,
    room_id: room.id,
    type: 'runtime_event',
    layer: 'runtime',
    payload: {
      timeline_event_id: 'run-1:2',
      title: '读取文件',
    },
    source_run_id: 'run-1',
  });
  const second = taskEventRepo.createOnceByPayloadString('timeline_event_id', {
    task_id: task.id,
    room_id: room.id,
    type: 'runtime_event',
    layer: 'runtime',
    payload: {
      timeline_event_id: 'run-1:2',
      title: '重复读取文件',
    },
    source_run_id: 'run-1',
  });
  const third = taskEventRepo.createOnceByPayloadString('timeline_event_id', {
    task_id: task.id,
    room_id: room.id,
    type: 'runtime_event',
    layer: 'runtime',
    payload: {
      timeline_event_id: 'run-1:3',
      title: '执行命令',
    },
    source_run_id: 'run-1',
  });

  assert.equal(second.id, first.id);
  assert.equal(second.payload.title, '读取文件');
  assert.equal(third.seq, 2);
  assert.deepEqual(taskEventRepo.listByTask(task.id).map((event) => event.id), [first.id, third.id]);
});

test('taskEventRepo createOnceByPayloadString preserves exact payload key values', () => {
  const { room, task } = createTaskFixture();
  const first = taskEventRepo.createOnceByPayloadString('timeline_event_id', {
    task_id: task.id,
    room_id: room.id,
    type: 'runtime_event',
    layer: 'runtime',
    payload: {
      timeline_event_id: ' run-1:2 ',
      title: '读取文件',
    },
    source_run_id: 'run-1',
  });
  const second = taskEventRepo.createOnceByPayloadString('timeline_event_id', {
    task_id: task.id,
    room_id: room.id,
    type: 'runtime_event',
    layer: 'runtime',
    payload: {
      timeline_event_id: 'run-1:2',
      title: '执行命令',
    },
    source_run_id: 'run-1',
  });

  assert.notEqual(second.id, first.id);
  assert.deepEqual(taskEventRepo.listByTask(task.id).map((event) => event.id), [first.id, second.id]);
});

test('taskEventRepo createOnceByPayloadString falls back for unsafe payload keys', () => {
  const { room, task } = createTaskFixture();
  const first = taskEventRepo.createOnceByPayloadString('timeline.event.id', {
    task_id: task.id,
    room_id: room.id,
    type: 'runtime_event',
    layer: 'runtime',
    payload: {
      'timeline.event.id': 'run-1:2',
      title: '读取文件',
    },
    source_run_id: 'run-1',
  });
  const second = taskEventRepo.createOnceByPayloadString('timeline.event.id', {
    task_id: task.id,
    room_id: room.id,
    type: 'runtime_event',
    layer: 'runtime',
    payload: {
      'timeline.event.id': 'run-1:2',
      title: '重复读取文件',
    },
    source_run_id: 'run-1',
  });

  assert.notEqual(second.id, first.id);
  assert.deepEqual(taskEventRepo.listByTask(task.id).map((event) => event.id), [first.id, second.id]);
});
