import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-definition-routes-')), 'test.db');

const { router } = await import('./routes.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
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

test('workflow definition routes create publish and list room-visible definitions', async () => {
  const project = projectRepo.create({
    name: 'Workflow Definition Routes',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-definition-routes-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Workflow Definition Routes Room' });

  const createRes = await request('/api/workflow-definitions', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Room Workflow',
      scope: 'room',
      scope_id: room.id,
      definition: routeDefinition(),
    }),
  });
  assert.equal(createRes.status, 201);
  const draft = await createRes.json() as { id: string; status: string };
  assert.equal(draft.status, 'draft');

  const publishRes = await request(`/api/workflow-definitions/${draft.id}/publish`, { method: 'POST' });
  assert.equal(publishRes.status, 200);
  const published = await publishRes.json() as { id: string; status: string };
  assert.equal(published.status, 'published');

  const visibleRes = await request(`/api/rooms/${room.id}/workflow-definitions`);
  assert.equal(visibleRes.status, 200);
  const visible = await visibleRes.json() as Array<{ id: string; builtin_key: string | null }>;
  assert.ok(visible.some((definition) => definition.builtin_key === 'default-langgraph'));
  assert.ok(visible.some((definition) => definition.id === draft.id));
});

test('workflow definition routes reject invalid scope targets', async () => {
  const res = await request('/api/workflow-definitions', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Invalid System Workflow',
      scope: 'system',
      scope_id: 'default',
      definition: routeDefinition(),
    }),
  });

  assert.equal(res.status, 400);
});

function routeDefinition() {
  return {
    nodes: [
      { id: 'planning', type: 'planning', label: 'Planning' },
      { id: 'approval', type: 'approval_gate', label: 'Approval' },
      { id: 'dispatch', type: 'dispatch', label: 'Dispatch' },
      { id: 'execute', type: 'execute', label: 'Execute' },
      { id: 'review', type: 'review', label: 'Review' },
      { id: 'verify', type: 'verify', label: 'Verify' },
      { id: 'acceptance', type: 'acceptance', label: 'Acceptance' },
      { id: 'memory', type: 'memory', label: 'Memory' },
    ],
    edges: [
      { from: 'planning', to: 'approval' },
      { from: 'approval', to: 'dispatch', condition: 'approved' },
      { from: 'dispatch', to: 'execute' },
      { from: 'execute', to: 'review', condition: 'review' },
      { from: 'review', to: 'verify', condition: 'pass' },
      { from: 'verify', to: 'acceptance', condition: 'acceptance' },
      { from: 'acceptance', to: 'memory', condition: 'completed' },
    ],
  };
}
