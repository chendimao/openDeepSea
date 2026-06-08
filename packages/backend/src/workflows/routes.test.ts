import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-routes-')), 'test.db');

const { projectRepo } = await import('../repos/projects.js');
const { roomRepo } = await import('../repos/rooms.js');
const { taskRepo } = await import('../repos/tasks.js');
const { workflowRepo } = await import('../repos/workflows.js');
const { router } = await import('../routes.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

test('pure ACP mode disables legacy workflow mutation and detail routes', async () => {
  const { room, task } = createTask('Pure ACP Disabled Workflow Routes');
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: task.project_id,
    task_id: task.id,
  });
  const cases: Array<{ path: string; method?: string; feature: string }> = [
    { path: `/api/tasks/${task.id}/workflows`, method: 'POST', feature: 'workflow start route' },
    {
      path: `/api/rooms/${room.id}/tasks/${task.id}/workflows/start-with-conversation`,
      method: 'POST',
      feature: 'workflow conversation start route',
    },
    { path: `/api/workflows/${run.id}`, feature: 'workflow detail route' },
    { path: `/api/workflows/${run.id}/context`, feature: 'workflow context route' },
    { path: `/api/workflows/${run.id}/approve-plan`, method: 'POST', feature: 'workflow approve route' },
    {
      path: `/api/rooms/${room.id}/workflows/${run.id}/approve-plan-with-conversation`,
      method: 'POST',
      feature: 'workflow conversation approve route',
    },
    { path: `/api/workflows/${run.id}/decisions`, method: 'POST', feature: 'workflow decisions route' },
    { path: `/api/workflows/${run.id}/retry-step`, method: 'POST', feature: 'workflow retry route' },
    { path: `/api/workflows/${run.id}/cancel`, method: 'POST', feature: 'workflow cancel route' },
  ];

  for (const item of cases) {
    const res = await request(item.path, { method: item.method ?? 'GET' });
    assert.equal(res.status, 410, `${item.method ?? 'GET'} ${item.path}`);
    assert.deepEqual(await res.json(), { error: `pure ACP mode enabled: ${item.feature} is disabled` });
  }
});

test('workflow list routes remain available in pure ACP mode', async () => {
  const { room, task } = createTask('Pure ACP Workflow Lists');
  const run = workflowRepo.createRun({
    room_id: room.id,
    project_id: task.project_id,
    task_id: task.id,
    status: 'running',
  });

  const taskRes = await request(`/api/tasks/${task.id}/workflows`);
  assert.equal(taskRes.status, 200);
  assert.deepEqual((await taskRes.json() as Array<{ id: string }>).map((item) => item.id), [run.id]);

  const roomRes = await request(`/api/rooms/${room.id}/workflows`);
  assert.equal(roomRes.status, 200);
  assert.deepEqual((await roomRes.json() as Array<{ id: string }>).map((item) => item.id), [run.id]);
});

test('workflow list routes return 404 for missing owner', async () => {
  const taskRes = await request('/api/tasks/missing-task/workflows');
  assert.equal(taskRes.status, 404);
  assert.deepEqual(await taskRes.json(), { error: 'task not found' });

  const roomRes = await request('/api/rooms/missing-room/workflows');
  assert.equal(roomRes.status, 404);
  assert.deepEqual(await roomRes.json(), { error: 'room not found' });
});

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

function createTask(name: string) {
  const projectPath = join(tmpdir(), `workflow-routes-${name.replace(/\W+/g, '-')}-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name, path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: `${name} Room` });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: name,
  });
  return { project, room, task };
}
