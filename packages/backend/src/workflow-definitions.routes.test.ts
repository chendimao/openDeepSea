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
      name: 'Invalid Project Workflow',
      scope: 'project',
      scope_id: 'missing-project',
      definition: routeDefinition(),
    }),
  });

  assert.equal(res.status, 400);
});

test('workflow definition routes duplicate edit draft archive and delete draft', async () => {
  const createRes = await request('/api/workflow-definitions', {
    method: 'POST',
    body: JSON.stringify({
      name: 'System Workflow',
      scope: 'system',
      scope_id: 'default',
      definition: routeDefinition(),
    }),
  });
  assert.equal(createRes.status, 201);
  const draft = await createRes.json() as { id: string; scope: string; scope_id: string };
  assert.equal(draft.scope, 'system');
  assert.equal(draft.scope_id, 'default');

  const publishRes = await request(`/api/workflow-definitions/${draft.id}/publish`, { method: 'POST' });
  assert.equal(publishRes.status, 200);
  const published = await publishRes.json() as { id: string; status: string };
  assert.equal(published.status, 'published');

  const editDraftRes = await request(`/api/workflow-definitions/${published.id}/edit-draft`, { method: 'POST' });
  assert.equal(editDraftRes.status, 201);
  const editDraft = await editDraftRes.json() as { id: string; status: string };
  assert.notEqual(editDraft.id, published.id);
  assert.equal(editDraft.status, 'draft');

  const duplicateRes = await request(`/api/workflow-definitions/${published.id}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Copied Workflow', scope: 'system', scope_id: 'default' }),
  });
  assert.equal(duplicateRes.status, 201);
  const duplicate = await duplicateRes.json() as {
    id: string;
    name: string;
    status: string;
    scope: string;
    scope_id: string;
  };
  assert.notEqual(duplicate.id, published.id);
  assert.equal(duplicate.name, 'Copied Workflow');
  assert.equal(duplicate.status, 'draft');
  assert.equal(duplicate.scope, 'system');
  assert.equal(duplicate.scope_id, 'default');

  const deleteRes = await request(`/api/workflow-definitions/${editDraft.id}`, { method: 'DELETE' });
  assert.equal(deleteRes.status, 204);

  const archiveRes = await request(`/api/workflow-definitions/${published.id}/archive`, { method: 'POST' });
  assert.equal(archiveRes.status, 200);
  const archived = await archiveRes.json() as { status: string };
  assert.equal(archived.status, 'archived');
});

test('workflow definition routes list filters by scope status archive flag and visibility context', async () => {
  const project = projectRepo.create({
    name: 'Workflow Filter Project',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-filter-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Workflow Filter Room' });
  const otherProject = projectRepo.create({
    name: 'Other Workflow Filter Project',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-filter-other-project-')),
  });

  const systemDraft = await createDefinition({
    name: 'Filter System Draft',
    scope: 'system',
    scope_id: 'default',
  });
  const projectDraft = await createDefinition({
    name: 'Filter Project Draft',
    scope: 'project',
    scope_id: project.id,
  });
  const roomDraft = await createDefinition({
    name: 'Filter Room Draft',
    scope: 'room',
    scope_id: room.id,
  });
  const otherProjectDraft = await createDefinition({
    name: 'Filter Other Project Draft',
    scope: 'project',
    scope_id: otherProject.id,
  });
  const archivedDraft = await createDefinition({
    name: 'Filter Archived',
    scope: 'system',
    scope_id: 'default',
  });
  const archived = await publishAndArchive(archivedDraft.id);

  const systemRes = await request('/api/workflow-definitions?scope=system');
  assert.equal(systemRes.status, 200);
  const systemDefinitions = await systemRes.json() as Array<{ id: string; scope: string; status: string }>;
  assert.ok(systemDefinitions.some((definition) => definition.id === systemDraft.id));
  assert.equal(systemDefinitions.some((definition) => definition.id === projectDraft.id), false);
  assert.equal(systemDefinitions.some((definition) => definition.id === archived.id), false);

  const archivedHiddenRes = await request('/api/workflow-definitions');
  assert.equal(archivedHiddenRes.status, 200);
  const archivedHiddenDefinitions = await archivedHiddenRes.json() as Array<{ id: string }>;
  assert.equal(archivedHiddenDefinitions.some((definition) => definition.id === archived.id), false);

  const includeArchivedRes = await request('/api/workflow-definitions?includeArchived=1');
  assert.equal(includeArchivedRes.status, 200);
  const includeArchivedDefinitions = await includeArchivedRes.json() as Array<{ id: string }>;
  assert.ok(includeArchivedDefinitions.some((definition) => definition.id === archived.id));

  const archivedStatusRes = await request('/api/workflow-definitions?status=archived');
  assert.equal(archivedStatusRes.status, 200);
  const archivedStatusDefinitions = await archivedStatusRes.json() as Array<{ id: string; status: string }>;
  assert.ok(archivedStatusDefinitions.some((definition) => definition.id === archived.id));
  assert.equal(archivedStatusDefinitions.some((definition) => definition.id === systemDraft.id), false);

  const roomContextRes = await request(`/api/workflow-definitions?projectId=${project.id}&roomId=${room.id}`);
  assert.equal(roomContextRes.status, 200);
  const roomContextDefinitions = await roomContextRes.json() as Array<{ id: string }>;
  assert.ok(roomContextDefinitions.some((definition) => definition.id === systemDraft.id));
  assert.ok(roomContextDefinitions.some((definition) => definition.id === projectDraft.id));
  assert.ok(roomContextDefinitions.some((definition) => definition.id === roomDraft.id));
  assert.equal(roomContextDefinitions.some((definition) => definition.id === otherProjectDraft.id), false);
});

test('workflow definition routes validate list filter query values and references', async () => {
  const project = projectRepo.create({
    name: 'Workflow Query Validation Project',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-query-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Workflow Query Validation Room' });
  const otherProject = projectRepo.create({
    name: 'Other Workflow Query Validation Project',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-query-other-project-')),
  });

  const invalidScopeRes = await request('/api/workflow-definitions?scope=invalid');
  assert.equal(invalidScopeRes.status, 400);

  const invalidIncludeArchivedRes = await request('/api/workflow-definitions?includeArchived=true');
  assert.equal(invalidIncludeArchivedRes.status, 400);

  const missingProjectRes = await request('/api/workflow-definitions?projectId=missing-project');
  assert.equal(missingProjectRes.status, 404);

  const missingRoomRes = await request('/api/workflow-definitions?roomId=missing-room');
  assert.equal(missingRoomRes.status, 404);

  const mismatchedContextRes = await request(`/api/workflow-definitions?projectId=${otherProject.id}&roomId=${room.id}`);
  assert.equal(mismatchedContextRes.status, 400);
});

async function createDefinition(input: {
  name: string;
  scope: 'system' | 'project' | 'room';
  scope_id: string;
}): Promise<{ id: string; name: string; status: string; scope: string; scope_id: string }> {
  const res = await request('/api/workflow-definitions', {
    method: 'POST',
    body: JSON.stringify({
      ...input,
      definition: routeDefinition(),
    }),
  });
  assert.equal(res.status, 201);
  return await res.json() as { id: string; name: string; status: string; scope: string; scope_id: string };
}

async function publishAndArchive(id: string): Promise<{ id: string; status: string }> {
  const publishRes = await request(`/api/workflow-definitions/${id}/publish`, { method: 'POST' });
  assert.equal(publishRes.status, 200);

  const archiveRes = await request(`/api/workflow-definitions/${id}/archive`, { method: 'POST' });
  assert.equal(archiveRes.status, 200);
  return await archiveRes.json() as { id: string; status: string };
}

function routeDefinition() {
  return {
    nodes: [
      { id: 'planning', type: 'planning', label: 'Planning' },
      { id: 'approval', type: 'approval_gate', label: 'Approval' },
      { id: 'dispatch', type: 'dispatch', label: 'Dispatch' },
      { id: 'execute', type: 'execute', label: 'Execute' },
      { id: 'review', type: 'review', label: 'Review' },
      { id: 'repair', type: 'repair_decision', label: 'Repair' },
      { id: 'verify', type: 'verify', label: 'Verify' },
      { id: 'acceptance', type: 'acceptance', label: 'Acceptance' },
      { id: 'memory', type: 'memory', label: 'Memory' },
    ],
    edges: [
      { from: 'planning', to: 'approval' },
      { from: 'approval', to: 'dispatch', condition: 'approved' },
      { from: 'dispatch', to: 'execute' },
      { from: 'execute', to: 'execute', condition: 'has_runnable_child' },
      { from: 'execute', to: 'review', condition: 'review' },
      { from: 'review', to: 'repair', condition: 'changes_requested' },
      { from: 'review', to: 'verify', condition: 'pass' },
      { from: 'repair', to: 'execute', condition: 'execute' },
      { from: 'verify', to: 'acceptance', condition: 'acceptance' },
      { from: 'acceptance', to: 'memory', condition: 'completed' },
    ],
  };
}
