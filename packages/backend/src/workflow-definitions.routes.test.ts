import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { WorkflowDefinitionGraph } from './types.js';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-definition-routes-')), 'test.db');

const { router } = await import('./routes.js');
const { projectRepo } = await import('./repos/projects.js');
const { roomRepo } = await import('./repos/rooms.js');
const { workflowDefinitionRepo } = await import('./repos/workflow-definitions.js');
const express = (await import('express')).default;

const app = express();
app.use(express.json());
app.use('/api', router);

const CUSTOM_WORKFLOW_GONE_MESSAGE = 'custom workflow definitions have been replaced by Superpowers-C';

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

test('workflow definition mutation routes return 410 Gone', async () => {
  const requests: Array<{ path: string; init: RequestInit }> = [
    {
      path: '/api/workflow-definitions',
      init: {
        method: 'POST',
        body: JSON.stringify({
          name: 'Room Workflow',
          scope: 'system',
          scope_id: 'default',
          definition: routeDefinition(),
        }),
      },
    },
    {
      path: '/api/workflow-definitions/legacy-definition/duplicate',
      init: { method: 'POST', body: JSON.stringify({ name: 'Copied Workflow' }) },
    },
    {
      path: '/api/workflow-definitions/legacy-definition',
      init: {
        method: 'PATCH',
        body: JSON.stringify({
          name: 'Renamed Workflow',
          scope: 'system',
          scope_id: 'default',
          definition: routeDefinition(),
        }),
      },
    },
    {
      path: '/api/workflow-definitions/legacy-definition/edit-draft',
      init: { method: 'POST' },
    },
    {
      path: '/api/workflow-definitions/legacy-definition/publish',
      init: { method: 'POST' },
    },
    {
      path: '/api/workflow-definitions/legacy-definition/archive',
      init: { method: 'POST' },
    },
    {
      path: '/api/workflow-definitions/legacy-definition',
      init: { method: 'DELETE' },
    },
  ];

  for (const item of requests) {
    const res = await request(item.path, item.init);
    assert.equal(res.status, 410);
    assert.deepEqual(await res.json(), { error: CUSTOM_WORKFLOW_GONE_MESSAGE });
  }
});

test('workflow definition routes expose only Superpowers for room selection', async () => {
  const project = projectRepo.create({
    name: 'Workflow Definition Routes',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-definition-routes-project-')),
  });
  const room = roomRepo.create({ project_id: project.id, name: 'Workflow Definition Routes Room' });
  const projectDefinition = workflowDefinitionRepo.publish(workflowDefinitionRepo.createDraft({
    name: 'Historical Project Workflow',
    description: null,
    scope: 'project',
    scope_id: project.id,
    definition: routeDefinition(),
  }).id)!;
  const roomDefinition = workflowDefinitionRepo.publish(workflowDefinitionRepo.createDraft({
    name: 'Historical Room Workflow',
    description: null,
    scope: 'room',
    scope_id: room.id,
    definition: routeDefinition(),
  }).id)!;

  assert.ok(projectDefinition.id);
  assert.ok(roomDefinition.id);
  const visibleRes = await request(`/api/rooms/${room.id}/workflow-definitions`);
  assert.equal(visibleRes.status, 200);
  const visible = await visibleRes.json() as Array<{ id: string; builtin_key: string | null }>;
  assert.deepEqual(visible.map((definition) => definition.builtin_key), ['superpowers-development']);

  const settingsSelectionRes = await request(`/api/workflow-definitions?roomId=${room.id}&includeArchived=1`);
  assert.equal(settingsSelectionRes.status, 200);
  const settingsSelection = await settingsSelectionRes.json() as Array<{ id: string; builtin_key: string | null }>;
  assert.deepEqual(settingsSelection.map((definition) => definition.builtin_key), ['superpowers-development']);
});

test('workflow definition routes return 410 before custom definition validation', async () => {
  const res = await request('/api/workflow-definitions', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Invalid Project Workflow',
      scope: 'project',
      scope_id: 'missing-project',
      definition: routeDefinition(),
    }),
  });

  assert.equal(res.status, 410);
  assert.deepEqual(await res.json(), { error: CUSTOM_WORKFLOW_GONE_MESSAGE });
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

  const includeArchivedSelectionRes = await request('/api/workflow-definitions?includeArchived=1');
  assert.equal(includeArchivedSelectionRes.status, 200);
  const includeArchivedSelectionDefinitions = await includeArchivedSelectionRes.json() as Array<{ builtin_key: string | null }>;
  assert.deepEqual(
    includeArchivedSelectionDefinitions.map((definition) => definition.builtin_key),
    ['superpowers-development'],
  );

  const archivedStatusRes = await request('/api/workflow-definitions?status=archived');
  assert.equal(archivedStatusRes.status, 200);
  const archivedStatusDefinitions = await archivedStatusRes.json() as Array<{ id: string; status: string }>;
  assert.ok(archivedStatusDefinitions.some((definition) => definition.id === archived.id));
  assert.equal(archivedStatusDefinitions.some((definition) => definition.id === systemDraft.id), false);

  const publishedSystemRes = await request('/api/workflow-definitions?scope=system&status=published');
  assert.equal(publishedSystemRes.status, 200);
  const publishedSystemDefinitions = await publishedSystemRes.json() as Array<{ builtin_key: string | null; scope: string; status: string }>;
  assert.ok(publishedSystemDefinitions.some((definition) => definition.builtin_key === 'superpowers-development'));

  const roomContextRes = await request(`/api/workflow-definitions?projectId=${project.id}&roomId=${room.id}`);
  assert.equal(roomContextRes.status, 200);
  const roomContextDefinitions = await roomContextRes.json() as Array<{ id: string; builtin_key: string | null }>;
  assert.deepEqual(roomContextDefinitions.map((definition) => definition.builtin_key), ['superpowers-development']);

  const historicalContextRes = await request(`/api/workflow-definitions?scope=project&projectId=${project.id}&roomId=${room.id}`);
  assert.equal(historicalContextRes.status, 200);
  const historicalContextDefinitions = await historicalContextRes.json() as Array<{ id: string }>;
  assert.ok(historicalContextDefinitions.some((definition) => definition.id === projectDraft.id));
  assert.equal(historicalContextDefinitions.some((definition) => definition.id === otherProjectDraft.id), false);
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
  return workflowDefinitionRepo.createDraft({
    ...input,
    description: null,
    definition: routeDefinition(),
  });
}

async function publishAndArchive(id: string): Promise<{ id: string; status: string }> {
  workflowDefinitionRepo.publish(id);
  return workflowDefinitionRepo.archive(id) as { id: string; status: string };
}

function routeDefinition(): WorkflowDefinitionGraph {
  return {
    nodes: [
      { id: 'context', type: 'context', label: 'Context' },
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
      { from: 'context', to: 'planning' },
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
