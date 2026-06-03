import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-system-context-routes-')), 'test.db');

const express = (await import('express')).default;
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { taskRepo } = await import('./repos/tasks.js');
const { router } = await import('./routes.js');

const app = express();
app.use(express.json());
app.use('/api', router);

function createProjectPath(name: string): string {
  const path = join(tmpdir(), `openclaw-room-context-routes-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path, { recursive: true });
  return path;
}

async function request(path: string): Promise<Response> {
  const server = app.listen(0);
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    return await fetch(`http://127.0.0.1:${address.port}${path}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('system context routes expose system, project, and room overviews', async () => {
  const project = projectRepo.create({ name: 'Context Route Project', path: createProjectPath('project') });
  const room = roomRepo.create({ project_id: project.id, name: 'Context Route Room' });
  taskRepo.create({ project_id: project.id, room_id: room.id, title: 'Route task' });

  const systemRes = await request('/api/context/system');
  assert.equal(systemRes.status, 200);
  const system = await systemRes.json() as { source: string; counts: { projects: number } };
  assert.equal(system.source, 'openclaw.system_context.system_overview');
  assert.equal(system.counts.projects >= 1, true);

  const projectRes = await request(`/api/context/projects/${project.id}`);
  assert.equal(projectRes.status, 200);
  const projectBody = await projectRes.json() as { scope: { project_id: string }; counts: { tasks: number } };
  assert.equal(projectBody.scope.project_id, project.id);
  assert.equal(projectBody.counts.tasks, 1);

  const roomRes = await request(`/api/context/rooms/${room.id}`);
  assert.equal(roomRes.status, 200);
  const roomBody = await roomRes.json() as { scope: { room_id: string }; counts: { tasks: number; agents: number } };
  assert.equal(roomBody.scope.room_id, room.id);
  assert.equal(roomBody.counts.tasks, 1);
  assert.equal(roomBody.counts.agents, 1);
});

test('system context routes validate missing resources', async () => {
  const projectRes = await request('/api/context/projects/missing-project');
  assert.equal(projectRes.status, 404);
  assert.deepEqual(await projectRes.json(), { error: 'project not found' });

  const roomRes = await request('/api/context/rooms/missing-room');
  assert.equal(roomRes.status, 404);
  assert.deepEqual(await roomRes.json(), { error: 'room not found' });
});
