import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-routes-')), 'test.db');

const express = (await import('express')).default;
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { taskEventRepo } = await import('./repos/task-events.js');
const { router, setMessageRouteDeps } = await import('./routes.js');

setMessageRouteDeps({
  dispatchUserMessage: async () => {},
});

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

test('POST /rooms/:roomId/messages records task routing metadata and activity event', async () => {
  const project = projectRepo.create({
    name: 'Task Router Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: '修复登录错误' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '登录错误还有一个边界要补' }),
  });

  assert.equal(res.status, 201);
  const message = await res.json() as { id: string; metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.task_id, task.id);
  assert.equal(metadata.route_result?.taskId, task.id);
  assert.equal(metadata.route_result?.action, 'append_to_task');

  const events = taskEventRepo.listByTask(task.id, { layer: 'activity' });
  const routeEvent = events.find((event) => event.type === 'message_routed');
  assert.ok(routeEvent);
  assert.equal(routeEvent.payload.message_id, message.id);
  assert.equal(routeEvent.payload.route_action, 'append_to_task');
});
