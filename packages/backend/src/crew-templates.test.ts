import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-crew-templates-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { agentRepo } = await import('./repos/agents.js');
const { roomAgentRepo } = await import('./repos/rooms.js');
const { router } = await import('./routes.js');
const express = (await import('express')).default;

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

test('crew template route lists the built-in room crews', async () => {
  const res = await request('/api/crew-templates');
  assert.equal(res.status, 200);
  const body = await res.json() as {
    templates: Array<{ id: string; agent_template_ids: string[]; default: boolean }>;
  };

  assert.deepEqual(
    body.templates.map((template) => template.id),
    ['discussion-only', 'light-implementation', 'fullstack-collaboration'],
  );
  assert.deepEqual(
    body.templates.find((template) => template.id === 'light-implementation')?.agent_template_ids,
    ['planner', 'backend-executor', 'reviewer'],
  );
  assert.equal(body.templates.find((template) => template.id === 'light-implementation')?.default, true);
});

test('room creation applies the selected crew template with executable workflow roles', async () => {
  const project = createProject('Crew Template Project');

  const res = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({
      name: 'Implementation Room',
      crew_template_id: 'light-implementation',
    }),
  });
  assert.equal(res.status, 201);
  const room = await res.json() as { id: string };
  const agents = roomAgentRepo.listByRoom(room.id);

  assert.deepEqual(agents.map((agent) => agent.agent_id), ['planner', 'backend-executor', 'reviewer']);
  assert.deepEqual(agents.map((agent) => agent.workflow_role), ['planner', 'executor', 'reviewer']);
  assert.equal(agents.every((agent) => agent.acp_enabled === 1 && agent.acp_backend === 'codex'), true);
  assert.equal(agents.every((agent) => agent.default_runtime === 'acp'), true);
});

test('room creation defaults to discussion-only for backward-compatible API calls', async () => {
  const project = createProject('Discussion Template Project');

  const res = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Discussion Room' }),
  });
  assert.equal(res.status, 201);
  const room = await res.json() as { id: string };
  const agents = roomAgentRepo.listByRoom(room.id);

  assert.deepEqual(agents.map((agent) => agent.agent_id), ['planner']);
  assert.deepEqual(agents.map((agent) => agent.workflow_role), ['planner']);
});

test('batch-adding built-in global agents preserves workflow metadata', async () => {
  const project = createProject('Batch Builtin Project');
  const roomRes = await request(`/api/projects/${project.id}/rooms`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Existing Room', crew_template_id: 'discussion-only' }),
  });
  assert.equal(roomRes.status, 201);
  const room = await roomRes.json() as { id: string };
  const backend = agentRepo.getByAgentId('backend-executor');
  assert.ok(backend);

  const addRes = await request(`/api/rooms/${room.id}/agents/batch`, {
    method: 'POST',
    body: JSON.stringify({ global_agent_ids: [backend.id] }),
  });
  assert.equal(addRes.status, 201);

  const executor = roomAgentRepo.listByRoom(room.id).find((agent) => agent.agent_id === 'backend-executor');
  assert.equal(executor?.workflow_role, 'executor');
  assert.deepEqual(executor?.capabilities, ['backend', 'testing']);
  assert.equal(executor?.default_runtime, 'acp');
});

function createProject(name: string) {
  const projectPath = join(tmpdir(), `${name.replace(/\W+/g, '-').toLowerCase()}-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  return projectRepo.create({ name, path: projectPath });
}
