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
