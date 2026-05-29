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
const { wsHub } = await import('./ws-hub.js');
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

test('POST /rooms/:roomId/messages creates a task for clear create-task intent', async () => {
  const project = projectRepo.create({
    name: 'Task Router Create Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-router-create-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ content: '新建任务：整理发布说明' }),
  });

  assert.equal(res.status, 201);
  const message = await res.json() as { id: string; metadata: string | null };
  const metadata = JSON.parse(message.metadata ?? '{}') as {
    task_id?: string;
    route_result?: { action: string; taskId: string | null; reason: string };
  };
  assert.equal(metadata.route_result?.action, 'create_task');
  assert.ok(metadata.task_id);

  const tasks = taskRepo.listByRoom(room.id);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]?.id, metadata.task_id);
  assert.equal(tasks[0]?.title, '整理发布说明');
  assert.equal(tasks[0]?.source_message_id, message.id);
  assert.equal(tasks[0]?.created_from, 'chat_plan');

  const events = taskEventRepo.listByTask(tasks[0]!.id, { layer: 'activity' });
  assert.equal(events.some((event) => event.type === 'task_created'), true);
});

test('POST /rooms/:roomId/tasks/:taskId/activate broadcasts task activation', async () => {
  const project = projectRepo.create({
    name: 'Task Activate Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-task-activate-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Activated task' });
  const events = captureRoomEvents(room.id);

  try {
    const res = await request(`/api/rooms/${room.id}/tasks/${task.id}/activate`, { method: 'POST' });

    assert.equal(res.status, 200);
    const body = await res.json() as { taskId: string };
    assert.equal(body.taskId, task.id);
    assert.deepEqual(events.find((event) => event.type === 'task:activated'), {
      type: 'task:activated',
      roomId: room.id,
      taskId: task.id,
    });
  } finally {
    events.restore();
  }
});

function captureRoomEvents(roomId: string): import('./types.js').WsServerEvent[] & { restore: () => void } {
  const original = wsHub.broadcast.bind(wsHub);
  const events: import('./types.js').WsServerEvent[] & { restore: () => void } = [] as never;
  wsHub.broadcast = ((targetRoomId, event) => {
    if (targetRoomId === roomId) events.push(event);
    return original(targetRoomId, event);
  }) as typeof wsHub.broadcast;
  events.restore = () => {
    wsHub.broadcast = original as typeof wsHub.broadcast;
  };
  return events;
}
