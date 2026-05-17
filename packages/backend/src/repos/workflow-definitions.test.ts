import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-definitions-')), 'test.db');

const { projectRepo } = await import('./projects.js');
const { roomRepo } = await import('./rooms.js');
const { workflowDefinitionRepo } = await import('./workflow-definitions.js');

test('workflowDefinitionRepo creates built-in default definition once', () => {
  const first = workflowDefinitionRepo.ensureBuiltInDefinitions();
  const second = workflowDefinitionRepo.ensureBuiltInDefinitions();

  assert.equal(first.id, second.id);
  assert.equal(first.status, 'published');
  assert.equal(first.scope, 'system');
  assert.equal(first.builtin_key, 'default-langgraph');
  assert.ok(first.definition.nodes.some((node) => node.type === 'planning'));
});

test('workflowDefinitionRepo validates graph nodes and edges', () => {
  assert.throws(
    () => workflowDefinitionRepo.validateDefinition({
      nodes: [
        { id: 'start', type: 'planning', label: 'Planning' },
        { id: 'unsafe', type: 'shell' as never, label: 'Unsafe' },
      ],
      edges: [{ from: 'start', to: 'unsafe' }],
    }),
    /unsupported workflow node type/,
  );

  assert.throws(
    () => workflowDefinitionRepo.validateDefinition({
      nodes: [{ id: 'start', type: 'planning', label: 'Planning' }],
      edges: [{ from: 'start', to: 'missing' }],
    }),
    /unknown workflow edge target/,
  );

  assert.throws(
    () => workflowDefinitionRepo.validateDefinition({
      nodes: [
        { id: 'plan-a', type: 'planning', label: 'Planning A' },
        { id: 'plan-b', type: 'planning', label: 'Planning B' },
      ],
      edges: [{ from: 'plan-a', to: 'plan-b' }],
    }),
    /duplicate workflow node type/,
  );

  assert.throws(
    () => workflowDefinitionRepo.validateDefinition({
      nodes: [{ id: 'planning', type: 'planning', label: 'Planning' }],
      edges: [],
    }),
    /must include approval_gate node/,
  );
});

test('workflowDefinitionRepo lists room-visible definitions by scope', () => {
  const projectPath = mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-definition-project-'));
  const project = projectRepo.create({ name: 'Definition Project', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Definition Room' });
  const otherProject = projectRepo.create({
    name: 'Other Definition Project',
    path: mkdtempSync(join(tmpdir(), 'openclaw-room-workflow-definition-other-')),
  });

  const projectDefinition = workflowDefinitionRepo.createDraft({
    name: 'Project Workflow',
    description: null,
    scope: 'project',
    scope_id: project.id,
    definition: minimalDefinition('project-plan'),
  });
  workflowDefinitionRepo.publish(projectDefinition.id);

  const roomDefinition = workflowDefinitionRepo.createDraft({
    name: 'Room Workflow',
    description: null,
    scope: 'room',
    scope_id: room.id,
    definition: minimalDefinition('room-plan'),
  });
  workflowDefinitionRepo.publish(roomDefinition.id);

  const hiddenDefinition = workflowDefinitionRepo.createDraft({
    name: 'Hidden Workflow',
    description: null,
    scope: 'project',
    scope_id: otherProject.id,
    definition: minimalDefinition('hidden-plan'),
  });
  workflowDefinitionRepo.publish(hiddenDefinition.id);

  const visible = workflowDefinitionRepo.listVisibleForRoom(room.id);
  const visibleIds = new Set(visible.map((definition) => definition.id));

  assert.ok(visible.some((definition) => definition.builtin_key === 'default-langgraph'));
  assert.ok(visibleIds.has(projectDefinition.id));
  assert.ok(visibleIds.has(roomDefinition.id));
  assert.equal(visibleIds.has(hiddenDefinition.id), false);
});

function minimalDefinition(id: string) {
  return {
    nodes: [
      { id, type: 'planning' as const, label: 'Planning' },
      { id: `${id}-approval`, type: 'approval_gate' as const, label: 'Approval' },
      { id: `${id}-dispatch`, type: 'dispatch' as const, label: 'Dispatch' },
      { id: `${id}-execute`, type: 'execute' as const, label: 'Execute' },
      { id: `${id}-review`, type: 'review' as const, label: 'Review' },
      { id: `${id}-verify`, type: 'verify' as const, label: 'Verify' },
      { id: `${id}-acceptance`, type: 'acceptance' as const, label: 'Acceptance' },
      { id: `${id}-memory`, type: 'memory' as const, label: 'Memory' },
    ],
    edges: [
      { from: id, to: `${id}-approval` },
      { from: `${id}-approval`, to: `${id}-dispatch`, condition: 'approved' },
      { from: `${id}-dispatch`, to: `${id}-execute` },
      { from: `${id}-execute`, to: `${id}-review`, condition: 'review' },
      { from: `${id}-review`, to: `${id}-verify`, condition: 'pass' },
      { from: `${id}-verify`, to: `${id}-acceptance`, condition: 'acceptance' },
      { from: `${id}-acceptance`, to: `${id}-memory`, condition: 'completed' },
    ],
  };
}
