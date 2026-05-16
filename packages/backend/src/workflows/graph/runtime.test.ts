import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPENCLAW_ROOM_DB = join(mkdtempSync(join(tmpdir(), 'openclaw-room-graph-runtime-')), 'test.db');

const { projectRepo } = await import('../../repos/projects.js');
const { roomAgentRepo, roomRepo } = await import('../../repos/rooms.js');
const { taskRepo } = await import('../../repos/tasks.js');
const { workflowRepo } = await import('../../repos/workflows.js');
const { startGraphWorkflow } = await import('./runtime.js');

test('startGraphWorkflow runs context and planning nodes into awaiting approval', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Room' });
  roomAgentRepo.add({
    room_id: room.id,
    agent_id: 'planner',
    agent_name: 'Planner',
  });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Plan with graph',
    description: 'Use graph shell to produce a plan artifact.',
  });

  const run = await startGraphWorkflow(task.id, {
    planner: async () => ({
      goal: 'Plan with graph',
      summary: 'Graph shell planning',
      assumptions: [],
      tasks: [{
        title: 'Implement shell',
        description: 'Create context and planning nodes',
        suggestedRole: 'executor',
        priority: 'normal',
        acceptance: ['Plan is persisted'],
        scopeRead: [],
        scopeWrite: [],
        dependsOn: [],
      }],
      reviewFocus: [],
      verification: [],
      risks: [],
      needsApproval: true,
    }),
  });

  const detail = workflowRepo.detail(run.id);
  assert.equal(detail?.run.status, 'awaiting_approval');
  assert.equal(detail?.run.graph_version, 'phase-b-v1');
  assert.ok(detail?.run.graph_state);
  assert.ok(detail?.artifacts.some((artifact) => artifact.artifact_type === 'plan'));
  assert.ok(detail?.steps.some((step) => step.node_name === 'context'));
  assert.ok(detail?.steps.some((step) => step.node_name === 'planning'));
});

test('startGraphWorkflow blocks workflow and fails running graph step when planner fails', async () => {
  const projectPath = join(tmpdir(), `graph-runtime-failure-${Date.now()}`);
  mkdirSync(projectPath, { recursive: true });
  const project = projectRepo.create({ name: 'Graph Runtime Failure', path: projectPath });
  const room = roomRepo.create({ project_id: project.id, name: 'Graph Failure Room' });
  const task = taskRepo.create({
    room_id: room.id,
    project_id: project.id,
    title: 'Planner fails',
    description: 'Planner failure should not leave a running graph step.',
  });

  await assert.rejects(
    () => startGraphWorkflow(task.id, {
      planner: async () => {
        throw new Error('planner unavailable');
      },
    }),
    /planner unavailable/,
  );

  const run = workflowRepo.listByTask(task.id)[0];
  assert.equal(run?.status, 'blocked');
  assert.match(run?.error ?? '', /planner unavailable/);

  const detail = run ? workflowRepo.detail(run.id) : undefined;
  assert.ok(detail?.run.graph_state?.includes('"status":"blocked"'));
  assert.ok(detail?.run.graph_state?.includes('planner unavailable'));
  assert.equal(detail?.steps.some((step) => step.status === 'running'), false);
  assert.ok(detail?.steps.some((step) => step.node_name === 'planning' && step.status === 'failed'));
});
