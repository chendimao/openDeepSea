import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBuiltInAgentTemplates } from './agent-templates.js';
import type { WorkflowRole } from './types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-agent-templates-')), 'test.db');

const { projectRepo } = await import('./repos/projects.js');
const { roomAgentRepo } = await import('./repos/rooms.js');
const { roomRepo } = await import('./repos/rooms.js');
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

test('built-in agent templates include required ACP-only workflow roles', () => {
  const templates = listBuiltInAgentTemplates();
  const roles = new Set(templates.map((template) => template.workflow_role));

  for (const role of ['planner', 'executor', 'reviewer', 'acceptor'] satisfies WorkflowRole[]) {
    assert.equal(roles.has(role), true);
  }

  for (const template of templates) {
    assert.equal(template.acp_enabled, true);
    assert.equal(template.acp_backend, 'codex');
  }
});

test('agent template routes list and create ACP-only room agents', async () => {
  const projectPath = join(tmpdir(), `openclaw-room-template-project-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({
    name: 'Template API Project',
    path: projectPath,
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Template Room' });

  const listRes = await request('/api/agent-templates');
  assert.equal(listRes.status, 200);
  const listed = await listRes.json() as { templates: Array<{ id: string }> };
  assert.ok(listed.templates.some((template) => template.id === 'backend-executor'));

  const createRes = await request(`/api/rooms/${room.id}/agents/from-template`, {
    method: 'POST',
    body: JSON.stringify({ template_id: 'backend-executor' }),
  });
  assert.equal(createRes.status, 201);
  const agent = await createRes.json() as {
    agent_id: string;
    workflow_role: string;
    acp_enabled: 0 | 1;
    acp_backend: string;
    default_runtime: string;
    capabilities: string[];
  };
  assert.equal(agent.agent_id, 'backend-executor');
  assert.equal(agent.workflow_role, 'executor');
  assert.equal(agent.acp_enabled, 1);
  assert.equal(agent.acp_backend, 'codex');
  assert.equal(agent.default_runtime, 'acp');
  assert.deepEqual(agent.capabilities, ['backend', 'testing']);

  const duplicateRes = await request(`/api/rooms/${room.id}/agents/from-template`, {
    method: 'POST',
    body: JSON.stringify({ template_id: 'backend-executor' }),
  });
  assert.equal(duplicateRes.status, 201);
  const duplicate = await duplicateRes.json() as { agent_id: string };
  assert.equal(duplicate.agent_id, 'backend-executor');
});

test('agent template route rejects unknown templates and mirrors missing room errors', async () => {
  const invalidTemplateRes = await request('/api/rooms/room-1/agents/from-template', {
    method: 'POST',
    body: JSON.stringify({ template_id: 'missing-template' }),
  });
  assert.equal(invalidTemplateRes.status, 404);

  const missingRoomRes = await request('/api/rooms/missing-room/agents/from-template', {
    method: 'POST',
    body: JSON.stringify({ template_id: 'planner' }),
  });
  assert.equal(missingRoomRes.status, 400);
});

test('manual room agents default to no runtime', () => {
  const projectPath = join(tmpdir(), `openclaw-room-manual-agent-project-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({
    name: 'Manual Agent Project',
    path: projectPath,
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Manual Agent Room' });

  const agent = roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'manual',
    agent_name: 'Manual',
  });

  assert.equal(agent.default_runtime, 'none');
});
