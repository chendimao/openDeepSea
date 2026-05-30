import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-events-routes-')), 'test.db');

const express = (await import('express')).default;
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { router } = await import('./routes.js');

const app = express();
app.use(express.json());
app.use('/api', router);

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('GET /rooms/:roomId/task-events returns task event projections filtered by task and layer', async () => {
  const project = projectRepo.create({
    name: 'Task Events Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-events-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const firstTask = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'First task' });
  const secondTask = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Second task' });
  const firstEvent = taskEventRepo.create({
    task_id: firstTask.id,
    room_id: room.id,
    type: 'task_created',
    layer: 'activity',
    payload: { task_title: firstTask.title },
  });
  taskEventRepo.create({
    task_id: firstTask.id,
    room_id: room.id,
    type: 'workflow_stage_changed',
    layer: 'timeline',
    payload: { stage: 'analysis' },
  });
  taskEventRepo.create({
    task_id: secondTask.id,
    room_id: room.id,
    type: 'task_created',
    layer: 'activity',
    payload: { task_title: secondTask.title },
  });

  const res = await request(`/api/rooms/${room.id}/task-events?taskId=${firstTask.id}&layer=activity`);

  assert.equal(res.status, 200);
  const body = await res.json() as { events: Array<{ id: string; task_id: string; layer: string; payload: unknown }> };
  assert.deepEqual(body.events.map((event) => event.id), [firstEvent.id]);
  assert.equal(body.events[0]?.task_id, firstTask.id);
  assert.equal(body.events[0]?.layer, 'activity');
  assert.deepEqual(body.events[0]?.payload, { task_title: firstTask.title });
});

test('GET /rooms/:roomId/task-events can include replayed task state for a task event stream', async () => {
  const project = projectRepo.create({
    name: 'Task Events Replay Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-events-replay-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Initial title' });
  taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'task_created',
    layer: 'activity',
    payload: {
      title: 'Initial title',
      description: 'Original description',
      priority: 'normal',
      interaction_mode: 'ask_user',
      status: 'todo',
      created_from: 'manual',
    },
  });
  taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'task_updated',
    layer: 'activity',
    payload: {
      changed_fields: ['title'],
      next_title: 'Replayed title',
    },
  });
  taskEventRepo.create({
    task_id: task.id,
    room_id: room.id,
    type: 'task_status_changed',
    layer: 'activity',
    payload: {
      previous_status: 'todo',
      next_status: 'review',
    },
  });

  const res = await request(`/api/rooms/${room.id}/task-events?taskId=${task.id}&replay=1`);

  assert.equal(res.status, 200);
  const body = await res.json() as {
    replay: {
      task_id: string;
      title: string;
      description: string;
      status: string;
      priority: string;
      deleted: boolean;
      last_seq: number;
    };
  };
  assert.equal(body.replay.task_id, task.id);
  assert.equal(body.replay.title, 'Replayed title');
  assert.equal(body.replay.description, 'Original description');
  assert.equal(body.replay.status, 'review');
  assert.equal(body.replay.priority, 'normal');
  assert.equal(body.replay.deleted, false);
  assert.equal(body.replay.last_seq, 3);
});
