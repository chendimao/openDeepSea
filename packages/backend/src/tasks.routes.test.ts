import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-routes-')), 'test.db');

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

test('task CRUD routes list, create, update, and delete room tasks', async () => {
  const project = projectRepo.create({
    name: 'Tasks Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const existing = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Existing task' });

  const listBefore = await request(`/api/rooms/${room.id}/tasks`);
  assert.equal(listBefore.status, 200);
  const beforeBody = await listBefore.json() as Array<{ id: string }>;
  assert.deepEqual(beforeBody.map((task) => task.id), [existing.id]);

  const createRes = await request(`/api/rooms/${room.id}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Created task', priority: 'high' }),
  });
  assert.equal(createRes.status, 201);
  const created = await createRes.json() as { id: string; title: string; priority: string };
  assert.equal(created.title, 'Created task');
  assert.equal(created.priority, 'high');
  assert.equal(
    taskEventRepo.listByTask(created.id).some((event) => event.type === 'task_created' && event.layer === 'activity'),
    true,
  );

  const updateRes = await request(`/api/tasks/${created.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'in_progress', priority: 'urgent' }),
  });
  assert.equal(updateRes.status, 200);
  const updated = await updateRes.json() as { status: string; priority: string };
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.priority, 'urgent');

  const deleteRes = await request(`/api/tasks/${created.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);
  assert.equal(taskRepo.get(created.id), undefined);
});

test('task patch route rejects unsupported fields instead of ignoring them', async () => {
  const project = projectRepo.create({
    name: 'Tasks Patch Validation Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-patch-validation-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });
  const task = taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Patch target' });

  const res = await request(`/api/tasks/${task.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ parent_task_id: 'ignored-parent-id' }),
  });

  assert.equal(res.status, 400);
  const unchanged = taskRepo.get(task.id);
  assert.equal(unchanged?.parent_task_id, null);
});

test('conversation task route creates task and system event', async () => {
  const project = projectRepo.create({
    name: 'Tasks Conversation Route',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-tasks-conversation-route-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Room' });

  const res = await request(`/api/rooms/${room.id}/tasks/conversation`, {
    method: 'POST',
    body: JSON.stringify({ title: 'Conversation task', origin: 'manual' }),
  });

  assert.equal(res.status, 201);
  const body = await res.json() as { task: { title: string }; systemMessage: { metadata: string | null } };
  assert.equal(body.task.title, 'Conversation task');
  const metadata = JSON.parse(body.systemMessage.metadata ?? '{}') as { event_type?: string };
  assert.equal(metadata.event_type, 'task_created');
});
